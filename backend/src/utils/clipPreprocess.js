// The single definition of how a card image becomes a CLIP vector.
//
// This exists because the build side and the query side MUST preprocess
// identically: the index stores reference vectors, and a match is a dot product
// against a query vector. If the two sides ever disagree — a different resize, a
// different pooling, a stray alpha channel — every comparison silently becomes
// meaningless. There is no error, no exception, no log line; recall just
// collapses and the scanner starts returning nonsense.
//
// It used to be two near-identical copies (one in scripts/build-card-embeddings.mjs,
// one in src/embedMatch.js) held together by a comment asking future editors to
// keep them in sync. Now there is one copy, imported by both, and the build
// stamps PREPROCESS into the index meta so a stale index is *detected* rather
// than silently mismatched.
//
// Bump PREPROCESS whenever anything here changes the resulting vector.
const sharp = require('sharp');

// Keep MODEL here rather than in either caller: the meta records the model that
// built an index, and embedMatch loads whatever the meta names, so this is only
// the default for new builds.
const MODEL = 'Xenova/clip-vit-base-patch32';
const DIM = 512;
// Identifies the preprocessing recipe below, not the model. `raw` = feed sharp's
// raw RGB to RawImage (letting the model's own processor resize/crop), `mean`
// pooling, L2-normalised output.
const PREPROCESS = 'raw-rgb/mean/l2-v1';

let tfPromise = null;              // resolves to the @huggingface/transformers module
const extractors = new Map();      // model -> Promise<extractor>

// @huggingface/transformers is ESM-only, so CJS callers reach it through a lazy
// dynamic import. Cached: the first caller pays the load.
function loadTransformers() {
  if (!tfPromise) tfPromise = import('@huggingface/transformers');
  return tfPromise;
}

// Cached image-feature-extraction pipeline per model. Loading the encoder is
// expensive (hundreds of MB), so a process holds at most one per model.
function getExtractor(model = MODEL) {
  if (!extractors.has(model)) {
    extractors.set(model, (async () => {
      const { pipeline } = await loadTransformers();
      console.log(`clipPreprocess: loading model ${model}...`);
      return pipeline('image-feature-extraction', model);
    })());
  }
  return extractors.get(model);
}

// Decode an image Buffer to the RawImage the encoder expects. removeAlpha()
// because a transparent PNG would otherwise feed a 4th channel into a 3-channel
// encoder.
async function toRawImage(imageBuffer) {
  const { RawImage } = await loadTransformers();
  const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
}

// Collapse whatever nesting the model returns down to one flat vector. Shapes
// vary across models and versions — [1,1,D], [1,D], [D], or [tokens,D] — so peel
// the leading singleton dimensions, then mean-pool if tokens survive.
function flatten(raw) {
  let v = raw;
  while (Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && Array.isArray(v[0][0])) v = v[0];
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (Array.isArray(v[0])) {
    const D = v[0].length, m = new Float32Array(D);
    for (const row of v) for (let i = 0; i < D; i++) m[i] += row[i] / v.length;
    v = Array.from(m);
  }
  return v;
}

// Scale to unit length. Both sides being unit-length is what lets match() use a
// plain dot product as cosine similarity. A zero vector would divide by zero, so
// it passes through unchanged rather than becoming NaN.
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}

// L2-normalised embedding of an image Buffer, as a Float32Array.
async function embedImage(imageBuffer, model = MODEL) {
  const extractor = await getExtractor(model);
  const img = await toRawImage(imageBuffer);
  const out = await extractor(img, { pooling: 'mean', normalize: true });
  return normalize(flatten(out.tolist()));
}

// Drop cached encoders (used by tests; a long-lived server keeps them).
function reset() { extractors.clear(); }

module.exports = {
  MODEL, DIM, PREPROCESS,
  embedImage, getExtractor, loadTransformers, toRawImage,
  flatten, normalize, reset,
};
