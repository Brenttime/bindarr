// The build side and the query side share one preprocessing definition
// (src/utils/clipPreprocess.js) because a mismatch between them produces no
// error at all — every dot product silently becomes meaningless and recall just
// collapses. These cover the parts that don't need the encoder weights: the
// shape flattening, the L2 normalisation, and the sharp decode.
// No framework — plain node + assert. Run: `node test/clippreprocess.test.js`
const assert = require('assert');
const sharp = require('sharp');

const clip = require('../src/utils/clipPreprocess');

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const len = (v) => { let n = 0; for (const x of v) n += x * x; return Math.sqrt(n); };

async function main() {
  // --- flatten: models return the same vector wrapped in varying nesting, and
  // guessing wrong would silently mis-shape every reference vector. ---

  // Already flat.
  assert.deepStrictEqual(clip.flatten([1, 2, 3]), [1, 2, 3]);
  // [1, D] — the common single-image case.
  assert.deepStrictEqual(clip.flatten([[1, 2, 3]]), [1, 2, 3]);
  // [1, 1, D] — an extra batch dimension.
  assert.deepStrictEqual(clip.flatten([[[1, 2, 3]]]), [1, 2, 3]);
  // [1, 1, 1, D] — peeled all the way down.
  assert.deepStrictEqual(clip.flatten([[[[1, 2, 3]]]]), [1, 2, 3]);

  // [tokens, D] with tokens > 1 must mean-pool across tokens, not take the first
  // row or concatenate: column means of [[0,10],[2,20],[4,30]] are [2,20].
  const pooled = clip.flatten([[0, 10], [2, 20], [4, 30]]);
  assert.strictEqual(pooled.length, 2);
  assert.ok(close(pooled[0], 2), `expected 2, got ${pooled[0]}`);
  assert.ok(close(pooled[1], 20), `expected 20, got ${pooled[1]}`);

  // A batch wrapper around multiple tokens: peel the batch, then pool.
  const both = clip.flatten([[[1, 1], [3, 5]]]);
  assert.ok(close(both[0], 2) && close(both[1], 3), `got ${both}`);

  // --- normalize: unit length is the precondition for cosine-as-dot-product ---

  const n1 = clip.normalize([3, 4]);            // |[3,4]| = 5
  assert.ok(n1 instanceof Float32Array, 'must be a Float32Array to write into the .bin');
  assert.ok(close(n1[0], 0.6) && close(n1[1], 0.8), `got ${n1}`);
  assert.ok(close(len(n1), 1), 'result is unit length');

  // Already-unit input is left alone.
  assert.ok(close(len(clip.normalize([0, 1, 0])), 1));

  // A zero vector must pass through rather than become NaN — a NaN row would
  // poison every comparison against it with no visible error.
  const z = clip.normalize([0, 0, 0]);
  assert.ok(z.every(x => x === 0), `expected zeros, got ${z}`);

  // Sign is preserved (direction matters, not just magnitude).
  const neg = clip.normalize([-3, 4]);
  assert.ok(neg[0] < 0 && neg[1] > 0 && close(len(neg), 1));

  // --- toRawImage: 3-channel RGB regardless of the source's alpha ---

  const rgb = await sharp({ create: { width: 5, height: 7, channels: 3, background: '#204060' } }).png().toBuffer();
  let img = await clip.toRawImage(rgb);
  assert.strictEqual(img.width, 5);
  assert.strictEqual(img.height, 7);
  assert.strictEqual(img.channels, 3);
  assert.strictEqual(img.data.length, 5 * 7 * 3);

  // A transparent PNG must come back as 3 channels too: leaving the alpha on
  // would feed a 4th channel into a 3-channel encoder.
  const rgba = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
  img = await clip.toRawImage(rgba);
  assert.strictEqual(img.channels, 3, 'alpha must be removed, not passed through');
  assert.strictEqual(img.data.length, 4 * 4 * 3);

  // --- the recipe stamp, which is what lets a stale index be detected ---
  assert.ok(typeof clip.PREPROCESS === 'string' && clip.PREPROCESS.length > 0);
  assert.strictEqual(clip.DIM, 512, 'DIM must match the default model output');
  assert.ok(clip.MODEL.includes('clip'), `unexpected default model ${clip.MODEL}`);

  console.log('clippreprocess.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
