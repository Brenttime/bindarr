// ORB verification against the GLOBAL index, runnable inside a worker thread.
//
// Set-scoped verification has been fanned out across scanPool for a while
// (setIndex.matchSet), but the global path — the slower one, verifying up to
// RECALL_K=250 candidates instead of ~200 — was still doing all of it inline on
// the main event loop. Same work, worse execution strategy. This module is what
// the pool workers call so both paths get the same treatment.
//
// It deliberately holds no index map. The main thread already loaded the offset
// map for recall keying, so it resolves each candidate to byte ranges and passes
// those over; a worker only ever opens the two .bin files. Four workers each
// building their own 110k-entry Map would cost hundreds of MB to duplicate
// information the main thread already has.
const fs = require('fs');
const { cv } = require('opencv-wasm');

const DESC_BYTES = 32;
const RATIO = 0.75;      // Lowe ratio test — must match scanMatch/setIndex
const RANSAC_PX = 5.0;

// Cache descriptors per file path: a worker verifies many candidates from the
// same two files, and reopening them per candidate would dominate the cost.
const handles = new Map(); // path -> fd

function fdFor(p) {
  let fd = handles.get(p);
  if (fd === undefined) { fd = fs.openSync(p, 'r'); handles.set(p, fd); }
  return fd;
}

// Inlier count between the query features and one stored card's features.
// Mirrors setIndex.inliers — same ratio test, same RANSAC threshold — so a
// pooled result is identical to the inline one, not merely similar.
function inlierCount(bf, qMat, qKp, refDesc, refKp, count) {
  if (count < 4 || qMat.rows < 4) return 0;
  const cand = new cv.Mat(count, DESC_BYTES, cv.CV_8U);
  cand.data.set(refDesc.subarray(0, count * DESC_BYTES));
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(qMat, cand, knn, 2);
  const src = [], dst = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i);
    if (m.size() >= 2) {
      const a = m.get(0), b = m.get(1);
      if (a.distance < RATIO * b.distance) {
        src.push(qKp[a.queryIdx * 2], qKp[a.queryIdx * 2 + 1]);
        dst.push(refKp[a.trainIdx * 2], refKp[a.trainIdx * 2 + 1]);
      }
    }
    m.delete(); // embind wrapper; leaks the wasm heap if not freed
  }
  knn.delete(); cand.delete();
  const good = src.length / 2;
  if (good < 4) return 0;
  const sM = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const dM = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const H = cv.findHomography(sM, dM, cv.RANSAC, RANSAC_PX, mask);
  const inl = H.empty() ? 0 : cv.countNonZero(mask);
  sM.delete(); dM.delete(); mask.delete(); H.delete();
  return inl;
}

// Score a batch of candidates. Each slice is
// { name, set, number, score, faces: [{ offset, count }] } — one face for most
// cards, several for a double-faced one, whose best face wins.
// Returns [{ name, set, number, score, inliers }].
function verifySlices(descPath, kpPath, qDesc, qRows, qKp, slices) {
  const descFd = fdFor(descPath);
  const kpFd = fdFor(kpPath);
  const qMat = new cv.Mat(qRows, DESC_BYTES, cv.CV_8U);
  qMat.data.set(qDesc);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const out = [];
  try {
    for (const s of slices) {
      let inliers = 0;
      for (const face of s.faces) {
        if (!face.count) continue;
        const dBuf = Buffer.alloc(face.count * DESC_BYTES);
        const kBuf = Buffer.alloc(face.count * 2 * 4);
        fs.readSync(descFd, dBuf, 0, dBuf.length, face.offset * DESC_BYTES);
        fs.readSync(kpFd, kBuf, 0, kBuf.length, face.offset * 2 * 4);
        const refKp = new Float32Array(kBuf.buffer, kBuf.byteOffset, face.count * 2);
        const inl = inlierCount(bf, qMat, qKp, dBuf, refKp, face.count);
        if (inl > inliers) inliers = inl;
      }
      out.push({ name: s.name, set: s.set, number: s.number, score: s.score, inliers });
    }
  } finally {
    bf.delete(); qMat.delete();
  }
  return out;
}

// Close cached descriptors so a rebuild can rename the files underneath us
// (Windows refuses to rename a file with an open handle).
function closeAll() {
  for (const fd of handles.values()) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  handles.clear();
}

module.exports = { verifySlices, closeAll, inlierCount };
