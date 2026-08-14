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
// The one place that decides pokemontcg.io vs TCGdex. Every branch below asks it
// rather than re-deriving the answer from the language — see the note in that
// module for what re-deriving it cost.
const pokemonProvider = require('./utils/pokemonProvider');
// scryfallApi/tcgApi are lazy-required inside the build/preview paths only — they
// pull in the DB module, which verify-only worker threads must not load.

const SETS_DIR = process.env.SETS_DIR || path.join(__dirname, '..', 'data', 'sets');
const DESC_BYTES = 32, CAP = 500, REF_WIDTH = 500, RATIO = 0.75, RANSAC_PX = 5.0;

const http = axios.create({ timeout: 30000, headers: { 'User-Agent': 'Bindarr/1.0', 'Accept': 'application/json' } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "This set has no data in this language" — an expected gap, not a failure.
//
// The distinction decides whether a whole build is allowed to finish (see
// globalIndex's failure floor: per-language coverage is patchy, so counting gaps
// as failures makes every non-English build refuse). globalIndex classifies by
// matching phrases in the message, which works but binds a correctness decision
// to the exact wording of a sentence written for a human — reword one of these
// strings, or add a fourth kind of gap, and builds start failing with nothing to
// connect the two. So the ones we raise ourselves say so outright, and the
// phrase matching stays only as the fallback for errors thrown by code that has
// no idea this distinction exists (axios 404s, other modules).
function absent(message) {
  const e = new Error(message);
  e.absent = true;
  return e;
}

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
  const stem = path.join(SETS_DIR, `${game}-${norm(set)}${suffix}`);
  const base = `${stem}-orb`;
  return {
    desc: `${base}-desc.bin`,
    kp: `${base}-kp.bin`,
    meta: `${base}-meta.json`,
    // CLIP vectors for the same cards, written only when a build asks for them
    // (see buildSet's `embed` option). The whole-game recall table is the
    // concatenation of these, exactly as the global ORB index is the
    // concatenation of the desc/kp files. Named off the stem, not the -orb base,
    // because these are not ORB data.
    embed: `${stem}-embed.bin`,
  };
};

// --- cheap on-disk inspection -------------------------------------------
//
// Everything below answers questions ABOUT an index without loading it. That
// distinction is load-bearing: loadSet() pulls a set's whole desc/kp pair into a
// process-wide cache that is never evicted (~5 MB for a big MTG set), which is
// the right trade for the scan path — it is about to match against that set —
// and ruinous for the callers that ENUMERATE sets. globalIndex.coverage() walks
// the entire catalogue, and the admin panel asks for every set's state every
// 1.5 s while a build runs; routed through loadSet that is ~460 sets × 5 MB
// pulled into RAM, on a timer, for two integers per set.

const exists = (f) => { try { return fs.statSync(f).size >= 0; } catch { return false; } };

// Summary of one set's meta file, cached against its mtime+size so a repeated
// poll re-parses only what actually changed. The card ROWS are deliberately not
// kept — a large set's meta is hundreds of KB of JSON and the enumerating
// callers want counts, not contents.
const metaSummaries = new Map();   // meta path -> { stamp, summary }

function readMetaSummary(metaPath) {
  let st;
  try { st = fs.statSync(metaPath); } catch { metaSummaries.delete(metaPath); return null; }
  const stamp = `${st.mtimeMs}|${st.size}`;
  const hit = metaSummaries.get(metaPath);
  if (hit && hit.stamp === stamp) return hit.summary;
  let summary = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath));
    const e = parsed.embed;
    summary = {
      set: parsed.set || null,
      lang: parsed.lang || null,
      cards: Array.isArray(parsed.cards) ? parsed.cards.length : 0,
      embed: e && Array.isArray(e.cards)
        ? { cards: e.cards.length, dim: e.dim, model: e.model, preprocess: e.preprocess }
        : null,
    };
  } catch { summary = null; }   // unreadable/corrupt meta: cache the miss too
  metaSummaries.set(metaPath, { stamp, summary });
  return summary;
}

// Counts and recipe for one set's index, or null if it has none.
function metaSummary(game, set, lang) { return readMetaSummary(paths(game, set, lang).meta); }

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
let scryfallSetsCache = null;
let scryfallSetsCacheAt = 0;
const SCRYFALL_SETS_TTL_MS = 1000 * 60 * 60 * 6;

async function getScryfallSets() {
  if (scryfallSetsCache && (Date.now() - scryfallSetsCacheAt < SCRYFALL_SETS_TTL_MS)) {
    return scryfallSetsCache;
  }
  const scryfallApi = require('./scryfallApi');
  try {
    const r = await scryfallApi.scryGetRetried('https://api.scryfall.com/sets');
    scryfallSetsCache = r.data.data || [];
    scryfallSetsCacheAt = Date.now();
  } catch {
    if (!scryfallSetsCache) scryfallSetsCache = [];
  }
  return scryfallSetsCache;
}

async function getScanExclusions() {
  const db = require('./db');
  try {
    // Deliberately does NOT return the provider. It used to, and callers then
    // made the pokemontcg.io-vs-TCGdex decision themselves from that field —
    // four of them wrongly. utils/pokemonProvider owns that question now, and
    // leaving a second way to ask it here is how the divergence started.
    const row = await db.get(`
      SELECT scan_exclude_tokens, scan_exclude_art_cards, scan_exclude_jumpstart, scan_exclude_promos,
             scan_exclude_digital
      FROM app_settings WHERE id = 1
    `);
    return {
      tokens: !!(row && row.scan_exclude_tokens),
      artCards: !!(row && row.scan_exclude_art_cards),
      jumpstart: !!(row && row.scan_exclude_jumpstart),
      promos: !!(row && row.scan_exclude_promos),
      // The only one that defaults ON — see the column comment in db.js. A
      // missing row must read as excluded, so this cannot use the !! form the
      // others do.
      digital: row ? !!row.scan_exclude_digital : true,
    };
  } catch {
    return { tokens: false, artCards: false, jumpstart: false, promos: false, digital: true };
  }
}

// TCGdex set ids belonging to a digital-only series (Pokémon TCG Pocket), which
// a camera can never be pointed at. See tcgdexApi.DIGITAL_SERIES.
//
// Fails OPEN — an unreachable series endpoint yields an empty set, so the build
// indexes a handful of digital sets it did not need rather than dropping every
// paper set from the catalogue. Getting this backwards would turn one bad request
// into an empty scan index.
async function digitalSetIds(lang) {
  try {
    const tcgdexApi = require('./tcgdexApi');
    const bySet = await tcgdexApi.listSeries(lang);
    const out = new Set();
    for (const [setId, serie] of bySet) {
      if (serie && serie.id === tcgdexApi.DIGITAL_SERIES) out.add(setId);
    }
    return out;
  } catch (e) {
    console.warn(`setIndex: could not list TCGdex series (${e.message}) — not excluding digital sets this time`);
    return new Set();
  }
}

// Does this child set survive the user's scan exclusions? One definition, shared
// by everything that folds children into their parent, so the family a build
// indexes and the family the UI lists can never drift apart.
function childAllowed(s, exclusions, excludeChildCodes = []) {
  if (exclusions.tokens && s.set_type === 'token') return false;
  if (exclusions.artCards && s.set_type === 'memorabilia') return false;
  if (exclusions.jumpstart && s.set_type === 'starter') return false;
  if (exclusions.promos && s.set_type === 'promo') return false;
  return !excludeChildCodes.includes(s.code);
}

const childBrief = (s) => ({
  code: s.code,
  name: s.name,
  cardCount: s.card_count || 0,
  type: s.set_type || 'subset',
});

async function getMtgChildSets(parentCode, { excludeChildCodes = [] } = {}) {
  const sets = await getScryfallSets();
  const target = norm(parentCode);
  const exclusions = await getScanExclusions();
  return sets
    .filter(s => s.parent_set_code && norm(s.parent_set_code) === target && !s.digital)
    .filter(s => childAllowed(s, exclusions, excludeChildCodes))
    .map(childBrief);
}

// Every parent's children in ONE pass, as normalized-parent-code -> children[].
//
// The per-parent call above costs a settings query plus a full scan of the ~900
// entry Scryfall set list. A caller that wants children for every set in the
// catalogue — globalIndex.listSetIndexes, which the admin panel re-fetches every
// 1.5 s during a build — would pay that ~460 times per request. Same answer,
// one query and one pass.
async function getMtgChildSetMap() {
  const [sets, exclusions] = await Promise.all([getScryfallSets(), getScanExclusions()]);
  const map = new Map();
  for (const s of sets) {
    if (!s.parent_set_code || s.digital) continue;
    if (!childAllowed(s, exclusions)) continue;
    const parent = norm(s.parent_set_code);
    const arr = map.get(parent);
    if (arr) arr.push(childBrief(s)); else map.set(parent, [childBrief(s)]);
  }
  return map;
}

// A Scryfall release is split into a parent expansion plus child sets — tokens,
// promos, art series, Commander — each with its own set code (tecl, pecl, ...),
// linked by parent_set_code. Build a query spanning the whole family so "ecl"
// indexes tokens/art/etc., not just the 408 main-set prints. Digital-only sets
// (Alchemy) are skipped — no physical card to scan. include:extras stops Scryfall
// hiding tokens/emblems; -is:digital drops any stray digital print.
async function mtgSetFamilyQuery(set, lang, { excludeChildCodes = [] } = {}) {
  const code = norm(set);
  const codes = new Set([code]);
  const exclusions = await getScanExclusions();
  try {
    const data = await getScryfallSets();
    for (const s of data) {
      // norm() on both sides, matching getMtgChildSets — the UI lists the family
      // from that function and the build queries it from this one, so a
      // difference here means indexing something other than what was shown.
      if (s.parent_set_code && norm(s.parent_set_code) === code && !s.digital
          && childAllowed(s, exclusions, excludeChildCodes)) {
        codes.add(s.code);
      }
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
    const sets = await getScryfallSets();
    return sets
      .filter(s => s.code && !s.digital && !s.parent_set_code && (s.card_count || 0) > 0)
      .map(s => s.code);
  }
  if (game === 'pokemon') {
    const exclusions = await getScanExclusions();
    if (await pokemonProvider.usesTcgdex(code)) {
      const tcgdexApi = require('./tcgdexApi');
      const sets = await tcgdexApi.listSets(code);
      const digital = exclusions.digital ? await digitalSetIds(code) : new Set();
      return sets
        .filter(s => s.id && (s.total || s.printed_total || 0) > 0 && !digital.has(s.id))
        .map(s => s.id);
    }
  }
  // tcgApi.tcgClient, not the bare `http` above: api.pokemontcg.io answers 5xx
  // often enough that a single un-retried GET here would abort a whole multi-hour
  // global build before it indexed anything. That client already retries
  // transients and carries the API key.
  const { tcgClient } = require('./tcgApi');
  try {
    const out = [];
    for (let page = 1; ; page++) {
      const r = await tcgClient.get('/sets', { params: { page, pageSize: 250, select: 'id,total' } });
      const data = r.data.data || [];
      for (const s of data) if (s.id) out.push(s.id);
      if (data.length < 250) break;
    }
    return out;
  } catch (e) {
    console.warn(`setIndex: live pokemontcg.io /sets fetch failed (${e.message}); falling back to local database`);
    const db = require('./db');
    const rows = await db.all("SELECT id FROM sets WHERE game = 'pokemon' OR game IS NULL");
    return rows.map(r => r.id);
  }
}

// Scannable face image(s) for a Scryfall card. Single-image layouts (normal,
// split, flip, adventure, saga) carry one top-level image. Double-faced cards
// (transform, modal DFC, art series, reversible) have no top-level image and one
// distinct image per face — index every face so scanning either side matches.
// Returns [{ img, illustrationId }] — the id lets a recall table keep one vector
// per artwork instead of one per printing, which is what stops a reprint-heavy
// game from bloating the array CLIP has to scan linearly. Each face of a
// double-faced card has its own illustration, so the id is read per face.
function mtgCardImages(c) {
  if (c.image_uris?.normal) return [{ img: c.image_uris.normal, illustrationId: c.illustration_id || null }];
  return (c.card_faces || [])
    .filter(f => f.image_uris?.normal)
    .map(f => ({ img: f.image_uris.normal, illustrationId: f.illustration_id || c.illustration_id || null }));
}

// MTG: page Scryfall for a set family in one language. Returns
// [{ name, set, number, img, raw }], one entry per scannable face (double-faced
// cards yield two, same name/number). `name` is the localized (printed) name when
// there is one, because that is what the post-scan lookup searches Scryfall for —
// verified: `!"稲妻" lang:ja` with include_multilingual finds the card.
async function fetchMtgSet(set, lang, { excludeChildCodes = [] } = {}) {
  const scryfallApi = require('./scryfallApi');
  let url = mtgSearchUrl(await mtgSetFamilyQuery(set, lang, { excludeChildCodes }), lang, '&order=set');
  const cards = [];
  while (url) {
    const r = await scryfallApi.scryGetRetried(url);
    for (const c of r.data.data || []) {
      for (const { img, illustrationId } of mtgCardImages(c)) {
        cards.push({ name: c.printed_name || c.name || '', set: c.set || set, number: c.collector_number || '', img, illustrationId, raw: c });
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
      throw absent(`TCGdex has no ${langName} set "${set}". Set codes differ by language — pick from the ${langName} set list.`);
    }
    throw e;
  }
  const setName = r.data.name || set;
  const all = r.data.cards || [];
  if (!all.length) {
    throw absent(`TCGdex lists "${setName}" (${set}) in ${langName} but has no cards for it yet, so there is nothing to index. Try another set or language.`);
  }
  if (!all.some(c => c.image)) {
    throw absent(`TCGdex has ${all.length} ${langName} cards for "${setName}" (${set}) but no card images, and scanning matches on the art. You can still search and add these cards by name; scanning this set needs another language.`);
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
//
// Also computes each card's CLIP vector from the SAME downloaded buffer and writes
// a per-set embed file. That is what lets code-free scanning search every indexed
// set without downloading any image a second time: the recall table is just the
// concatenation of these per-set files.
//
// On by default, and that default matters: a set indexed WITHOUT embeddings cannot
// take part in code-free scanning, and adding them later means re-downloading every
// image in the set. Making the cheap-but-crippled variant the default would quietly
// leave sets that look indexed but are invisible to a code-free scan. `embed: false`
// exists only for callers that explicitly want the faster, set-scoped-only index.
async function buildSet(game, set, lang, { embed = true, excludeChildCodes = [] } = {}) {
  const k = key(game, set, lang);
  const code = langOf(lang);
  if (game !== 'mtg' && game !== 'pokemon') throw new Error('set index only supports mtg/pokemon');
  fs.mkdirSync(SETS_DIR, { recursive: true });
  progress[k] = { total: 0, done: 0, status: 'fetching', lang: code };
  try {
    console.log(`setIndex: building ${game} ${set} (${code})...`);
    // One decision, read once and reused by BOTH the fetch and the cache below.
    // They used to derive it separately and disagreed: the fetch asked the
    // provider, the cache asked the language.
    const useTcgdex = game === 'pokemon' && await pokemonProvider.usesTcgdex(code);
    const cards = game === 'mtg'
      ? await fetchMtgSet(set, code, { excludeChildCodes })
      : (useTcgdex ? await fetchTcgdexSet(set, code) : await fetchPokemonSet(set));
    if (cards.length === 0) throw absent(`no cards for set ${set}`);
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
      } else if (!useTcgdex) {
        const tcgApi = require('./tcgApi');
        await tcgApi.cacheCards(cards.map(c => c.raw));
      } else {
        // Same `useTcgdex` the fetch used, so the rows are always normalized by
        // the provider that produced them. When this branched on the language
        // instead, TCGdex set briefs went through pokemontcg.io's normalizer,
        // which reads `c.images.large` and `c.number` — fields a TCGdex brief
        // does not have. Every row cached that way named the card correctly and
        // then had no image_url and no number, so a scan matched, added the card,
        // and displayed nothing. 21,828 rows before anyone saw a blank card.
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

    // The embed side is tracked independently of the ORB side: a card whose ORB
    // extraction failed may still embed fine, and vice versa. Sharing one row
    // list would silently misalign the two whenever exactly one of them failed.
    const clip = embed ? require('./utils/clipPreprocess') : null;
    const embedFd = embed ? fs.openSync(p.embed, 'w') : null;
    const embedMeta = [];
    if (clip) await clip.getExtractor(clip.MODEL);   // pay the model load once, not per card

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
          return { card: c, f, h, buf };
        } catch {
          return null;
        }
      }));

      for (const res of results) {
        progress[k].done++;
        if (!res) continue;
        const { card: c, f, h, buf } = res;
        if (f) {
          fs.writeSync(descFd, Buffer.from(f.desc.buffer, 0, f.desc.length), 0, f.desc.length, offset * DESC_BYTES);
          fs.writeSync(kpFd, Buffer.from(f.kp.buffer, 0, f.kp.byteLength), 0, f.kp.byteLength, offset * 2 * 4);
          meta.push([c.name, c.set, c.number, offset, f.count, h.hi, h.lo]);
          offset += f.count;
        }
        // Encoding is serial on purpose: it is CPU-bound on the main thread, and
        // the download concurrency above is what keeps it fed.
        if (clip) {
          try {
            const v = await clip.embedImage(buf, clip.MODEL);
            fs.writeSync(embedFd, Buffer.from(v.buffer, v.byteOffset, v.byteLength), 0, v.byteLength, embedMeta.length * clip.DIM * 4);
            // illustrationId lets the recall table keep one vector per artwork
            // rather than one per printing; null where the provider has no such id.
            embedMeta.push([c.name, c.set, c.number, c.illustrationId || null]);
          } catch (e) {
            console.warn(`setIndex: embed failed for ${c.name} [${c.set}/${c.number}]: ${e.message}`);
          }
        }
      }
    }
    fs.closeSync(descFd); fs.closeSync(kpFd);
    if (embedFd !== null) fs.closeSync(embedFd);
    // `lang` in the meta so listBuilds can report a build's language without
    // having to parse it back out of the filename.
    const metaOut = { set, lang: code, hashed: true, cards: meta };
    if (clip) {
      metaOut.embed = { model: clip.MODEL, dim: clip.DIM, preprocess: clip.PREPROCESS, cards: embedMeta };
    }
    fs.writeFileSync(p.meta, JSON.stringify(metaOut));
    console.log(
      `setIndex: ${set} (${code}) indexed ${meta.length} cards` +
      (clip ? ` + ${embedMeta.length} embeddings` : '')
    );
    progress[k].status = 'done';
  } catch (e) {
    // `absent` rides along with the message: ensureSet swallows the throw and
    // returns false, so this record is the only thing a caller has left to tell
    // an expected gap from a real failure.
    progress[k] = { ...progress[k], status: 'error', error: e.message, absent: e.absent === true };
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

// Does this set's index already carry CLIP vectors? A set built by the on-demand
// scan path has ORB only, so a later global build has to run the embed pass over
// it — which is why ensureSet takes `embed` into account rather than treating any
// existing index as complete.
function hasEmbeddings(game, set, lang) {
  const p = paths(game, set, lang);
  try {
    const bytes = fs.statSync(p.embed).size;
    if (bytes === 0) return false;
    const e = (readMetaSummary(p.meta) || {}).embed;
    if (!e || !e.cards) return false;
    // A vector count that disagrees with the file size means a half-written pass.
    if (bytes !== e.cards * e.dim * 4) return false;
    // Vectors built by a different recipe are not comparable to anything this
    // server can produce, so they do not count as present.
    const clip = require('./utils/clipPreprocess');
    return e.preprocess === clip.PREPROCESS && e.model === clip.MODEL;
  } catch { return false; }
}

// Has this index already tried and failed, and was the failure an expected
// absence? A failure is remembered (in progress) so it can be reported instead
// of retried into the ground — see ensureSet.
function buildFailure(game, set, lang) {
  const p = progress[key(game, set, lang)];
  if (!p || p.status !== 'error') return null;
  return { error: p.error || 'build failed', absent: p.absent === true };
}

// Just the message, for callers that only need to know THAT it failed.
function buildFailed(game, set, lang) {
  const f = buildFailure(game, set, lang);
  return f ? f.error : null;
}

// Build (if needed) + load a set index. Concurrent callers share one build.
//
// A remembered failure short-circuits: the scanner polls this once a second while
// it waits, and because a finished build clears `building[k]`, every poll used to
// start a brand-new doomed build — dozens of identical failures per minute against
// someone else's API, with the UI still showing "fetching card list" because each
// restart reset the progress the client was about to read. Retrying is now an
// explicit act (startBuild, i.e. the user pressing Rebuild).
async function ensureSet(game, set, lang, { retry = false, embed = true } = {}) {
  const k = key(game, set, lang);
  // `embed` raises the bar for "already built": an ORB-only index satisfies a
  // set-scoped scan but not a global recall table, so asking for embeddings on a
  // set that lacks them must rebuild rather than return the existing index.
  const complete = () => !!loadSet(game, set, lang) && (!embed || hasEmbeddings(game, set, lang));
  if (complete()) return true;
  if (!retry && buildFailed(game, set, lang)) return false;
  if (!building[k]) {
    building[k] = buildSet(game, set, lang, { embed })
      .then(() => { delete cache[k]; loadSet(game, set, lang); })
      .catch(e => { console.error('setIndex build failed:', e.message); throw e; })
      .finally(() => { delete building[k]; });
  }
  try { await building[k]; return complete(); } catch { return false; }
}

// Is this set's index usable? Answered from the filesystem, NOT by loading it —
// see the note above readMetaSummary. All three parts must be present because
// loadSet reads all three, so a run that wrote the meta and died before the bins
// is "not ready" rather than a load that throws mid-scan.
function isReady(game, set, lang) {
  if (cache[key(game, set, lang)]) return true;
  const p = paths(game, set, lang);
  try { return fs.statSync(p.meta).size > 0 && exists(p.desc) && exists(p.kp); }
  catch { return false; }
}

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
    const summary = readMetaSummary(metaPath);
    if (!summary) continue;
    const cardCount = summary.cards;
    const set = summary.set || normset;
    const lang = summary.lang || fileLang || 'en';
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
  for (const f of [p.desc, p.kp, p.meta, p.embed]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
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
  // Preview must count the set the BUILD would actually fetch. Branching on the
  // language sent an English/TCGdex preview to pokemontcg.io with a TCGdex set id
  // — a set it does not have — so the count came back 0 and the UI offered to
  // build an empty set. Fourth site to make this mistake; now it asks like the
  // rest of them.
  if (await pokemonProvider.usesTcgdex(code)) {
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
function startBuild(game, set, lang, { excludeChildCodes = [] } = {}) {
  const k = key(game, set, lang);
  if (building[k]) return;
  delete cache[k];
  // Explicit user action, so clear any remembered failure and genuinely retry.
  delete progress[k];
  building[k] = buildSet(game, set, lang, { excludeChildCodes })
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
  ensureSet, isReady, buildFailed, buildFailure, matchSet, verifySlice, extractCard, dhash,
  listBuilds, getProgress, setProgress, deleteBuild, previewSet, startBuild,
  getMtgChildSets, getMtgChildSetMap, getScanExclusions, digitalSetIds,
  // For src/globalIndex.js, which assembles the whole-game indexes out of these
  // per-set ones (src/orbUnion.js for ORB, src/embedUnion.js for CLIP): it needs
  // to know which sets exist, where each index lives, whether a set already
  // carries embeddings, and the geometry they were all built with. metaSummary
  // is how it reports card counts for hundreds of sets without loading any.
  listAllSets, paths, hasEmbeddings, metaSummary, CAP, REF_WIDTH,
};
