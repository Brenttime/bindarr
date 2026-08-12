// Global ORB verification runs in worker threads (globalVerify.js via scanPool),
// mirroring what set-scoped verification has always done. Pooling is only
// acceptable if it is LOSSLESS: the same candidates must produce the same inlier
// counts as running inline, or scan results would quietly depend on how many
// cores the machine has.
//
// So this builds a tiny real ORB index from generated images, scores it both ways,
// and asserts the numbers are identical — not merely similar.
// No framework — plain node + assert. Run: `node test/globalverify.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-gverify-'));

const DESC_BYTES = 32;
const CAP = 500;
const REF_WIDTH = 500;

function ready() {
  return new Promise((res) => { if (cv && cv.Mat) return res(); cv.onRuntimeInitialized = () => res(); });
}

// A distinctive, feature-rich image per card — flat colour yields no ORB keypoints
// at all, which would make every comparison trivially equal and prove nothing.
async function makeCard(seed) {
  const w = 360, h = 500;
  const rects = [];
  for (let i = 0; i < 26; i++) {
    const x = (seed * 37 + i * 61) % (w - 70);
    const y = (seed * 53 + i * 89) % (h - 70);
    const c = `rgb(${(seed * 90 + i * 31) % 256},${(i * 67 + seed * 13) % 256},${(seed * 21 + i * 97) % 256})`;
    rects.push(`<rect x="${x}" y="${y}" width="${28 + (i % 5) * 9}" height="${20 + (i % 7) * 7}" fill="${c}"/>`);
    rects.push(`<circle cx="${x + 20}" cy="${y + 18}" r="${5 + (i % 4) * 3}" fill="rgb(${(i * 40) % 256},20,${(seed * 40) % 256})"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#101018"/>${rects.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function orbOf(orb, buf) {
  const { data, info } = await sharp(buf).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const src = cv.matFromImageData({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const kpv = new cv.KeyPointVector(); const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kpv, desc);
  const n = Math.min(desc.rows, CAP);
  const out = { desc: new Uint8Array(n * DESC_BYTES), kp: new Float32Array(n * 2), count: n };
  if (n > 0) {
    out.desc.set(desc.data.subarray(0, n * DESC_BYTES));
    for (let i = 0; i < n; i++) { const p = kpv.get(i).pt; out.kp[i * 2] = p.x; out.kp[i * 2 + 1] = p.y; }
  }
  src.delete(); gray.delete(); kpv.delete(); desc.delete();
  return out;
}

async function main() {
  await ready();
  const globalVerify = require('../src/globalVerify');
  const orb = new cv.ORB(CAP);

  const N = 6;
  const cards = [];
  for (let i = 0; i < N; i++) cards.push({ seed: i + 1, img: await makeCard(i + 1) });

  // Write a global-format index: concatenated descriptors, [x,y] keypoints, and a
  // meta of [name, set, number, offset, count].
  const descChunks = [], kpChunks = [], slices = [];
  let offset = 0;
  for (const c of cards) {
    const f = await orbOf(orb, c.img);
    assert.ok(f.count >= 20, `generated card ${c.seed} yielded only ${f.count} keypoints — fixture is too plain to be meaningful`);
    descChunks.push(Buffer.from(f.desc.buffer, f.desc.byteOffset, f.desc.byteLength));
    kpChunks.push(Buffer.from(f.kp.buffer, f.kp.byteOffset, f.kp.byteLength));
    slices.push({ name: `Card ${c.seed}`, set: 'tst', number: String(c.seed), score: 0.5, faces: [{ offset, count: f.count }] });
    offset += f.count;
  }
  const descPath = path.join(tmp, 'tst-orb-desc.bin');
  const kpPath = path.join(tmp, 'tst-orb-kp.bin');
  fs.writeFileSync(descPath, Buffer.concat(descChunks));
  fs.writeFileSync(kpPath, Buffer.concat(kpChunks));

  // Query = card 3's own image, so it must win decisively.
  const target = cards[2];
  const q = await orbOf(orb, target.img);
  const qDesc = new Uint8Array(q.desc);

  const scored = globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp, slices);
  assert.strictEqual(scored.length, N);

  // 1. The identical card wins, and by a wide margin over the others.
  scored.sort((a, b) => b.inliers - a.inliers);
  assert.strictEqual(scored[0].number, '3', `expected card 3 to win, got ${scored[0].number} (${JSON.stringify(scored.map(s => [s.number, s.inliers]))})`);
  assert.ok(scored[0].inliers >= 20, `self-match should be strong, got ${scored[0].inliers}`);
  assert.ok(scored[0].inliers > scored[1].inliers * 2, `winner ${scored[0].inliers} should dominate runner-up ${scored[1].inliers}`);

  // 2. Splitting the candidates across calls — which is exactly what the pool
  //    does per worker — must produce identical numbers. If sharding changed the
  //    scores, results would depend on the core count.
  const half = Math.ceil(slices.length / 2);
  const a = globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp, slices.slice(0, half));
  const b = globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp, slices.slice(half));
  const sharded = [...a, ...b].sort((x, y) => Number(x.number) - Number(y.number));
  const whole = globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp, slices).sort((x, y) => Number(x.number) - Number(y.number));
  assert.deepStrictEqual(sharded, whole, 'sharded verification must be bit-identical to whole-batch');

  // 3. Multi-face candidates keep the best face, not the first or the last.
  const dfc = [{
    name: 'Two Faces', set: 'tst', number: '99', score: 0.4,
    faces: [slices[0].faces[0], slices[2].faces[0]],   // card 1 then card 3
  }];
  const dfcScored = globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp, dfc);
  const card3Alone = whole.find(s => s.number === '3').inliers;
  assert.strictEqual(dfcScored[0].inliers, card3Alone, 'best face should win, and card 3 is the query');

  // 4. A zero-count face scores 0 rather than throwing — a card whose ORB
  //    extraction found nothing must not take a scan down.
  const empty = globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp,
    [{ name: 'Empty', set: 'tst', number: '0', score: 0, faces: [{ offset: 0, count: 0 }] }]);
  assert.strictEqual(empty[0].inliers, 0);

  // 5. closeAll releases the descriptors so a rebuild can rename over the files.
  globalVerify.closeAll();
  fs.renameSync(descPath, `${descPath}.moved`);   // would throw EBUSY on Windows if still open
  fs.renameSync(`${descPath}.moved`, descPath);
  // And a later call transparently reopens.
  assert.strictEqual(globalVerify.verifySlices(descPath, kpPath, qDesc, q.count, q.kp, [slices[2]])[0].inliers, card3Alone);
  globalVerify.closeAll();

  orb.delete();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('globalverify.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave it */ }
  console.error(err);
  process.exit(1);
});
