// Card identification: two-channel recall + ORB geometric verification.
//
// 1. Recall, unioned from two sources that fail on DIFFERENT photos:
//      · a 64-bit dHash of the rectified crop swept against every printing's
//        stored hash — 110k popcounts, well under a millisecond — RECALL_K deep.
//      · the HEAD of a BoVW visual-word list, BOVW_HEAD_K deep.
// 2. Verify: for each candidate, match ORB descriptors to the query and fit a
//    RANSAC homography; the inlier count is decisive (only the true card
//    produces many geometrically-consistent matches). Rank by inliers.
//
// The split is 250 hash / 10 BoVW, and both numbers are measured rather than
// guessed. Ablated over 100 MTG cards on one sample (exact printing / right
// card / latency):
//
//   hash 250 + BoVW  10   91.0%  98.0%   772 ms   <- this
//   hash  60 + BoVW 250   91.0%  98.0%  1328 ms   <- the old split
//   hash 250 + BoVW   0   82.0%  90.0%   700 ms
//   hash   0 + BoVW 250   84.0%  93.0%  1360 ms
//
// Neither channel alone reaches the pair: blur moves the local descriptors BoVW
// quantizes while barely touching a brightness-gradient hash, and framing moves
// the hash while leaving descriptors alone. BoVW earns its place in its first ten
// results — its recall@1 is 48% against the hash's 32% — and nothing after that,
// which is why it gets ten and the hash gets the rest of the verify budget.
// Cutting BoVW entirely was tried and cost 9 points of exact printing here, plus
// 8 of 65 real phone captures whose true printing sat at BoVW rank ~213.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const bovwMatch = require('./bovwMatch');
const setIndex = require('./setIndex');
const { parseSetList } = require('./utils/setQuery');
const languages = require('./utils/languages');
const gpaths = require('./utils/globalIndexPaths');

// Depth of the perceptual-hash channel — the bulk of the verify budget, and what
// the client's Scan Detail slider scales. Measured on 65 real captures, the true
// printing's hash rank was inside 60 in 42 cases and inside 250 in 45: the deeper
// list is the tail, and the tail is where a blurred capture lands.
const RECALL_K = 250;
// Depth of the BoVW channel. Ten, not 250: its rank profile is 48% @1, 75% @10,
// 86% @60, 89% @250 — so nearly everything it contributes it contributes
// immediately, and the 240 candidates after the tenth were costing ~550 ms per
// scan for a fraction of a point.
const BOVW_HEAD_K = 10;
const REF_WIDTH = 500;     // must match build-card-orb.mjs
const DESC_BYTES = 32;
const RATIO = 0.75;        // Lowe ratio test
const RANSAC_PX = 5.0;

// Printing disambiguation.
//
// This was written for CLIP recall, whose index held one row per ARTWORK — so it
// could only ever propose the printing Scryfall picked, and scanning a reprint
// gave the right card with the wrong set/number. Expanding a recall hit into its
// other printings and letting inliers choose was the workaround.
//
// Hash recall indexes every printing directly, so the case this repairs mostly
// does not arise any more. It is kept because it still helps where recall ranks a
// sibling printing above the true one, and it stays bounded and off by default:
// only the top EXPAND_TOP recall candidates are expanded, and no more than
// EXPAND_MAX extra printings are verified in total. Turn on with
// GLOBAL_PRINTING_EXPANSION=1 and measure with scripts/eval-global-index.mjs,
// which reports accuracy AND latency.
// Math.max(1, parseInt('typo')) is NaN, and `budget <= 0` is false for NaN — so a
// mistyped env var would remove the bound entirely rather than fall back to it.
function posInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
// A partial index — one built from a filtered set selection rather than the whole
// catalogue — cannot answer "I don't know". Recall always returns its nearest
// neighbours, so a card from an excluded set comes back as the closest artwork the
// table happens to hold, and ORB then verifies it weakly. Presented plainly that
// is a confident wrong answer, which is worse for the user than a miss: they file
// the card under the wrong name and never find out.
//
// So when the index is partial AND verification is weak, say so. This is the
// decision, kept pure and separate for test/outofscope.test.js.
const OUT_OF_SCOPE_INLIERS = 12;   // matches the client's auto-fill confidence gate

function outOfScopeNotice(scope, topInliers) {
  // A complete index has nothing to disclaim: a weak match there is a genuine miss.
  if (!scope || !scope.excluded || scope.excluded <= 0) return null;
  if (topInliers >= OUT_OF_SCOPE_INLIERS) return null;
  return {
    covered: scope.covered || 0,
    catalogue: scope.catalogue || 0,
    excluded: scope.excluded,
    filter: scope.filter || null,
  };
}

const EXPAND_PRINTINGS = process.env.GLOBAL_PRINTING_EXPANSION === '1';
const EXPAND_TOP = posInt(process.env.GLOBAL_PRINTING_EXPANSION_TOP, 20);
const EXPAND_MAX = posInt(process.env.GLOBAL_PRINTING_EXPANSION_MAX, 120);

// The detector itself lives in shared/cardDetect.mjs so the browser can run the
// IDENTICAL algorithm — the live overlay has to show what this code sees, and a
// second implementation would drift. cv is injected because the two environments
// load different OpenCV builds.
//
// require() of an ESM module is stable on the Node this ships with, so there is
// no build step and no duplicated source.
const { createDetector } = require('../../shared/cardDetectPure.mjs');
const { detectCard } = createDetector();

// Produce the card image to match on: auto-crop + deskew to the detected card
// outline (works on light and dark backgrounds via dual-polarity thresholding),
// else fall back to matching the frame as sent.
async function preprocessCard(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer).resize({ width: 1200, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const card = detectCard(new Uint8ClampedArray(data), info.width, info.height);
    if (card) {
      const out = await sharp(card.data, { raw: { width: card.width, height: card.height, channels: 4 } }).png().toBuffer();
      await dumpDebug(imageBuffer, out, card);
      return out;
    }
    await dumpDebug(imageBuffer, null, null);
  } catch (e) {
    console.warn('preprocessCard failed:', e.message);
  }
  return await sharp(imageBuffer).png().toBuffer();
}

// Create data/scan-debug/ and each scan writes its original frame and rectified
// crop there, with the quad and the segmentation that won. Delete the directory
// to turn it off. A bad crop is otherwise invisible from the outside: recall
// returns unrelated cards and nothing in the logs says the geometry was wrong.
//
// Gated on the directory rather than an env var deliberately — an env var has to
// survive however the server was launched, and dotenv resolves .env against the
// working directory, which is not necessarily backend/.
const DEBUG_DIR = path.join(gpaths.DATA_DIR, 'scan-debug');

async function dumpDebug(original, cropped, card) {
  if (!fs.existsSync(DEBUG_DIR)) return;
  try {
    const dir = DEBUG_DIR;
    const stamp = `${Date.now()}`;
    await sharp(original).jpeg({ quality: 85 }).toFile(path.join(dir, `${stamp}-frame.jpg`));
    if (cropped) await sharp(cropped).jpeg({ quality: 90 }).toFile(path.join(dir, `${stamp}-crop.jpg`));
    fs.writeFileSync(path.join(dir, `${stamp}-detect.json`),
      JSON.stringify(card ? { quad: card.quad, pick: card.pick } : { detected: false }, null, 2));
    console.log(`scanMatch: debug dump ${stamp} (${card ? `${card.pick.source} score=${card.pick.score} fill=${card.pick.fill} par=${card.pick.par} ar=${card.pick.ar}` : 'NO CARD DETECTED — matching the raw frame'})`);
  } catch (e) {
    console.warn(`scanMatch: debug dump failed: ${e.message}`);
  }
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
  // The dHash recall channel — now the ONLY one. Two typed arrays plus the row
  // list the meta already holds — ~900 KB for MTG — so it costs nothing next to
  // the index itself. Absent on rollups built before orbUnion carried the hash
  // columns; such a rollup has no recall at all, so match() reports it as unbuilt
  // rather than returning an empty candidate list with no explanation.
  let hashes = null;
  if (meta.cards.length && meta.cards[0].length >= 7) {
    const hi = new Uint32Array(meta.cards.length);
    const lo = new Uint32Array(meta.cards.length);
    for (let i = 0; i < meta.cards.length; i++) {
      hi[i] = meta.cards[i][5] >>> 0;
      lo[i] = meta.cards[i][6] >>> 0;
    }
    hashes = { hi, lo, rows: meta.cards };
  }

  // `scope` says which sets this rollup covers — null on a full build, present
  // with excluded > 0 on a partial one. It rides along on the meta we are already
  // parsing, so the out-of-scope notice costs no extra file read.
  orbDbs[k] = {
    map, byName, hashes, scope: meta.scope || null,
    descFd: fs.openSync(descPath, 'r'), kpFd: fs.openSync(kpPath, 'r'),
  };
  console.log(
    `scanMatch: loaded ${gpaths.tag(game, lang)} ORB DB (${meta.cards.length} cards` +
    `${hashes ? '' : ', NO dHash channel — rollup predates it, refresh to enable'}` +
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

// Hamming distance between two 64-bit dHashes, held as 32-bit halves.
function popcount32(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
}

// Recall: the nearest cards by perceptual hash.
//
// A dHash is a downscaled brightness-gradient comparison, which blur barely
// touches — that is why it outlasted the visual-word channel it used to share
// this job with. Its weakness is the opposite one: it is sensitive to how the
// crop is framed, so a skewed or loose crop moves it a long way down the list.
// That makes detectCard's quality the thing recall depends on most.
//
// A full scan of 110k rows is ~110k popcount pairs, well under a millisecond,
// so this is free next to the ORB verification it feeds.
function hashRecall(db, qHash, topK) {
  // topK <= 0 is not just an empty result: the loop below splices a candidate in,
  // pops it straight back out, and then reads best[best.length - 1] on an empty
  // array. Guard it here rather than in the loop — nothing reached it while the
  // depth came from Math.min(HASH_RECALL_K, recallK), but the slider's recallK
  // now feeds this directly, so a future profile could.
  if (!db || !db.hashes || !qHash || topK <= 0) return [];
  const { hi, lo, rows } = db.hashes;
  const best = [];   // ascending by distance, length <= topK
  let worst = 65;
  for (let i = 0; i < hi.length; i++) {
    const d = popcount32((qHash.hi ^ hi[i]) >>> 0) + popcount32((qHash.lo ^ lo[i]) >>> 0);
    if (best.length < topK || d < worst) {
      let pos = 0;
      while (pos < best.length && best[pos].d <= d) pos++;
      best.splice(pos, 0, { d, i });
      if (best.length > topK) best.pop();
      worst = best[best.length - 1].d;
    }
  }
  return best.map(({ d, i }) => ({
    name: rows[i][0], set: rows[i][1], number: rows[i][2],
    // Map distance onto a descending score. Only ever a tie-break: inliers
    // decide, and this is reported to the client alongside them.
    score: (64 - d) / 64,
  }));
}

const STRONG_INLIERS = 25; // enough to stop trying the other game

// Score one game: recall + ORB verify against the shared query features.
// Async because verification is fanned out to the worker pool.
async function verifyGame(game, q, bf, recall, topK, lang = 'en') {
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
        // Inherit the recall score: these were never ranked by recall, so this
        // only acts as the tie-break when two printings match equally on ORB.
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
  // SCAN_RANK_LOG=1: measure where the ORB winner sat in the recall list.
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
  // Indexes are per game AND per language, all the way down: the per-set walk
  // asks each provider for the requested language, so a Japanese rollup holds
  // Japanese art. Nothing here falls back to English — an English vector cannot
  // answer a Japanese scan (different name box, different flavour text), so a
  // language with no rollup built says `englishOnly` rather than returning
  // confident lookalikes.
  const lang = languages.toCode(opts.lang);
  // Scan-detail knobs (client "Scan Detail" slider). Fewer recall candidates to
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
    // Recall is built if EITHER channel can answer. The hash rides on the ORB
    // rollup's own meta, so a rollup written before those columns existed loads
    // with hashes === null; BoVW is a separate file that may or may not be there.
    // Requiring both would report a working scanner as unbuilt, and requiring
    // neither would return an empty candidate list with no explanation.
    const recallIsBuilt = (g, l) => !!(loadOrbDb(g, l) || {}).hashes || bovwMatch.isBuilt(g, l);

    // Only try alternative game if auto-detect is explicitly enabled or requested
    const order = (opts.autoDetect && lang === 'en')
      ? (requestedGame === 'pokemon' ? ['pokemon', 'mtg'] : ['mtg', 'pokemon'])
      : [requestedGame];

    const usable = order.filter(g => recallIsBuilt(g, lang));
    if (!usable.length) {
      // Distinguish "you never built this language" from "nothing is built at
      // all" — they need different actions from the user.
      const englishOnly = lang !== 'en' && recallIsBuilt(requestedGame, 'en');
      return { game: requestedGame, verified: false, candidates: [], crop, lang, englishOnly, notBuilt: !englishOnly };
    }

    // One perceptual hash of the query, shared by every game's hash channel.
    const qHash = await setIndex.dhash(cardBuf);

    let best = null;
    for (const g of usable) {
      // Union the two channels, hash first so it wins ties on ordering. BoVW
      // reuses the ORB descriptors already extracted for verification, so its
      // sweep needs no second look at the image; the hash sweep is a popcount
      // over one array. Verification is what decides between them — it is
      // reliable where recall is not, scoring 31-66 inliers on captures recall
      // had ranked in the hundreds.
      const qDesc = new Uint8Array(q.desc.data.subarray(0, q.desc.rows * DESC_BYTES));
      const recall = [];
      const seenRecall = new Set();
      for (const list of [
        hashRecall(loadOrbDb(g, lang), qHash, recallK),
        bovwMatch.match(qDesc, g, Math.min(BOVW_HEAD_K, recallK), lang, q.desc.rows),
      ]) {
        for (const item of list) {
          const kk = key(item.set, item.number);
          if (seenRecall.has(kk)) continue;
          seenRecall.add(kk);
          recall.push(item);
        }
      }
      if (recall.length === 0) continue;
      const r = await verifyGame(g, q, bf, recall, topK, lang);
      // Only switch away from requestedGame if the other game has high confidence and beats requested
      if (!best) {
        best = { ...r, game: g };
      } else if (r.top >= 16 && r.top > best.top + 5) {
        best = { ...r, game: g };
      }
      if (best.top >= STRONG_INLIERS) break; // confident — no need to try the other game
    }
    if (!best) return { game: requestedGame, verified: false, candidates: [], crop, lang };
    // If the winning game's index only covers part of the catalogue and the match
    // is weak, tell the caller so it can say "outside your indexed range" instead
    // of presenting the nearest indexed artwork as the answer.
    const outOfScope = outOfScopeNotice((loadOrbDb(best.game, lang) || {}).scope, best.top);
    return {
      game: best.game, verified: best.verified, candidates: best.candidates, crop, lang,
      ...(outOfScope ? { outOfScope } : {}),
    };
  } finally {
    q.desc.delete(); bf.delete(); orb.delete();
  }
}

// Evict a cached ORB DB (closing its file descriptors) so the next match reloads
// from disk. Called before a global rebuild swaps in fresh files — on Windows the
// rename fails outright while a handle is still open. Omitting `lang` evicts
// every language of that game.
function reload(game, lang) {
  bovwMatch.reload(game, lang);
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
  // scripts/eval-global-index.mjs measures the ORB query stage on its own.
  _queryOrbForTest: queryOrb,
  // ...and the recall stage on its own, so a recall miss stays distinguishable
  // from a verify miss. They need completely different fixes.
  _hashRecallForTest: hashRecall,
  // test/printingexpansion.test.js reaches the private ORB-index loader and the
  // expansion bounds; both are module-private on purpose.
  _loadOrbDbForTest: loadOrbDb,
  _expansionConfigForTest: () => ({ enabled: EXPAND_PRINTINGS, top: EXPAND_TOP, max: EXPAND_MAX }),
  // test/outofscope.test.js: whether a partial index admits it might not cover the
  // scanned card is a correctness decision, not a cosmetic one.
  _outOfScopeNoticeForTest: outOfScopeNotice,
  _outOfScopeInliersForTest: OUT_OF_SCOPE_INLIERS,
};
