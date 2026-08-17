/*
 * Precompute CLIP image embeddings for every card — the recall stage of a global
 * (code-free) scan.
 *
 * For each card: download its image, run it through the CLIP image encoder, and
 * store the 512-d unit vector. Output (server-side, NOT shipped to the client):
 *   {game}-embed.bin        Float32, N * DIM
 *   {game}-embed-meta.json  { model, dim, preprocess, lang, cards: [[name,set,number]] }
 * Row i of the .bin is card i of the meta.
 *
 * The ORB half of a global index is NOT built here — it is assembled from the
 * per-set indexes by src/orbUnion.js. See src/globalIndex.js for why.
 *
 * Preprocessing lives in src/utils/clipPreprocess.js, shared with the query side:
 * if the two ever diverge every stored vector silently stops matching.
 *
 * Heavy, one-time (per game+language): tens of thousands of images downloaded and
 * encoded on CPU. Checkpoints as it goes; rerun with --resume to continue.
 *
 * Usage:
 *   node scripts/build-card-embeddings.mjs --game mtg
 *   node scripts/build-card-embeddings.mjs --game pokemon --resume
 *   node scripts/build-card-embeddings.mjs --game mtg --limit 20      (smoke test)
 *   node scripts/build-card-embeddings.mjs --game mtg --preflight     (source check)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { makeHttp, gatherMtg, gatherPokemon, sleep } from './cardSources.js';
import clipPreprocess from '../src/utils/clipPreprocess.js';

const { MODEL, DIM, PREPROCESS, embedImage, getExtractor } = clipPreprocess;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// INDEX_OUT_DIR lets an in-app rebuild write to a staging dir, then swap the
// files into place — so live scans keep using the old DB until the build finishes.
const DATA_DIR = process.env.INDEX_OUT_DIR || path.join(__dirname, '..', 'data');

// Images are fetched concurrently and encoded as they land, so the CPU never
// waits on the network. Matches the pattern src/setIndex.js already uses for
// per-set builds, which is why there is no fixed inter-card sleep any more.
const CONCURRENCY = Math.max(2, parseInt(process.env.INDEX_BUILD_CONCURRENCY || '8', 10));
// Abort rather than grind through 74k cards producing nothing when the network,
// DNS or a rate limit has clearly broken. Sized well above any plausible run of
// genuinely-missing images.
const MAX_CONSECUTIVE_FAILURES = 50;
const CHECKPOINT_EVERY = 2000;
const IMAGE_ATTEMPTS = 3;

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const hasFlag = (f) => process.argv.includes(f);

// --- progress events -----------------------------------------------------

// Structured events go to fd 3 so stdout stays human-readable. src/globalIndex.js
// reads these; parsing log prose with regexes (the old approach) broke whenever a
// message was reworded and could not express a phase at all.
// Only present when a parent actually gave us fd 3 (globalIndex spawns with
// stdio [...,'pipe']). Run from a terminal there is no fd 3, so probe it first:
// createWriteStream on a closed fd constructs fine and then throws EBADF on
// write/close, which would take the whole build down at the very end.
const events = (() => {
  try {
    fs.fstatSync(3);
    const s = fs.createWriteStream(null, { fd: 3, autoClose: false });
    s.on('error', () => { /* parent may close the pipe before we finish */ });
    return s;
  } catch { return null; }
})();
function emit(obj) {
  if (!events) return;
  try { events.write(JSON.stringify(obj) + '\n'); } catch { /* parent closed fd 3 */ }
}

let started = Date.now();
function emitProgress(phase, done, total, fail) {
  const secs = (Date.now() - started) / 1000;
  const rate = secs > 0 ? done / secs : 0;
  emit({
    ev: 'progress', phase, done, total, fail,
    rate: Math.round(rate * 100) / 100,
    eta: rate > 0 && total > done ? Math.round((total - done) / rate) : 0,
  });
}

// --- image fetch ---------------------------------------------------------

// Retry transient image failures. A card dropped here is absent from the index
// and can never be scanned, so it is worth several attempts: at a 5% silent loss
// rate an MTG build would leave ~3,700 cards unscannable with nothing to show it.
async function fetchImage(http, url) {
  let lastErr;
  for (let attempt = 0; attempt < IMAGE_ATTEMPTS; attempt++) {
    try {
      const r = await http.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      return Buffer.from(r.data);
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      if (status === 404 || status === 403) break;  // not transient; do not retry
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// Run `worker` over `items` with at most `limit` in flight, preserving order in
// the results array. Used to overlap downloads with encoding.
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// --- preflight -----------------------------------------------------------

// Resolve the source, fetch a handful of images and encode one. Surfaces a broken
// card source or an unreachable model host in seconds instead of an hour into a
// build. Issue #29 was exactly this failure, discovered the slow way.
async function preflight(game, lang, http) {
  console.log(`Preflight for ${game} (${lang})...`);
  const cards = game === 'pokemon' ? await gatherPokemon(http, 100, 5) : await gatherMtg(http);
  if (!cards.length) throw new Error('card source returned no cards');
  console.log(`  source OK: ${cards.length} cards listed`);

  const sample = cards.slice(0, 5);
  let ok = 0;
  for (const c of sample) {
    try { const buf = await fetchImage(http, c.img); if (buf.length) ok++; }
    catch (e) { console.warn(`  image failed (${c.name}): ${e.message}`); }
  }
  if (!ok) throw new Error('every sample image download failed — check network/DNS');
  console.log(`  images OK: ${ok}/${sample.length} downloaded`);

  const buf = await fetchImage(http, sample[0].img);
  const v = await embedImage(buf, MODEL);
  console.log(`  encoder OK: dim ${v.length} (model ${MODEL}, preprocess ${PREPROCESS})`);
  if (v.length !== DIM) console.warn(`  note: encoder returned dim ${v.length}, expected ${DIM}`);
  console.log('Preflight passed.');
}

// --- build ---------------------------------------------------------------

async function main() {
  const game = arg('--game', 'mtg');
  if (game !== 'mtg' && game !== 'pokemon') { console.error('Use --game mtg|pokemon'); process.exit(1); }
  const lang = arg('--lang', 'en');
  const limit = parseInt(arg('--limit', '0'), 10) || 0;
  const delay = parseInt(arg('--delay', '100'), 10);   // page delay for the Pokémon list only
  const resume = hasFlag('--resume');

  const http = makeHttp();
  if (hasFlag('--preflight')) { await preflight(game, lang, http); return; }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // English keeps the un-suffixed filenames so pre-language indexes are still
  // found (mirrors src/utils/globalIndexPaths.js).
  const tag = lang === 'en' ? game : `${game}-${lang}`;
  const binPath = path.join(DATA_DIR, `${tag}-embed.bin`);
  const metaPath = path.join(DATA_DIR, `${tag}-embed-meta.json`);
  const listPath = path.join(DATA_DIR, `${tag}-cards.json`);

  // Reuse the gathered card list on resume: re-streaming and re-parsing the 37 MB
  // bulk archive on every restart is pure waste, and the list must be identical
  // for the already-written rows to still line up with it.
  emitProgress('gather', 0, 0, 0);
  let cards = null;
  if (resume && fs.existsSync(listPath)) {
    try {
      cards = JSON.parse(fs.readFileSync(listPath));
      console.log(`Reusing cached card list (${cards.length} cards).`);
    } catch { cards = null; }
  }
  if (!cards) {
    cards = game === 'pokemon'
      ? await gatherPokemon(http, delay, limit)
      : await gatherMtg(http, { onProgress: (n) => emitProgress('gather', n, 0, 0) });
    if (limit) cards = cards.slice(0, limit);
    try { fs.writeFileSync(listPath, JSON.stringify(cards)); } catch { /* cache is optional */ }
  }
  if (limit) cards = cards.slice(0, limit);
  if (!cards.length) throw new Error(`no ${game} cards to embed`);

  // Resume: keep the rows already computed and continue after them.
  let meta = [];
  let done = 0;
  const vectors = Buffer.alloc(cards.length * DIM * 4);
  if (resume && fs.existsSync(metaPath) && fs.existsSync(binPath)) {
    const prevMeta = JSON.parse(fs.readFileSync(metaPath));
    // Only resume across an identical recipe; otherwise the old rows are not
    // comparable to the new ones and the index would be a silent mixture.
    if (prevMeta.preprocess && prevMeta.preprocess !== PREPROCESS) {
      console.warn(`Ignoring resume: index was built with preprocessing '${prevMeta.preprocess}', now '${PREPROCESS}'.`);
    } else if (prevMeta.model && prevMeta.model !== MODEL) {
      console.warn(`Ignoring resume: index was built with model '${prevMeta.model}', now '${MODEL}'.`);
    } else {
      meta = prevMeta.cards || [];
      const prev = fs.readFileSync(binPath);
      prev.copy(vectors, 0, 0, Math.min(prev.length, vectors.length));
      done = meta.length;
      console.log(`Resuming: ${done} already embedded.`);
    }
  }

  console.log(`Loading model ${MODEL}...`);
  await getExtractor(MODEL);

  const flush = () => {
    fs.writeFileSync(binPath, vectors.subarray(0, meta.length * DIM * 4));
    fs.writeFileSync(metaPath, JSON.stringify({
      model: MODEL, dim: DIM, preprocess: PREPROCESS, lang, cards: meta,
    }));
  };

  const remaining = cards.slice(done);
  console.log(`Embedding ${remaining.length} of ${cards.length} ${game} (${lang}) cards, concurrency ${CONCURRENCY}...`);
  started = Date.now();

  let fail = 0;
  let consecutive = 0;
  const missed = [];
  let processed = 0;

  // Downloads run `CONCURRENCY`-wide; encoding happens on the main thread as each
  // buffer lands. Chunked so results are written in card order, which keeps the
  // .bin rows aligned with the meta and makes a checkpoint meaningful.
  for (let start = 0; start < remaining.length; start += CONCURRENCY) {
    const chunk = remaining.slice(start, start + CONCURRENCY);
    const buffers = await mapLimit(chunk, CONCURRENCY, async (c) => {
      try { return { c, buf: await fetchImage(http, c.img) }; }
      catch (e) { return { c, err: e }; }
    });

    for (const item of buffers) {
      processed++;
      if (item.err) {
        fail++; consecutive++;
        missed.push({ name: item.c.name, set: item.c.set, number: item.c.number, reason: item.err.message });
        continue;
      }
      try {
        const emb = await embedImage(item.buf, MODEL);
        Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength).copy(vectors, meta.length * DIM * 4);
        meta.push([item.c.name, item.c.set, item.c.number]);
        consecutive = 0;
      } catch (e) {
        fail++; consecutive++;
        missed.push({ name: item.c.name, set: item.c.set, number: item.c.number, reason: e.message });
      }
    }

    if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
      flush();
      const last = missed[missed.length - 1];
      throw new Error(
        `${consecutive} consecutive failures — aborting rather than building a mostly-empty index. ` +
        `Last error: ${last ? last.reason : 'unknown'}`
      );
    }

    if (processed % 250 < CONCURRENCY) {
      console.log(`  ${done + processed}/${cards.length} (fail ${fail})`);
      emitProgress('embed', done + processed, cards.length, fail);
    }
    if (processed % CHECKPOINT_EVERY < CONCURRENCY) flush();
  }

  // One more pass at everything that failed: a transient blip early on should not
  // leave a card permanently unscannable.
  if (missed.length) {
    console.log(`Retrying ${missed.length} failed cards...`);
    const retry = missed.splice(0, missed.length);
    const byKey = new Map(cards.map(c => [`${c.set}|${c.number}|${c.name}`, c]));
    let recovered = 0;
    for (const m of retry) {
      const c = byKey.get(`${m.set}|${m.number}|${m.name}`);
      if (!c) { missed.push(m); continue; }
      try {
        const emb = await embedImage(await fetchImage(http, c.img), MODEL);
        Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength).copy(vectors, meta.length * DIM * 4);
        meta.push([c.name, c.set, c.number]);
        recovered++;
      } catch (e) { missed.push({ ...m, reason: e.message }); }
    }
    fail -= recovered;
    console.log(`  recovered ${recovered}, still missing ${missed.length}`);
  }

  flush();
  emitProgress('embed', cards.length, cards.length, fail);

  const rate = meta.length / cards.length;
  console.log(`Done. Wrote ${meta.length}/${cards.length} embeddings (${fail} failed, ${(rate * 100).toFixed(1)}% complete).`);
  console.log(`  ${binPath} (${(fs.statSync(binPath).size / 1e6).toFixed(1)} MB)`);

  // Name what is missing instead of leaving it to be discovered as "that card
  // never scans". Capped so a systemic failure does not produce a 74k-line log.
  if (missed.length) {
    const missPath = path.join(DATA_DIR, `${tag}-embed-missing.json`);
    try {
      fs.writeFileSync(missPath, JSON.stringify(missed, null, 2));
      console.warn(`  ${missed.length} cards could not be embedded — see ${missPath}`);
    } catch { /* reporting is best-effort */ }
    for (const m of missed.slice(0, 10)) console.warn(`    ${m.name} [${m.set}/${m.number}]: ${m.reason}`);
    if (missed.length > 10) console.warn(`    ...and ${missed.length - 10} more`);
  }

  // The caller (globalIndex) also checks this before swapping, but failing here
  // means --resume can pick up where this left off instead of starting over.
  if (rate < 0.95) {
    throw new Error(`only ${meta.length}/${cards.length} cards embedded (${(rate * 100).toFixed(1)}%) — refusing to finish a partial index`);
  }
  // The card-list cache is only useful mid-build.
  try { fs.unlinkSync(listPath); } catch { /* already gone */ }
}

main().catch(e => {
  emit({ ev: 'error', message: e.message });
  console.error(e.stack || e.message);
  process.exit(1);
});
