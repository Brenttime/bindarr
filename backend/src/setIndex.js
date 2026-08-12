// Per-set ORB index for set-scoped card identification.
//
// When the user tells the scanner which set they're feeding (MTG set code), we
// don't need to recall one card out of 53k — just identify it among that set's
// ~300 printings. This builds (lazily, then caches to disk) an ORB index for a
// single set from Scryfall and matches a query against only those cards, so the
// hard global-recall problem disappears. The exact printing wins on inliers.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { cv } = require('opencv-wasm');
const languages = require('./utils/languages');
// scryfallApi/tcgApi are lazy-required inside the build/preview paths only — they
// pull in the DB module, which verify-only worker threads must not load.

const SETS_DIR = process.env.SETS_DIR || path.join(__dirname, '..', 'data', 'sets');
const DESC_BYTES = 32, CAP = 500, REF_WIDTH = 500, RATIO = 0.75, RANSAC_PX = 5.0;

const http = axios.create({ timeout: 30000, headers: { 'User-Agent': 'Bindarr/1.0', 'Accept': 'application/json' } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const cache = {};        // "game|set|lang" -> { meta, desc:Buffer, kp:Buffer } (loaded)
const building = {};     // "game|set|lang" -> Promise (in-flight build)
const progress = {};     // "game|set|lang" -> { total, done, status:'fetching'|'indexing'|'done'|'error', error? }

// A card's art is language-specific, so an index built from English scans is
// useless against a Japanese print of the same card: different name box,
// different flavour text, different ORB features. Each language therefore gets
// its own index, keyed and stored separately.
const norm = (set) => (set || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const langOf = (lang) => languages.toCode(lang);
const key = (game, set, lang) => `${game}|${norm(set)}|${langOf(lang)}`;
const paths = (game, set, lang) => {
  // English keeps the original, un-suffixed filenames so every index built before
  // languages existed is still found instead of silently rebuilt.
  const code = langOf(lang);
  const suffix = code === 'en' ? '' : `-${code}`;
  const base = path.join(SETS_DIR, `${game}-${norm(set)}${suffix}-orb`);
  return { desc: `${base}-desc.bin`, kp: `${base}-kp.bin`, meta: `${base}-meta.json` };
};

function orbExtract(orb, rgba, w, h) {
  const src = cv.matFromImageData({ data: rgba, width: w, height: h });
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

let sharedOrb = null;
function extractCard(rgba, w, h) {
  if (!sharedOrb) sharedOrb = new cv.ORB(CAP);
  return orbExtract(sharedOrb, rgba, w, h);
}

// 64-bit dHash of an image buffer: 9x8 grayscale, each pixel brighter than its
// right neighbour -> 1 bit. Cheap, rotation-sensitive but robust to scale/JPEG,
// so it's a fast recall pre-filter for the expensive ORB verify. Returned as two
// 32-bit halves { hi, lo } so Hamming distance is a pair of popcounts.
async function dhash(buf) {
  const { data } = await sharp(buf).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  let hi = 0, lo = 0, bit = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const b = data[r * 9 + c] < data[r * 9 + c + 1] ? 1 : 0;
      if (bit < 32) hi = (hi << 1) | b; else lo = (lo << 1) | b;
      bit++;
    }
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

const hamming = (a, b) => popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);

// A Scryfall release is split into a parent expansion plus child sets — tokens,
// promos, art series, Commander — each with its own set code (tecl, pecl, ...),
// linked by parent_set_code. Build a query spanning the whole family so "ecl"
// indexes tokens/art/etc., not just the 408 main-set prints. Digital-only sets
// (Alchemy) are skipped — no physical card to scan. include:extras stops Scryfall
// hiding tokens/emblems; -is:digital drops any stray digital print.
async function mtgSetFamilyQuery(set, lang) {
  const scryfallApi = require('./scryfallApi');
  const code = norm(set);
  const codes = new Set([code]);
  try {
    const r = await scryfallApi.scryGetRetried('https://api.scryfall.com/sets');
    for (const s of r.data.data || []) {
      if (s.parent_set_code === code && !s.digital) codes.add(s.code);
    }
  } catch { /* /sets unreachable: fall back to the main set only */ }
  const sets = [...codes].map(c => `set:${c}`).join(' or ');
  // Language is a search keyword (and needs include_multilingual on the request,
  // added by mtgSearchUrl below) — Scryfall has no lang parameter.
  const scryLang = languages.resolve(lang).scryfall;
  const langTerm = scryLang === 'en' ? '' : ` lang:${scryLang}`;
  return `(${sets}) include:extras unique:prints -is:digital${langTerm}`;
}

// Search URL for a set family in one language. English omits
// include_multilingual so the query stays exactly what it was before languages.
function mtgSearchUrl(query, lang, extra = '') {
  const multilingual = languages.resolve(lang).scryfall === 'en' ? '' : '&include_multilingual=true';
  return `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}${extra}${multilingual}`;
}

// Every set worth building a global index from, as set codes in build order.
//
// MTG returns PARENT sets only. mtgSetFamilyQuery above already folds a set's
// children (tokens, art series, promos — anything linked by parent_set_code)
// into the parent's index, so enumerating the children as well would index the
// same printings twice: harmless for correctness (scanMatch treats repeated
// set|number rows as faces and keeps the best) but a straight waste of build
// time and disk. Digital-only sets are skipped — no physical card to scan.
async function listAllSets(game, lang) {
  const code = langOf(lang);
  if (game === 'mtg') {
    const scryfallApi = require('./scryfallApi');
    const r = await scryfallApi.scryGetRetried('https://api.scryfall.com/sets');
    return (r.data.data || [])
      .filter(s => s.code && !s.digital && !s.parent_set_code && (s.card_count || 0) > 0)
      .map(s => s.code);
  }
  if (code !== 'en') {
    // Non-English Pokémon comes from TCGdex, whose per-language coverage varies
    // enormously (ru has 9 sets to en's 218) — an almost-empty list is normal.
    const tcgdexApi = require('./tcgdexApi');
    const sets = await tcgdexApi.listSets(code);
    return sets.filter(s => s.id && (s.total || s.printed_total || 0) > 0).map(s => s.id);
  }
  // tcgApi.tcgClient, not the bare `http` above: api.pokemontcg.io answers 5xx
  // often enough that a single un-retried GET here would abort a whole multi-hour
  // global build before it indexed anything. That client already retries
  // transients and carries the API key.
  const { tcgClient } = require('./tcgApi');
  const out = [];
  for (let page = 1; ; page++) {
    const r = await tcgClient.get('/sets', { params: { page, pageSize: 250, select: 'id,total' } });
    const data = r.data.data || [];
    for (const s of data) if (s.id) out.push(s.id);
    if (data.length < 250) break;
  }
  return out;
}

// Scannable face image(s) for a Scryfall card. Single-image layouts (normal,
// split, flip, adventure, saga) carry one top-level image. Double-faced cards
// (transform, modal DFC, art series, reversible) have no top-level image and one
// distinct image per face — index every face so scanning either side matches.
function mtgCardImages(c) {
  if (c.image_uris?.normal) return [c.image_uris.normal];
  return (c.card_faces || []).map(f => f.image_uris?.normal).filter(Boolean);
}

// MTG: page Scryfall for a set family in one language. Returns
// [{ name, set, number, img, raw }], one entry per scannable face (double-faced
// cards yield two, same name/number). `name` is the localized (printed) name when
// there is one, because that is what the post-scan lookup searches Scryfall for —
// verified: `!"稲妻" lang:ja` with include_multilingual finds the card.
async function fetchMtgSet(set, lang) {
  const scryfallApi = require('./scryfallApi');
  let url = mtgSearchUrl(await mtgSetFamilyQuery(set, lang), lang, '&order=set');
  const cards = [];
  while (url) {
    const r = await scryfallApi.scryGetRetried(url);
    for (const c of r.data.data || []) {
      for (const img of mtgCardImages(c)) {
        cards.push({ name: c.printed_name || c.name || '', set: c.set || set, number: c.collector_number || '', img, raw: c });
      }
    }
    url = r.data.has_more ? r.data.next_page : null;
    await sleep(120);
  }
  return cards;
}

// Pokémon, non-English: TCGdex. One request returns the whole set's cards with
// localized names and art (pokemontcg.io has no non-English sets at all).
//
// TCGdex's coverage is uneven PER SET, in ways its own metadata hides, and a scan
// index needs card ART specifically. Three distinct dead ends, all of which used
// to surface as the same useless "no cards for set X":
//   1. the set does not exist in this language at all (codes differ by language)
//   2. the set is listed — even reporting a cardCount — but holds no card records
//      (Korean SV2a claims 165 cards and returns zero)
//   3. the cards exist but none carry an image (Korean SV4M has all 95 cards with
//      names and prices, and no art) — searchable, but impossible to scan
// Each says which one it is, because the user's next move differs every time.
async function fetchTcgdexSet(set, lang) {
  const tcgdexApi = require('./tcgdexApi');
  const code = languages.toCode(lang);
  const langName = languages.toName(code);
  let r;
  try {
    r = await http.get(`https://api.tcgdex.net/v2/${code}/sets/${encodeURIComponent(set)}`);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      throw new Error(`TCGdex has no ${langName} set "${set}". Set codes differ by language — pick from the ${langName} set list.`);
    }
    throw e;
  }
  const setName = r.data.name || set;
  const all = r.data.cards || [];
  if (!all.length) {
    throw new Error(`TCGdex lists "${setName}" (${set}) in ${langName} but has no cards for it yet, so there is nothing to index. Try another set or language.`);
  }
  if (!all.some(c => c.image)) {
    throw new Error(`TCGdex has ${all.length} ${langName} cards for "${setName}" (${set}) but no card images, and scanning matches on the art. You can still search and add these cards by name; scanning this set needs another language.`);
  }
  const cards = [];
  for (const brief of all) {
    if (!brief.image) continue; // this card has no art yet; the rest of the set does
    cards.push({
      name: brief.name || '',
      set: r.data.id || set,
      number: brief.localId != null ? String(brief.localId) : '',
      // High res for indexing: ORB has more to work with than the 245px art the
      // card grids use, and this runs once per set.
      img: `${brief.image}/high.png`,
      raw: { ...brief, set: { id: r.data.id || set, name: setName } },
      tcgdex: true,
    });
  }
  return cards;
}

// Pokémon: page pokemontcg.io by set id. Uses POKEMON_TCG_API_KEY if set.
async function fetchPokemonSet(set) {
  const key = process.env.POKEMON_TCG_API_KEY || '';
  const headers = key ? { 'X-Api-Key': key } : {};
  const cards = [];
  let page = 1, total = Infinity;
  while ((page - 1) * 250 < total) {
    // pokemontcg.io is slow/flaky under load — retry each page with backoff
    // (mirrors scripts/cardSources.js gatherPokemon).
    let data = null, count = 0;
    for (let attempt = 0; attempt < 5 && data === null; attempt++) {
      try {
        const r = await http.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: `set.id:${set}`, page, pageSize: 250, select: 'id,name,number,set,images,rarity,supertype,subtypes,types,tcgplayer,cardmarket' },
          headers,
        });
        count = r.data.totalCount || 0;
        data = r.data.data || [];
      } catch (e) {
        if (attempt === 4) throw e;
        console.warn(`setIndex: ${set} page ${page} attempt ${attempt + 1} failed (${e.message}); retrying...`);
        await sleep(2000 * Math.pow(2, attempt));
      }
    }
    total = count;
    if (data.length === 0) break;
    for (const c of data) {
      const img = c.images?.large || c.images?.small;
      if (img) cards.push({ name: c.name || '', set: c.set?.id || set, number: c.number || '', img, raw: c });
    }
    page++;
    await sleep(120);
  }
  return cards;
}

// Fetch every printing in a set, in one language, ORB-index each, persist.
async function buildSet(game, set, lang) {
  const k = key(game, set, lang);
  const code = langOf(lang);
  if (game !== 'mtg' && game !== 'pokemon') throw new Error('set index only supports mtg/pokemon');
  fs.mkdirSync(SETS_DIR, { recursive: true });
  progress[k] = { total: 0, done: 0, status: 'fetching', lang: code };
  try {
    console.log(`setIndex: building ${game} ${set} (${code})...`);
    const cards = game === 'mtg'
      ? await fetchMtgSet(set, code)
      : (code === 'en' ? await fetchPokemonSet(set) : await fetchTcgdexSet(set, code));
    if (cards.length === 0) throw new Error(`no cards for set ${set}`);
    progress[k].total = cards.length;
    progress[k].status = 'indexing';

    // Cache full card data now so the post-match /api/search is an instant local
    // card_cache hit instead of a live (throttled) provider fetch per scan.
    try {
      if (game === 'mtg') {
        const scryfallApi = require('./scryfallApi');
        const seen = new Set();
        const rows = cards.filter(c => c.raw?.id && (seen.has(c.raw.id) ? false : seen.add(c.raw.id)));
        await scryfallApi.cacheCards(rows.map(c => scryfallApi.normalizeCard(c.raw, code)));
      } else if (code === 'en') {
        const tcgApi = require('./tcgApi');
        await tcgApi.cacheCards(cards.map(c => c.raw));
      } else {
        // TCGdex set briefs carry no rarity/types/prices, so these rows are thin
        // on purpose — enough for the scanner to name a card the instant it
        // matches, without 237 extra requests during a build. They are flagged
        // `incomplete` so they read as stale and get filled in when the card is
        // actually added (see the add route) or by the price sweep.
        const tcgdexApi = require('./tcgdexApi');
        await tcgdexApi.cacheCards(cards.map(c => tcgdexApi.normalizeCard(c.raw, code)), { incomplete: true });
      }
    } catch (e) { console.warn(`setIndex: caching ${set} cards failed: ${e.message}`); }

    const p = paths(game, set, lang);
    const descFd = fs.openSync(p.desc, 'w'), kpFd = fs.openSync(p.kp, 'w');
    const scanPool = require('./scanPool');
    const workers = scanPool.getPool();
    const concurrency = Math.max(4, workers.length || 4);
    const meta = [];
    let offset = 0;

    for (let i = 0; i < cards.length; i += concurrency) {
      const chunk = cards.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map(async (c) => {
        try {
          const buf = Buffer.from((await http.get(c.img, { responseType: 'arraybuffer', timeout: 30000 })).data);
          const { data, info } = await sharp(buf).resize({ width: REF_WIDTH, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const raw = new Uint8ClampedArray(data);
          let f = await scanPool.extract(raw, info.width, info.height);
          if (!f) f = extractCard(raw, info.width, info.height);
          const h = await dhash(buf); // recall pre-filter hash, same image as the features
          return { card: c, f, h };
        } catch {
          return null;
        }
      }));

      for (const res of results) {
        progress[k].done++;
        if (!res || !res.f) continue;
        const { card: c, f, h } = res;
        fs.writeSync(descFd, Buffer.from(f.desc.buffer, 0, f.desc.length), 0, f.desc.length, offset * DESC_BYTES);
        fs.writeSync(kpFd, Buffer.from(f.kp.buffer, 0, f.kp.byteLength), 0, f.kp.byteLength, offset * 2 * 4);
        meta.push([c.name, c.set, c.number, offset, f.count, h.hi, h.lo]);
        offset += f.count;
      }
    }
    fs.closeSync(descFd); fs.closeSync(kpFd);
    // `lang` in the meta so listBuilds can report a build's language without
    // having to parse it back out of the filename.
    fs.writeFileSync(p.meta, JSON.stringify({ set, lang: code, hashed: true, cards: meta }));
    console.log(`setIndex: ${set} (${code}) indexed ${meta.length} cards`);
    progress[k].status = 'done';
  } catch (e) {
    progress[k] = { ...progress[k], status: 'error', error: e.message };
    throw e;
  }
}

function loadSet(game, set, lang) {
  const k = key(game, set, lang);
  if (cache[k]) return cache[k];
  const p = paths(game, set, lang);
  if (!fs.existsSync(p.meta)) return null;
  const parsed = JSON.parse(fs.readFileSync(p.meta));
  cache[k] = { meta: parsed.cards, hashed: !!parsed.hashed, desc: fs.readFileSync(p.desc), kp: fs.readFileSync(p.kp) };
  return cache[k];
}

// Has this index already tried and failed? A failure is remembered (in progress)
// so it can be reported instead of retried into the ground — see ensureSet.
function buildFailed(game, set, lang) {
  const p = progress[key(game, set, lang)];
  return p && p.status === 'error' ? p.error || 'build failed' : null;
}

// Build (if needed) + load a set index. Concurrent callers share one build.
//
// A remembered failure short-circuits: the scanner polls this once a second while
// it waits, and because a finished build clears `building[k]`, every poll used to
// start a brand-new doomed build — dozens of identical failures per minute against
// someone else's API, with the UI still showing "fetching card list" because each
// restart reset the progress the client was about to read. Retrying is now an
// explicit act (startBuild, i.e. the user pressing Rebuild).
async function ensureSet(game, set, lang, { retry = false } = {}) {
  const k = key(game, set, lang);
  if (loadSet(game, set, lang)) return true;
  if (!retry && buildFailed(game, set, lang)) return false;
  if (!building[k]) {
    building[k] = buildSet(game, set, lang).then(() => { loadSet(game, set, lang); }).catch(e => { console.error('setIndex build failed:', e.message); throw e; }).finally(() => { delete building[k]; });
  }
  try { await building[k]; return !!cache[k]; } catch { return false; }
}

function isReady(game, set, lang) { return !!loadSet(game, set, lang); }

// --- Admin build management ---

// List every persisted set index with card count, on-disk size, and build time.
function listBuilds() {
  if (!fs.existsSync(SETS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SETS_DIR)) {
    // norm() strips every non-alphanumeric from a set code, so the set segment
    // can never contain a dash — which is what makes the optional language
    // segment unambiguous. English builds have no segment at all (they predate
    // languages and keep their original filenames).
    const m = f.match(/^(mtg|pokemon)-([a-z0-9]+)(?:-([a-z]{2}(?:-[a-z]{2})?))?-orb-meta\.json$/);
    if (!m) continue;
    const [, game, normset, fileLang] = m;
    const metaPath = path.join(SETS_DIR, f);
    let cardCount = 0, set = normset, lang = fileLang || 'en';
    try {
      const j = JSON.parse(fs.readFileSync(metaPath));
      cardCount = j.cards.length;
      set = j.set || normset;
      lang = j.lang || lang;
    } catch { continue; }
    const base = metaPath.replace(/-meta\.json$/, '');
    let sizeBytes = 0, builtAt = 0;
    for (const p of [`${base}-desc.bin`, `${base}-kp.bin`, metaPath]) {
      try { const st = fs.statSync(p); sizeBytes += st.size; builtAt = Math.max(builtAt, st.mtimeMs); } catch { /* missing part */ }
    }
    out.push({ key: `${game}|${normset}|${lang}`, game, set, lang, cardCount, sizeBytes, builtAt });
  }
  return out.sort((a, b) => b.builtAt - a.builtAt);
}

// Snapshot of in-flight / recently finished builds, keyed by "game|set|lang".
function getProgress() { return progress; }

// Progress for one set (or null if no build has started/tracked it).
function setProgress(game, set, lang) { return progress[key(game, set, lang)] || null; }

// Delete a build's files and evict it from memory + progress.
function deleteBuild(game, set, lang) {
  const k = key(game, set, lang);
  const p = paths(game, set, lang);
  for (const f of [p.desc, p.kp, p.meta]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  delete cache[k];
  delete progress[k];
}

// Fetch just the printing count for a set (no image downloads) so the UI can
// warn about size before committing to a full build.
async function previewSet(game, set, lang) {
  const code = langOf(lang);
  if (game === 'mtg') {
    const scryfallApi = require('./scryfallApi');
    const r = await scryfallApi.scryGetRetried(mtgSearchUrl(await mtgSetFamilyQuery(set, code), code));
    return r.data.total_cards || (r.data.data ? r.data.data.length : 0);
  }
  if (code !== 'en') {
    // Reuses the fetch above so Preview reports the same clear reason a build
    // would ("listed but no card data in Korean") instead of a bare HTTP 404.
    return (await fetchTcgdexSet(set, code)).length;
  }
  const apiKey = process.env.POKEMON_TCG_API_KEY || '';
  const headers = apiKey ? { 'X-Api-Key': apiKey } : {};
  const r = await http.get('https://api.pokemontcg.io/v2/cards', {
    params: { q: `set.id:${set}`, page: 1, pageSize: 1, select: 'id' }, headers,
  });
  return r.data.totalCount || 0;
}

// Kick off a (re)build without blocking. Concurrent callers share one build;
// evicts any cached copy first so a rebuild reloads fresh from disk.
function startBuild(game, set, lang) {
  const k = key(game, set, lang);
  if (building[k]) return;
  delete cache[k];
  // Explicit user action, so clear any remembered failure and genuinely retry.
  delete progress[k];
  building[k] = buildSet(game, set, lang)
    .then(() => { loadSet(game, set, lang); })
    .catch(e => { console.error('setIndex build failed:', e.message); })
    .finally(() => { delete building[k]; });
}

// Inlier count between query features and a stored card's features.
function inliers(bf, qDescFull, qKp, refDesc, refKp, count) {
  if (count < 4 || qDescFull.rows < 4) return 0;
  const cand = new cv.Mat(count, DESC_BYTES, cv.CV_8U);
  cand.data.set(refDesc.subarray(0, count * DESC_BYTES));
  const knn = new cv.DMatchVectorVector();
  bf.knnMatch(qDescFull, cand, knn, 2);
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
    m.delete(); // embind DMatchVector wrapper; leaks the wasm heap if not freed
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

// Verify a given list of card indices against query ORB features. Runs in a
// worker thread (see scanWorker.js); qDesc is the raw query descriptor bytes
// (Uint8Array, qRows x DESC_BYTES), qKp the query keypoints. Returns scored[].
function verifySlice(game, set, qDesc, qRows, qKp, indices, lang) {
  const idx = loadSet(game, set, lang);
  if (!idx) return [];
  const qMat = new cv.Mat(qRows, DESC_BYTES, cv.CV_8U);
  qMat.data.set(qDesc);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const scored = [];
  try {
    for (const i of indices) {
      if (i < 0 || i >= idx.meta.length) continue;
      const [name, s, number, offset, count] = idx.meta[i];
      const refDesc = idx.desc.subarray(offset * DESC_BYTES, (offset + count) * DESC_BYTES);
      const refKp = new Float32Array(idx.kp.buffer, idx.kp.byteOffset + offset * 2 * 4, count * 2);
      scored.push({ name, set: s, number, inliers: inliers(bf, qMat, qKp, refDesc, refKp, count), score: 0 });
    }
  } finally { bf.delete(); qMat.delete(); }
  return scored;
}

// How many top hash-recall candidates to ORB-verify. Sets at or below this
// verify everything (recall is pointless when it wouldn't shrink the work).
const RECALL_K = 200;

// Hash-recall shortlist: indices of the RECALL_K cards whose stored dHash is
// closest to the query's. Returns all indices if the index has no hashes (legacy
// build) or no query hash was supplied.
function recallIndices(idx, qHash) {
  const total = idx.meta.length;
  if (!idx.hashed || !qHash || total <= RECALL_K) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const scored = new Array(total);
  for (let i = 0; i < total; i++) {
    const m = idx.meta[i];
    scored[i] = [i, hamming(qHash, { hi: m[5] >>> 0, lo: m[6] >>> 0 })];
  }
  scored.sort((a, b) => a[1] - b[1]);
  return scored.slice(0, RECALL_K).map(x => x[0]);
}

// Match query ORB features against a set. q = { desc:Mat, kp:Float32Array }.
// A cheap dHash recall shortlists candidates, then the expensive ORB+RANSAC
// verify runs only on those — fanned out to the worker pool, or inline if the
// pool is disabled (SCAN_WORKERS=0) / errors. qHash is the query's dHash.
async function matchSet(q, game, set, topK = 8, qHash = null, lang) {
  const idx = loadSet(game, set, lang);
  if (!idx) return null;
  const indices = recallIndices(idx, qHash);
  // Copy the query descriptors off the cv heap so they survive + are cloneable.
  const qDesc = new Uint8Array(q.desc.data.subarray(0, q.desc.rows * DESC_BYTES));

  let scored = null;
  try {
    scored = await require('./scanPool').verify(game, set, qDesc, q.desc.rows, q.kp, indices, lang);
  } catch (e) {
    console.warn(`setIndex: pool verify failed, running inline: ${e.message}`);
  }
  if (!scored) {
    scored = [];
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    try {
      for (const i of indices) {
        const [name, s, number, offset, count] = idx.meta[i];
        const refDesc = idx.desc.subarray(offset * DESC_BYTES, (offset + count) * DESC_BYTES);
        const refKp = new Float32Array(idx.kp.buffer, idx.kp.byteOffset + offset * 2 * 4, count * 2);
        scored.push({ name, set: s, number, inliers: inliers(bf, q.desc, q.kp, refDesc, refKp, count), score: 0 });
      }
    } finally { bf.delete(); }
  }
  scored.sort((a, b) => b.inliers - a.inliers);
  // A double-faced card is indexed once per face (same set|number). Collapse to
  // its best-scoring face so one card can't occupy two result slots.
  const seen = new Set();
  const uniq = scored.filter(c => { const k = `${c.set}|${c.number}`; return seen.has(k) ? false : seen.add(k); });
  return uniq.slice(0, topK);
}

module.exports = {
  ensureSet, isReady, buildFailed, matchSet, verifySlice, extractCard, dhash,
  listBuilds, getProgress, setProgress, deleteBuild, previewSet, startBuild,
  // For src/globalIndex.js, which assembles the global ORB index out of these
  // per-set ones (see src/orbUnion.js): it needs to know which sets exist, where
  // each index lives on disk, and the geometry they were all built with.
  listAllSets, paths, CAP, REF_WIDTH,
};
