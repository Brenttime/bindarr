// Server-side card identification by CLIP image embedding.
//
// Loads the precomputed per-game embedding DB (backend/data/{game}-embed.bin +
// -meta.json, built by scripts/build-card-embeddings.mjs) and matches an
// uploaded card image against every card by cosine similarity.
//
// Preprocessing and the encoder itself live in utils/clipPreprocess, shared with
// the build script — see the header there for why that sharing is load-bearing.
// DBs are cached singletons; the first match() pays the model load.
const fs = require('fs');
const clip = require('./utils/clipPreprocess');
const gpaths = require('./utils/globalIndexPaths');

const dbs = {};            // "game|lang" -> { vecs: Float32Array, cards, n, dim } | null

// Load a game+language embedding DB from disk once. Returns null if not built.
function loadDb(game, lang = 'en') {
  const k = gpaths.key(game, lang);
  if (k in dbs) return dbs[k];
  const { bin: binPath, meta: metaPath } = gpaths.embed(game, lang);
  if (!fs.existsSync(binPath) || !fs.existsSync(metaPath)) { dbs[k] = null; return null; }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const buf = fs.readFileSync(binPath);
  // Copy into an aligned Float32Array (fs Buffer may not be 4-byte aligned).
  const vecs = new Float32Array(buf.length / 4);
  Buffer.from(vecs.buffer).set(buf);
  dbs[k] = { vecs, cards: meta.cards, n: meta.cards.length, dim: meta.dim, model: meta.model, preprocess: meta.preprocess };
  console.log(`embedMatch: loaded ${gpaths.tag(game, lang)} DB (${meta.cards.length} cards, dim ${meta.dim})`);
  // An index built by a different preprocessing recipe is not comparable to
  // anything this process can produce. Warn loudly rather than silently return
  // garbage scores — `preprocess` is absent on indexes built before it existed,
  // which is not an error, just unknown.
  if (meta.preprocess && meta.preprocess !== clip.PREPROCESS) {
    console.warn(
      `embedMatch: ${gpaths.tag(game, lang)} DB was built with preprocessing '${meta.preprocess}' but this ` +
      `server uses '${clip.PREPROCESS}'. Scores will be meaningless — rebuild the global index.`
    );
  }
  return dbs[k];
}

// Match an image against a game+language DB. Returns up to topK
// [{ name, set, number, score }] sorted by descending cosine (1 = identical),
// or [] if the DB isn't built. Both query and DB vectors are unit-length, so
// cosine is a plain dot product.
async function match(imageBuffer, game, topK = 8, lang = 'en') {
  const db = loadDb(game, lang);
  if (!db) return [];
  const q = await clip.embedImage(imageBuffer, db.model);
  if (q.length !== db.dim) throw new Error(`embedding dim mismatch: query ${q.length} vs db ${db.dim}`);

  const { vecs, cards, n, dim } = db;
  const best = []; // ascending by score, length <= topK
  for (let r = 0; r < n; r++) {
    const base = r * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += q[d] * vecs[base + d];
    if (best.length < topK || s > best[0].score) {
      const row = cards[r];
      const cand = { name: row[0], set: row[1], number: row[2], score: s };
      let pos = 0;
      while (pos < best.length && best[pos].score < s) pos++;
      best.splice(pos, 0, cand);
      if (best.length > topK) best.shift();
    }
  }
  return best.reverse(); // descending: closest first
}

// Evict a cached embedding DB so the next match reloads from disk. Called after
// a global rebuild swaps in fresh files. Omitting `lang` evicts every language
// of that game, which is what a caller with no language in hand wants.
function reload(game, lang) {
  if (lang === undefined) {
    for (const k of Object.keys(dbs)) if (k.startsWith(`${game}|`)) delete dbs[k];
    return;
  }
  delete dbs[gpaths.key(game, lang)];
}

// Is a game+language DB built and loadable? Used to decide whether a non-English
// scan can use the global path at all.
function isBuilt(game, lang = 'en') { return !!loadDb(game, lang); }

module.exports = { match, reload, isBuilt };
