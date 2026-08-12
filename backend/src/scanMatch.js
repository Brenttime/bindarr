// Hybrid card identification: CLIP embedding recall + ORB geometric verification.
//
// 1. Recall: embedMatch (CLIP) returns the top-RECALL_K visually-nearest cards.
// 2. Verify: for each, match ORB descriptors to the query and fit a RANSAC
//    homography; the inlier count is decisive (only the true card produces many
//    geometrically-consistent matches). Rank by inliers.
//
// Falls back to CLIP-only ranking if the ORB DB for a game isn't built yet.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const embedMatch = require('./embedMatch');
const setIndex = require('./setIndex');
const { parseSetList } = require('./utils/setQuery');
const languages = require('./utils/languages');
const gpaths = require('./utils/globalIndexPaths');

const DATA_DIR = process.env.INDEX_DATA_DIR || path.join(__dirname, '..', 'data');
const RECALL_K = 250;      // CLIP candidates to geometrically verify
const REF_WIDTH = 500;     // must match build-card-orb.mjs
const DESC_BYTES = 32;
const RATIO = 0.75;        // Lowe ratio test
const RANSAC_PX = 5.0;
const CARD_ASPECT = 2.5 / 3.5;
const WARP_W = 500, WARP_H = Math.round(500 / CARD_ASPECT); // rectified card size

// Printing disambiguation.
//
// The CLIP index is built from Scryfall's `unique_artwork` — one printing per
// artwork — so recall can only ever propose the printing Scryfall picked. Scan a
// reprint and you get the right card with the wrong set/number. The ORB index,
// being the union of every per-set index, DOES contain all printings, so once
// recall names a card we can verify each of its printings and let inliers pick the
// real one (set symbol, frame and holo pattern differ between them).
//
// This is the one change here that trades scan latency for accuracy, so it is
// bounded and off by default: only the top EXPAND_TOP recall candidates are
// expanded, and no more than EXPAND_MAX extra printings are verified in total.
// Turn on with GLOBAL_PRINTING_EXPANSION=1 and measure with
// scripts/eval-global-index.mjs, which reports accuracy AND latency.
// Math.max(1, parseInt('typo')) is NaN, and `budget <= 0` is false for NaN — so a
// mistyped env var would remove the bound entirely rather than fall back to it.
function posInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
const EXPAND_PRINTINGS = process.env.GLOBAL_PRINTING_EXPANSION === '1';
const EXPAND_TOP = posInt(process.env.GLOBAL_PRINTING_EXPANSION_TOP, 20);
const EXPAND_MAX = posInt(process.env.GLOBAL_PRINTING_EXPANSION_MAX, 120);

// Order 4 quad points as [tl, tr, br, bl].
//
// The sum/diff trick is exact for an axis-aligned-ish quad but degenerates near
// 45°, where one point can win two slots and leave another unused — that feeds
// warpPerspective a collapsed quad and produces the badly sheared crops. So the
// result is checked for duplicates and falls back to ordering by angle around the
// centroid, which is rotation-proof.
function orderQuad(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const guess = [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // tl, tr, br, bl
  if (new Set(guess).size === 4) return guess;

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // Clockwise from the top-left-most quadrant so the order still reads tl,tr,br,bl.
  const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  const start = byAngle.reduce((bi, p, i) => (p.x + p.y < byAngle[bi].x + byAngle[bi].y ? i : bi), 0);
  return [0, 1, 2, 3].map(i => byAngle[(start + i) % 4]);
}

// Geometry of an ordered quad, or null if it is too small to judge. Used to throw
// out candidates that are not plausibly a card seen at an angle.
function quadMetrics(pts) {
  const [tl, tr, br, bl] = orderQuad(pts);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = d(tl, tr), bottom = d(bl, br), left = d(tl, bl), right = d(tr, br);
  if (Math.min(top, bottom, left, right) < 20) return null;
  const w = (top + bottom) / 2, h = (left + right) / 2;
  // How much the opposite sides agree. A real card (even in perspective) keeps
  // this high; a blob merging the card with a hand or a neighbouring card does not.
  const parallelism = (Math.min(top, bottom) / Math.max(top, bottom)) * (Math.min(left, right) / Math.max(left, right));
  return { corners: [tl, tr, br, bl], w, h, ar: w / h, parallelism };
}

// Is this quad plausibly a portrait card?
//
// Portrait is required rather than rotated into place: the scanner's guide box is
// portrait and every indexed reference image is portrait upright, so a landscape
// quad means the detector merged the card with something else. Rotating it would
// be a coin flip on which way is up, and dHash recall is rotation-sensitive — so a
// landscape candidate is rejected instead of guessed at.
function isCardQuad(m) {
  return !!m && m.ar <= 0.95 && m.ar >= 0.5 && m.parallelism >= 0.6;
}

// Locate the card and return a rectified raw-RGBA image, or null if no card-like
// region is found. Two strategies, tried in order:
//   1. A clean 4-point convex quad -> perspective-warp flat (handles tilt/skew).
//   2. Else the largest card-aspect region's bounding box -> plain crop (slinger
//      cards sit flat and upright, so a crop is enough and works when the card is
//      small/far where a crisp quad isn't found).
// Both prefer the region nearest the frame center (the card the user aimed at).
// The area floor is low (4%) so distant cards are still detected instead of
// falling back to a background-dominated center crop.
// Finds the 4 true perspective corners of a card contour by dynamically stepping
// epsilon on its convex hull to simplify rounded corners into exactly 4 primary vertices.
function findCardQuad(c) {
  const hull = new cv.Mat();
  cv.convexHull(c, hull);
  const peri = cv.arcLength(hull, true);
  let quad = null;

  for (let epsScale = 0.015; epsScale <= 0.12; epsScale += 0.005) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, epsScale * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      quad = Array.from({ length: 4 }, (_, j) => ({
        x: approx.data32S[j * 2],
        y: approx.data32S[j * 2 + 1]
      }));
      approx.delete();
      break;
    }
    approx.delete();
  }
  hull.delete();
  return quad;
}

// Every way we know of turning a photo into "regions that might be a card".
// One segmentation is not enough in practice:
//   - OTSU (both polarities) is the cheapest and wins on a plain table, but it
//     merges the card with anything of similar brightness touching it — a hand, a
//     neighbouring card in the binder — and then the region's outline is not the
//     card's outline, which is what produced skewed crops.
//   - Canny keys on the card's BORDER instead of its brightness, so it survives a
//     hand, glare, and a background whose tone is close to the card's.
// Candidates from all of them compete on the same score, so adding a strategy can
// only help: a wrong region still has to beat a right one on card-likeness.
function segmentations(blur, w, h) {
  const closeK = Math.max(15, Math.round(Math.min(w, h) * 0.035));
  const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeK, closeK));
  const masks = [];

  for (const polarity of [cv.THRESH_BINARY_INV, cv.THRESH_BINARY]) {
    const thresh = new cv.Mat(), closed = new cv.Mat();
    cv.threshold(blur, thresh, 0, 255, polarity | cv.THRESH_OTSU);
    cv.morphologyEx(thresh, closed, cv.MORPH_CLOSE, kClose);
    thresh.delete();
    masks.push(closed);
  }

  // Edge pass: Canny, then a light dilate to close the small gaps a card border
  // picks up over busy art, then close to fill it into a solid region. The kernel
  // is deliberately much smaller than the OTSU one — a big kernel is exactly what
  // bridges the card to a hand resting against it.
  const edges = new cv.Mat(), dil = new cv.Mat(), filled = new cv.Mat();
  const kEdge = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const kFill = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(Math.min(w, h) * 0.01)), Math.max(5, Math.round(Math.min(w, h) * 0.01))));
  cv.Canny(blur, edges, 50, 150);
  cv.dilate(edges, dil, kEdge);
  cv.morphologyEx(dil, filled, cv.MORPH_CLOSE, kFill);
  edges.delete(); dil.delete(); kEdge.delete(); kFill.delete();
  masks.push(filled);

  kClose.delete();
  return masks;
}

// Card must cover at least this fraction of the frame. Low on purpose: a card held
// back from the camera is small, and rejecting it means matching the whole photo —
// background included — which is far worse than a slightly loose crop. (The old
// floor was 0.15 while the comment above claimed 0.04; 4% is the intent.)
const MIN_AREA_FRAC = 0.04;
// Upper cap earns its keep: with the wrong OTSU polarity the BACKGROUND becomes
// the blob, and "the whole frame" has whatever aspect the sensor has — 3:4 sails
// through the card-aspect gate, scores enormously on area, and crops the entire
// photo. Keep this comfortably below 1.
const MAX_AREA_FRAC = 0.85;

function detectCard(rgbaData, w, h) {
  const src = cv.matFromImageData({ data: rgbaData, width: w, height: h });
  const gray = new cv.Mat(), blur = new cv.Mat();
  let out = null;
  let masks = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const imgArea = w * h, cx = w / 2, cy = h / 2, halfDiag = Math.hypot(w, h) / 2;
    let best = null; // { score, pts }

    // Freed in the finally below, not inline: an exception between here and there
    // would otherwise strand three full-frame Mats on the wasm heap, which never
    // shrinks — the failure mode that used to kill scanning after ~67 cards.
    masks = segmentations(blur, w, h);
    const MASK_NAMES = ['otsu-inv', 'otsu', 'canny'];
    for (let mi = 0; mi < masks.length; mi++) {
      const mask = masks[mi];
      const maskName = MASK_NAMES[mi] || `mask${mi}`;
      const contours = new cv.MatVector(), hier = new cv.Mat();
      try {
        cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const area = cv.contourArea(c);
          if (area >= MIN_AREA_FRAC * imgArea && area <= MAX_AREA_FRAC * imgArea) {
            const rect = cv.minAreaRect(c);
            let rw = rect.size.width;
            let rh = rect.size.height;
            if (rw > rh) { const tmp = rw; rw = rh; rh = tmp; } // ensure portrait
            const ar = rw / rh; // ideal card aspect = 0.714

            if (ar >= 0.55 && ar <= 0.88) {
              const rcx = rect.center.x, rcy = rect.center.y;
              const centrality = 1 - Math.min(1, Math.hypot(rcx - cx, rcy - cy) / halfDiag);
              const aspectFit = 1 - Math.min(1, Math.abs(ar - CARD_ASPECT) / 0.15);

              // opencv-wasm calls this rotatedRectPoints and returns the points
              // directly. It has NO cv.boxPoints — the old code called that in its
              // fallback branch, so any contour without a clean hull quad threw
              // TypeError, aborted the whole detection (no catch inside), and the
              // scan silently fell back to matching the uncropped photo.
              const boxPts = cv.rotatedRectPoints(rect).map(p => ({ x: p.x, y: p.y }));

              // The hull quad follows real perspective, so it beats the bounding
              // box when it is trustworthy — but only then. An unvalidated quad was
              // preferred outright (1.2x), which is how a hand-merged blob's
              // garbage quad won over its own sane bounding box and sheared the crop.
              const hullQuad = findCardQuad(c);
              const hullMetrics = hullQuad && quadMetrics(hullQuad);
              const rectArea = rect.size.width * rect.size.height;
              const hullOk = isCardQuad(hullMetrics)
                // A trustworthy quad also has to explain the region it came from:
                // a sliver cutting across the blob does not.
                && hullMetrics.w * hullMetrics.h >= 0.7 * rectArea;

              const candidates = [];
              if (hullOk) candidates.push({ pts: hullMetrics.corners, bonus: 1.2, par: hullMetrics.parallelism, m: hullMetrics });
              const boxMetrics = quadMetrics(boxPts);
              if (isCardQuad(boxMetrics)) candidates.push({ pts: boxMetrics.corners, bonus: 1.0, par: boxMetrics.parallelism, m: boxMetrics });

              for (const cand of candidates) {
                // Belt to the area cap's braces: a quad that spans essentially the
                // whole frame is the background, not a card. Cropping to it is a
                // no-op that still runs the image through a perspective warp.
                if (cand.m.w >= 0.95 * w && cand.m.h >= 0.95 * h) continue;
                // How much of the quad the region actually fills. A card fills its
                // own outline almost completely; a region that merged the card with
                // a hand or a neighbouring card is L-shaped, so the quad drawn
                // around it is mostly empty.
                const fill = Math.min(1, area / Math.max(1, cand.m.w * cand.m.h));
                const score = (area / imgArea) * (aspectFit * aspectFit) * (0.4 + 0.6 * centrality) * cand.bonus * (0.5 + 0.5 * cand.par) * fill;
                if (!best || score > best.score) best = { score, pts: cand.pts, source: maskName, fill, par: cand.par, ar };
              }
            }
          }
          c.delete();
        }
      } finally { contours.delete(); hier.delete(); }
    }

    if (best && best.pts) {
      const [tl, tr, brc, bl] = orderQuad(best.pts);
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, brc.x, brc.y, bl.x, bl.y]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));
      // `quad`/`pick` are diagnostics only (preprocessCard ignores them); they make
      // a bad crop debuggable — which segmentation won, and where it thought the
      // card was — instead of guessable.
      out = {
        data: Buffer.from(warped.data), width: WARP_W, height: WARP_H, channels: 4,
        quad: [tl, tr, brc, bl].map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        pick: { source: best.source, score: +best.score.toFixed(4), fill: +best.fill.toFixed(2), par: +best.par.toFixed(2), ar: +best.ar.toFixed(3) },
      };
      srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
    }
  } finally {
    for (const m of masks) { try { m.delete(); } catch { /* already freed */ } }
    src.delete(); gray.delete(); blur.delete();
  }
  return out;
}

// Produce the card image to match on: auto-crop + deskew to the detected card
// outline (works on light and dark backgrounds via dual-polarity thresholding),
// else fall back to the client's framed guide-box capture.
async function preprocessCard(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer).resize({ width: 1200, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const card = detectCard(new Uint8ClampedArray(data), info.width, info.height);
    if (card) {
      return await sharp(card.data, { raw: { width: card.width, height: card.height, channels: 4 } }).png().toBuffer();
    }
  } catch (e) {
    console.warn('preprocessCard failed:', e.message);
  }
  return await sharp(imageBuffer).png().toBuffer();
}

const orbDbs = {};         // "game|lang" -> { map: Map(key->[{name,offset,count}]), descFd, kpFd } | null

function key(set, number) { return `${set}|${number}`; }

// Load a game+language ORB index (offsets in RAM; descriptors/keypoints read
// from disk per candidate, so DB size does not affect per-scan cost). Returns
// null if not built.
function loadOrbDb(game, lang = 'en') {
  const k = gpaths.key(game, lang);
  if (k in orbDbs) return orbDbs[k];
  const { desc: descPath, kp: kpPath, meta: metaPath } = gpaths.orb(game, lang);
  if (!fs.existsSync(descPath) || !fs.existsSync(kpPath) || !fs.existsSync(metaPath)) { orbDbs[k] = null; return null; }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const map = new Map();
  // A double-faced card has multiple rows under one set|number (one per face).
  // Store them as a list so verify can test each face and keep the best.
  for (const c of meta.cards) {
    const kk = key(c[1], c[2]);
    const face = { name: c[0], offset: c[3], count: c[4] };
    const arr = map.get(kk);
    if (arr) arr.push(face); else map.set(kk, [face]);
  }
  // name -> every printing of it, for printing disambiguation. Built only when
  // that is switched on: it is another Map over every row, and paying for it by
  // default would be pure overhead for a feature nobody asked to run.
  let byName = null;
  if (EXPAND_PRINTINGS) {
    byName = new Map();
    const dedupe = new Set();
    for (const c of meta.cards) {
      const kk = key(c[1], c[2]);
      // A DFC contributes one row per face; one entry per printing is enough.
      if (dedupe.has(`${c[0]}|${kk}`)) continue;
      dedupe.add(`${c[0]}|${kk}`);
      const entry = { set: c[1], number: c[2], k: kk };
      const arr = byName.get(c[0]);
      if (arr) arr.push(entry); else byName.set(c[0], [entry]);
    }
  }
  orbDbs[k] = { map, byName, descFd: fs.openSync(descPath, 'r'), kpFd: fs.openSync(kpPath, 'r') };
  console.log(
    `scanMatch: loaded ${gpaths.tag(game, lang)} ORB DB (${meta.cards.length} cards` +
    `${byName ? `, ${byName.size} distinct names, printing expansion ON` : ''})`
  );
  return orbDbs[k];
}

// Read one card's stored descriptors (cv.Mat CV_8U) + keypoints (Float32Array xy).
function readOrb(db, offset, count) {
  const descBuf = Buffer.alloc(count * DESC_BYTES);
  fs.readSync(db.descFd, descBuf, 0, descBuf.length, offset * DESC_BYTES);
  const kpBuf = Buffer.alloc(count * 2 * 4);
  fs.readSync(db.kpFd, kpBuf, 0, kpBuf.length, offset * 2 * 4);
  const desc = new cv.Mat(count, DESC_BYTES, cv.CV_8U);
  desc.data.set(descBuf); // faster than matFromArray(Array.from(buf)); same bytes
  const kp = new Float32Array(kpBuf.buffer, kpBuf.byteOffset, count * 2);
  return { desc, kp };
}

// Query ORB features from an image buffer (grayscale, resized like the build).
async function queryOrb(orb, imageBuffer) {
  const { data, info } = await sharp(imageBuffer).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const kp = new Float32Array(kpv.size() * 2);
  for (let i = 0; i < kpv.size(); i++) { const p = kpv.get(i).pt; kp[i * 2] = p.x; kp[i * 2 + 1] = p.y; }
  rgba.delete(); gray.delete(); kpv.delete();
  return { desc, kp }; // caller deletes desc
}

// RANSAC-homography inlier count between query and a candidate's ORB features.
function inlierCount(bf, qDesc, qKp, cand) {
  if (cand.count < 4 || qDesc.rows < 4) return 0;
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(qDesc, cand.desc, knn, 2);
  const src = [], dst = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i);
    if (m.size() >= 2) {
      const m0 = m.get(0), m1 = m.get(1);
      if (m0.distance < RATIO * m1.distance) {
        src.push(qKp[m0.queryIdx * 2], qKp[m0.queryIdx * 2 + 1]);
        dst.push(cand.kp[m0.trainIdx * 2], cand.kp[m0.trainIdx * 2 + 1]);
      }
    }
    m.delete(); // embind DMatchVector wrapper; leaks the wasm heap if not freed
  }
  knn.delete();
  const good = src.length / 2;
  if (good < 4) return 0;
  const srcM = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const dstM = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const H = cv.findHomography(srcM, dstM, cv.RANSAC, RANSAC_PX, mask);
  const inl = H.empty() ? 0 : cv.countNonZero(mask);
  srcM.delete(); dstM.delete(); mask.delete(); H.delete();
  return inl;
}

const STRONG_INLIERS = 25; // enough to stop trying the other game

// Score one game: CLIP recall + ORB verify against the shared query features.
// Async because verification is fanned out to the worker pool.
async function verifyGame(cardBuf, game, q, bf, recall, topK, lang = 'en') {
  const db = loadOrbDb(game, lang);
  if (!db) return { verified: false, candidates: recall.slice(0, topK), top: 0 };

  // The candidate list to verify: every recall hit, plus (optionally) the other
  // printings of the strongest few.
  const targets = [];
  const seen = new Set(); // recall may list both faces of a DFC; verify each card once
  const push = (name, set, number, score) => {
    const k = key(set, number);
    if (seen.has(k)) return;
    seen.add(k);
    targets.push({ name, set, number, score, k });
  };
  for (const cand of recall) push(cand.name, cand.set, cand.number, cand.score);

  if (EXPAND_PRINTINGS && db.byName) {
    let budget = EXPAND_MAX;
    for (const cand of recall.slice(0, EXPAND_TOP)) {
      if (budget <= 0) break;
      for (const other of db.byName.get(cand.name) || []) {
        if (budget <= 0) break;
        if (seen.has(other.k)) continue;
        // Inherit the CLIP score: these were never ranked by CLIP, so this only
        // acts as the tie-break when two printings match equally well on ORB.
        push(cand.name, other.set, other.number, cand.score);
        budget--;
      }
    }
  }

  // Resolve every candidate to byte ranges here, on the main thread, which
  // already holds the offset map. The pool then needs only the two file paths.
  const slices = targets.map(c => ({
    name: c.name, set: c.set, number: c.number, score: c.score,
    faces: (db.map.get(c.k) || []).map(f => ({ offset: f.offset, count: f.count })),
  }));

  let scored = null;
  // Fan out like setIndex.matchSet does. Falls back to inline on any pool
  // problem, so a worker failure degrades to slower rather than to broken.
  try {
    const paths = gpaths.orb(game, lang);
    const qDesc = new Uint8Array(q.desc.data.subarray(0, q.desc.rows * DESC_BYTES));
    scored = await require('./scanPool').verifyGlobal(paths.desc, paths.kp, qDesc, q.desc.rows, q.kp, slices);
  } catch (e) {
    console.warn(`scanMatch: pool verify failed, running inline: ${e.message}`);
  }

  if (!scored) {
    scored = [];
    for (const cand of slices) {
      let inliers = 0;
      for (const face of cand.faces) {
        const ref = readOrb(db, face.offset, face.count);
        const inl = inlierCount(bf, q.desc, q.kp, ref);
        ref.desc.delete();
        if (inl > inliers) inliers = inl; // best-matching face wins
      }
      scored.push({ name: cand.name, set: cand.set, number: cand.number, score: cand.score, inliers });
    }
  }
  scored.sort((a, b) => (b.inliers - a.inliers) || (b.score - a.score));
  const top = scored[0];
  // SCAN_RANK_LOG=1: measure where the ORB winner sat in the CLIP recall list.
  // 0-indexed rank; if these stay well below K, RECALL_K can be lowered losslessly.
  // Appended to a file (flushed) instead of stdout, which block-buffers through pipes.
  if (process.env.SCAN_RANK_LOG && top && top.inliers > 0) {
    const rank = recall.findIndex(r => r.set === top.set && r.number === top.number);
    fs.appendFileSync(path.join(__dirname, '..', 'scan-rank.log'),
      `game=${game} K=${recall.length} winnerClipRank=${rank} inliers=${top.inliers} name=${top.name}\n`);
  }
  return { verified: true, candidates: scored.slice(0, topK), top: top ? top.inliers : 0 };
}

// Identify a card image. Auto-detects the game: verifies the requested game
// first and, if the match is weak, also tries the other game and keeps whichever
// scores higher — so scanning in the wrong mode still works. Returns
// { game, verified, candidates:[{name,set,number,score,inliers}], crop }.
async function match(imageBuffer, requestedGame, topK = 8, setCode = '', opts = {}) {
  // The global CLIP + ORB indexes are built from English art only (building one
  // is hours and ~1GB per game; doing that per language is not a trade worth
  // making). A non-English scan is therefore set-scoped or nothing — and it says
  // so via `englishOnly` rather than silently returning English lookalikes.
  const lang = languages.toCode(opts.lang);
  // Scan-detail knobs (client "Scan Detail" slider). Fewer CLIP candidates to
  // verify + fewer ORB features = faster, less accurate. Clamped to sane bounds.
  const recallK = Math.max(10, Math.min(RECALL_K, opts.recallK || RECALL_K));
  const orbN = Math.max(150, Math.min(800, opts.orb || 500));
  // Auto-crop + deskew the card once; everything matches on the rectified image.
  const cardBuf = await preprocessCard(imageBuffer);
  const crop = 'data:image/jpeg;base64,' + (await sharp(cardBuf).resize({ width: 220 }).jpeg({ quality: 70 }).toBuffer()).toString('base64');

  // Query ORB features are game-independent — extract once, reuse everywhere.
  const orb = new cv.ORB(orbN);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const q = await queryOrb(orb, cardBuf);
  try {
    // Set-scoped fast path: if the user gave set code(s) and their index is
    // built, match only within them (~300 cards each) — accurate, no global
    // recall. Multiple sets ("ltr,ltc") match each ready set and merge by inliers.
    const readySets = parseSetList(setCode).filter(s => setIndex.isReady(requestedGame, s, lang));
    if (readySets.length) {
      const qHash = await setIndex.dhash(cardBuf); // cheap recall pre-filter within the set
      const perSet = await Promise.all(readySets.map(s => setIndex.matchSet(q, requestedGame, s, topK, qHash, lang)));
      const merged = perSet.filter(Boolean).flat().sort((a, b) => b.inliers - a.inliers).slice(0, topK);
      if (merged.length) return { game: requestedGame, verified: true, candidates: merged, crop, scoped: true, lang };
    }

    // A global index is per-language: card images differ by language (different
    // name box, different flavour text), so an English index cannot answer a
    // Japanese scan. Use this language's index when it has been built, and only
    // fall back to explaining why when it has not.
    //
    // Game auto-detection is English-only: trying both games needs both games'
    // indexes for that language, and for anything but English that is far more
    // likely to mean "neither is built" than a genuine ambiguity.
    const order = lang !== 'en'
      ? [requestedGame]
      : (requestedGame === 'pokemon' ? ['pokemon', 'mtg'] : ['mtg', 'pokemon']);
    const usable = order.filter(g => embedMatch.isBuilt(g, lang));
    if (!usable.length) {
      // Distinguish "you never built this language" from "nothing is built at
      // all" — they need different actions from the user.
      const englishOnly = lang !== 'en' && embedMatch.isBuilt(requestedGame, 'en');
      return { game: requestedGame, verified: false, candidates: [], crop, lang, englishOnly, notBuilt: !englishOnly };
    }

    let best = null;
    for (const g of usable) {
      const recall = await embedMatch.match(cardBuf, g, recallK, lang); // CLIP recall
      if (recall.length === 0) continue;
      const r = await verifyGame(cardBuf, g, q, bf, recall, topK, lang);
      if (!best || r.top > best.top) best = { ...r, game: g };
      if (best.top >= STRONG_INLIERS) break; // confident — no need to try the other game
    }
    if (!best) return { game: requestedGame, verified: false, candidates: [], crop, lang };
    return { game: best.game, verified: best.verified, candidates: best.candidates, crop, lang };
  } finally {
    q.desc.delete(); bf.delete(); orb.delete();
  }
}

// Evict a cached ORB DB (closing its file descriptors) so the next match reloads
// from disk. Called before a global rebuild swaps in fresh files — on Windows the
// rename fails outright while a handle is still open. Omitting `lang` evicts
// every language of that game.
function reload(game, lang) {
  const drop = (k) => {
    const db = orbDbs[k];
    if (db) { try { fs.closeSync(db.descFd); fs.closeSync(db.kpFd); } catch { /* already closed */ } }
    delete orbDbs[k];
  };
  if (lang === undefined) {
    for (const k of Object.keys(orbDbs)) if (k.startsWith(`${game}|`)) drop(k);
    return;
  }
  drop(gpaths.key(game, lang));
}

module.exports = {
  match, reload, preprocessCard, detectCard,
  // test/printingexpansion.test.js reaches the private ORB-index loader and the
  // expansion bounds; both are module-private on purpose.
  _loadOrbDbForTest: loadOrbDb,
  _expansionConfigForTest: () => ({ enabled: EXPAND_PRINTINGS, top: EXPAND_TOP, max: EXPAND_MAX }),
};
