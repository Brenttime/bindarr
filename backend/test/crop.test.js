// Crop/deskew quality gate for scanMatch.detectCard.
//
// Composites real card art onto a synthetic "photo" with known corners (rotation,
// perspective, scale, background, and the clutter a real photo has — a hand, a
// neighbouring card, glare) and scores the rectified output against the original
// art by dHash Hamming distance. That is the same recall signal the scanner uses,
// so a lower number here is literally a better scan.
//
// It exists because every crop failure was SILENT: a bad crop still returns an
// image and still produces candidates, just wrong ones. Measured regressions this
// pins down, all of which shipped unnoticed:
//   - cv.boxPoints does not exist in opencv-wasm, so the bounding-box fallback
//     threw and aborted detection entirely (fell back to the uncropped photo)
//   - the area floor was 0.15 while its own comment claimed 0.04, so any card not
//     filling 15% of the frame was never detected
//   - an unvalidated hull quad was PREFERRED over the sane bounding box, which
//     sheared crops whenever the card merged with a hand or a neighbour
//   - with the wrong OTSU polarity the background becomes the blob, and a 3:4
//     frame passes the card-aspect gate — cropping the whole photo
// Baseline when written: mean 16.71, 96/120 detected, 31/120 bad.
// After the fixes:      mean  4.15, 120/120 detected,  4/120 bad (glare only,
//                       where the crop is right to ~1-20px and the glare itself
//                       is what moves the hash).
// Needs network on first run (fetches four card images, then caches them).
// Run: `node test/crop.test.js`   Diagnose: `WHY=1 node test/crop.test.js`
const assert = require('assert');
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `bench-${process.pid}.db`);
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const scanMatch = require('../src/scanMatch');
const setIndex = require('../src/setIndex');

const CARD_W = 500, CARD_H = 700;
const CACHE = path.join(__dirname, '..', '.bench-cache');

const SOURCES = [
  ['mtg-bolt', 'https://cards.scryfall.io/normal/front/8/9/89ea9a01-a4e9-43c5-bdd7-3a0e4dcec0f3.jpg'],
  ['mtg-sol', 'https://cards.scryfall.io/normal/front/7/6/7673784e-db4b-43a1-8d55-1bb9fc1e284f.jpg'],
  ['pkmn-ja-004', 'https://assets.tcgdex.net/ja/SV/SV2a/004/high.png'],
  ['pkmn-ja-006', 'https://assets.tcgdex.net/ja/SV/SV2a/006/high.png'],
];

async function fetchCard(name, url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${name}.png`);
  if (!fs.existsSync(f)) {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'bindarr-bench/1.0' } });
    await sharp(Buffer.from(r.data)).resize(CARD_W, CARD_H, { fit: 'fill' }).png().toFile(f);
  }
  return f;
}

// Place the card into a WxH scene at the given quad. Returns raw RGBA.
async function compose(cardFile, sceneW, sceneH, quad, bgGray) {
  const { data } = await sharp(cardFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cardMat = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: CARD_W, height: CARD_H });
  // Background with mild gradient + noise so OTSU has something realistic to bite.
  const scene = new cv.Mat(sceneH, sceneW, cv.CV_8UC4);
  for (let y = 0; y < sceneH; y++) {
    for (let x = 0; x < sceneW; x++) {
      const i = (y * sceneW + x) * 4;
      const v = Math.max(0, Math.min(255, bgGray + Math.round((x / sceneW) * 18 - 9) + (Math.floor(x * 7 + y * 13) % 7) - 3));
      scene.data[i] = v; scene.data[i + 1] = v; scene.data[i + 2] = v; scene.data[i + 3] = 255;
    }
  }
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  cv.warpPerspective(cardMat, scene, M, new cv.Size(sceneW, sceneH), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT);
  const out = { data: Buffer.from(scene.data), width: sceneW, height: sceneH };
  cardMat.delete(); scene.delete(); srcTri.delete(); dstTri.delete(); M.delete();
  return out;
}

// Rotate + perspective-skew a centered card rect inside the scene.
function makeQuad(sceneW, sceneH, { scale = 0.55, deg = 0, tilt = 0, shift = [0, 0] } = {}) {
  const h = sceneH * scale, w = h * (CARD_W / CARD_H);
  const cx = sceneW / 2 + shift[0], cy = sceneH / 2 + shift[1];
  const rad = (deg * Math.PI) / 180;
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return corners.map(([x, y], i) => {
    // tilt narrows the top edge (a card leaning back) — real handheld perspective
    const t = i === 0 || i === 1 ? tilt : 0;
    const nx = x * (1 - t);
    const [rx, ry] = [nx * Math.cos(rad) - y * Math.sin(rad), nx * Math.sin(rad) + y * Math.cos(rad)];
    return [cx + rx, cy + ry];
  });
}

const popcount = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); x = (x + (x >>> 4)) & 0x0f0f0f0f; return (x * 0x01010101) >>> 24; };
const hamming = (a, b) => popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);

// Extra scene furniture: a second card intruding at the edge (a stack/binder),
// a hand-like dark blob, glare. These are what a real photo has and a clean
// synthetic scene does not — and they are where a detector picks the wrong quad.
function addClutter(scene, kind) {
  const { width: w, height: h } = scene;
  const px = (x, y, v) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    scene.data[i] = v; scene.data[i + 1] = v; scene.data[i + 2] = v;
  };
  if (kind === 'neighbour') {
    // A second card-ish rectangle sliding in from the right edge.
    for (let y = Math.round(h * 0.2); y < Math.round(h * 0.85); y++) {
      for (let x = Math.round(w * 0.86); x < w; x++) px(x, y, 90);
    }
  } else if (kind === 'hand') {
    // Dark rounded blob over the bottom-left corner, like fingers holding it.
    const cx = w * 0.28, cy = h * 0.92, rx = w * 0.3, ry = h * 0.14;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) px(x, y, 55);
    }
  } else if (kind === 'glare') {
    const cx = w * 0.6, cy = h * 0.4, r = Math.min(w, h) * 0.18;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) px(x, y, 250);
    }
  }
}

const CASES = [
  ['flat', { deg: 0, tilt: 0 }],
  ['rot 4deg', { deg: 4, tilt: 0 }],
  ['rot 10deg', { deg: 10, tilt: 0 }],
  ['rot 20deg', { deg: 20, tilt: 0 }],
  ['rot -35deg', { deg: -35, tilt: 0 }],
  ['tilt 0.12', { deg: 0, tilt: 0.12 }],
  ['tilt 0.22', { deg: 2, tilt: 0.22 }],
  ['rot+tilt', { deg: 8, tilt: 0.16 }],
  ['small', { deg: 3, tilt: 0.05, scale: 0.34 }],
  ['tiny', { deg: 2, tilt: 0.04, scale: 0.24 }],
  ['offcenter', { deg: 6, tilt: 0.1, shift: [130, -90] }],
  ['neighbour card', { deg: 5, tilt: 0.08, clutter: 'neighbour' }],
  ['hand holding', { deg: 4, tilt: 0.1, clutter: 'hand' }],
  ['glare', { deg: 3, tilt: 0.08, clutter: 'glare' }],
  ['low contrast bg', { deg: 6, tilt: 0.1, bgOverride: 105 }],
];

async function main() {
  const files = [];
  for (const [n, u] of SOURCES) files.push([n, await fetchCard(n, u)]);

  const rows = [];
  for (const [name, file] of files) {
    const ref = await setIndex.dhash(await sharp(file).png().toBuffer());
    for (const [label, opts] of CASES) {
      for (const [bgName, bg] of [['light', 225], ['dark', 40]]) {
        const trueQuad = makeQuad(1200, 1600, opts);
        const scene = await compose(file, 1200, 1600, trueQuad, opts.bgOverride ?? bg);
        if (opts.clutter) addClutter(scene, opts.clutter);
        const got = scanMatch.detectCard(new Uint8ClampedArray(scene.data), scene.width, scene.height);
        if (process.env.WHY && got) {
          const err = got.quad.reduce((s, p, i) => s + Math.hypot(p.x - trueQuad[i][0], p.y - trueQuad[i][1]), 0) / 4;
          console.log(`  WHY ${name} ${label}/${bgName}: cornerErr=${err.toFixed(0)}px pick=${JSON.stringify(got.pick)}`);
        }
        let dist = 64, detected = false;
        if (got) {
          detected = true;
          const png = await sharp(got.data, { raw: { width: got.width, height: got.height, channels: 4 } }).png().toBuffer();
          dist = hamming(ref, await setIndex.dhash(png));
          if (process.env.DUMP) {
            fs.mkdirSync(path.join(CACHE, 'out'), { recursive: true });
            fs.writeFileSync(path.join(CACHE, 'out', `${name}-${label.replace(/[^a-z0-9]/gi, '_')}-${bgName}.png`), png);
          }
        }
        rows.push({ card: name, case: label, bg: bgName, detected, dist });
      }
    }
  }

  const byCase = new Map();
  for (const r of rows) {
    const k = `${r.case}|${r.bg}`;
    if (!byCase.has(k)) byCase.set(k, []);
    byCase.get(k).push(r);
  }
  console.log('case               bg      detected  meanHamming  (lower=better, <=8 good, >=16 bad)');
  for (const [k, rs] of byCase) {
    const [c, bg] = k.split('|');
    const det = rs.filter(r => r.detected).length;
    const mean = (rs.reduce((s, r) => s + r.dist, 0) / rs.length).toFixed(1);
    console.log(`${c.padEnd(18)} ${bg.padEnd(7)} ${String(det + '/' + rs.length).padEnd(9)} ${mean}`);
  }
  const all = rows.reduce((s, r) => s + r.dist, 0) / rows.length;
  const bad = rows.filter(r => r.dist >= 16).length;
  const detected = rows.filter(r => r.detected).length;
  console.log(`\nOVERALL mean=${all.toFixed(2)}  detected=${detected}/${rows.length}  badCrops(>=16)=${bad}/${rows.length}`);

  // Thresholds sit a little looser than the measured result so the gate catches
  // real regressions without tripping on antialiasing noise between platforms.
  assert.strictEqual(detected, rows.length, 'every staged card must be detected — a miss means matching the uncropped photo');
  assert.ok(all <= 7, `mean crop distance ${all.toFixed(2)} regressed (expected <= 7, was 4.15 when written)`);
  assert.ok(bad <= 8, `${bad} badly-cropped cases (expected <= 8; only the 4 glare cases should qualify)`);

  // The glare cases are the known-acceptable ones: the crop is accurate and the
  // glare itself moves the hash. Everything else must be a clean crop.
  const nonGlareBad = rows.filter(r => r.dist >= 16 && r.case !== 'glare');
  assert.deepStrictEqual(nonGlareBad.map(r => `${r.card}/${r.case}/${r.bg}`), [], 'non-glare cases must crop cleanly');

  console.log('crop.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
