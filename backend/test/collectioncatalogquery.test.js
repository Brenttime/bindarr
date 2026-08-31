// Catalog-only collection queries: a raw query containing an operator the
// stored rows cannot answer (otag:, availability:, ...) is resolved LIVE
// against Scryfall, then intersected with the user's owned cards. Pinned here:
// the intersect is by canonical English name (front-face for DFCs, full
// "A // B" for splits), other users' cards never leak in, the answer shape
// is the /api/collection row shape, and the walk is by GAME CARD (the
// upstream query carries unique:cards) with the resolved names persisted to
// collection_query_cache under a CANONICAL language code so a restart does
// not re-walk. The cache is stale-while-revalidate (fresh 6h; complete entries
// serve stale indefinitely with one background revalidation), and a walk cut at its page
// cap is persisted and surfaced as INCOMPLETE rather than silently truncated.
// No framework — plain node + assert, same adapter-stub pattern as
// scryfallrawquery.
// Run: `node test/collectioncatalogquery.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.SCRYFALL_GAP_SCALE = '0';
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-colcatalog-${process.pid}.db`);
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const languages = require('../src/utils/languages');

// The query the test resolves — must be a CATALOG query (unknown operator), so
// the route/evaluator classify it as live-only.
const QUERY = 'otag:sneak';

// What the stubbed Scryfall "returns" for that query. Deliberately mixes:
//  - a card the user owns in the ENGLISH printing (owned via its full name)
//  - a SPLIT card the user owns (owned under the full "A // B" name)
//  - a DFC the user owns (cache stores the FRONT face only; Scryfall returns full)
//  - a card the user does NOT own
//  - a card owned by a DIFFERENT user (must not leak)
const SCRYFALL_MATCHES = [
  { id: 'a1', name: 'Lightning Bolt', type_line: 'Instant', rarity: 'common', set: 'lea', set_name: 'LEA', collector_number: '6', cmc: '1', colors: ['R'], color_identity: ['R'], prices: { usd: '0.50' } },
  { id: 'a2', name: 'Virtue of Loyalty // Ardenvale Fealty', type_line: 'Instant', rarity: 'mythic rare', set: 'mh2', set_name: 'MH2', collector_number: '205', colors: [], color_identity: [], prices: { usd: '3.00' } },
  { id: 'a3', name: 'Delver of Secrets // Insectile Aberration', type_line: 'Creature — Human Wizard', rarity: 'uncommon', set: 'isd', set_name: 'ISD', collector_number: '51', colors: ['U'], color_identity: ['U'], prices: { usd: '1.00' } },
  { id: 'a4', name: 'Black Lotus', type_line: 'Artifact', rarity: 'rare', set: 'lea', set_name: 'LEA', collector_number: '232', colors: [], color_identity: [], prices: { usd: '10000.00' } },
  { id: 'a5', name: 'Somebody Else Bolt', type_line: 'Instant', rarity: 'common', set: 'lea', set_name: 'LEA', collector_number: '7', colors: ['R'], color_identity: ['R'], prices: { usd: '0.10' } },
];

const httpError = (status) => {
  const err = new Error('Request failed with status code ' + status);
  err.response = { status };
  return err;
};
// The walk carries unique:cards (game-card dedup), and a non-English request
// appends lang:xx after the scope. Match both shapes the code produces.
const MATCHES = new Set([
  `${QUERY} unique:cards`,
  `(${QUERY}) unique:cards lang:ja`,
]);
// A second tag for the stale-while-revalidate + completeness sections.
const STALE_QUERY = 'otag:stalewalk';
const STALE_MATCHES = new Set([`${STALE_QUERY} unique:cards`]);
const STALE_RESPONSE = (extra = {}) => ({
  status: 200, statusText: 'OK', headers: {}, config: null,
  data: Object.assign(
    { data: SCRYFALL_MATCHES, has_more: false, total_cards: SCRYFALL_MATCHES.length },
    extra,
  ),
});
let requested = [];
scryfallApi.client.defaults.adapter = async (config) => {
  const url = new URL(config.url, 'https://api.scryfall.com');
  const q = url.searchParams.get('q');
  requested.push({ q });
  if (MATCHES.has(q) || STALE_MATCHES.has(q)) {
    return STALE_RESPONSE();
  }
  throw httpError(404);
};

async function main() {
  await db.initDb();

  // Two users; user 7 owns three cards, user 8 owns one.
  const u7 = await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('u7', 'x', 'member', 'share-u7')`);
  const u8 = await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('u8', 'x', 'member', 'share-u8')`);
  const userId7 = u7.lastID;
  const userId8 = u8.lastID;

  const cacheRow = (id, name, set, set_name, num, rarity, price) =>
    db.run(`INSERT INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, price_trend, price_normal, language)
            VALUES (?, ?, 'MTG', '["Instant"]', '["Instant"]', ?, ?, ?, ?, ?, ?, 'English')`,
      [id, name, rarity, set, set_name, num, price, price]);
  await cacheRow('cca1', 'Lightning Bolt', 'lea', 'LEA', '6', 'Common', 0.5);
  await cacheRow('cca2', 'Virtue of Loyalty // Ardenvale Fealty', 'mh2', 'MH2', '205', 'Mythic Rare', 3.0);
  // DFC: cache stores the FRONT face only (exactly what normalizeCard writes).
  await cacheRow('cca3', 'Delver of Secrets', 'isd', 'ISD', '51', 'Uncommon', 1.0);
  await cacheRow('ccA4', 'Black Lotus', 'lea', 'LEA', '232', 'Rare', 10000.0);
  await cacheRow('ccA5', 'Somebody Else Bolt', 'lea', 'LEA', '7', 'Common', 0.1);

  const own = (userId, cardId, qty) =>
    db.run(`INSERT INTO collection (user_id, card_id, quantity) VALUES (?, ?, ?)`, [userId, cardId, qty]);
  await own(userId7, 'cca1', 4);
  await own(userId7, 'cca2', 1);
  await own(userId7, 'cca3', 2);
  await own(userId7, 'ccA4', 1); // owned, and Scryfall matches it — comes back
  await own(userId8, 'ccA5', 9); // different user's card

  // 1. A catalog query pays exactly ONE upstream walk, walks by game card,
  //    and reports completeness + cache metadata on the answer.
  const first = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  const { cards, total } = first;

  assert.strictEqual(requested.length, 1, 'exactly one Scryfall round trip');
  assert.strictEqual(requested[0].q, `${QUERY} unique:cards`,
    'the walk is by game card, not by printing (verbatim query + unique:cards)');
  assert.strictEqual(total, 4, `expected 4 owned matches, got ${total}`);
  assert.strictEqual(first.complete, true, 'a walk that finished cleanly is complete');
  assert.strictEqual(first.upstreamTotal, SCRYFALL_MATCHES.length, 'the upstream total is surfaced');
  assert.strictEqual(first.cacheStatus, 'resolved', 'this request paid for the walk');
  const names = new Set(cards.map(c => c.name));
  assert.ok(names.has('Lightning Bolt'), 'owned plain card matches by full name');
  assert.ok(names.has('Virtue of Loyalty // Ardenvale Fealty'), 'owned split matches by full "A // B" name');
  assert.ok(names.has('Delver of Secrets'), 'owned DFC matches via front face');
  assert.ok(names.has('Black Lotus'), 'owned card in the match list comes back');
  assert.ok(!names.has('Somebody Else Bolt'), "another user's card must not leak in");

  // Row shape: the /api/collection projection, so tiles render unchanged.
  const bolt = cards.find(c => c.name === 'Lightning Bolt');
  assert.ok(typeof bolt.entry_id === 'number', 'entry_id present and numeric');
  assert.strictEqual(bolt.quantity, 4, 'per-entry quantity');
  assert.strictEqual(bolt.condition, 'Near Mint', 'per-entry condition');
  assert.strictEqual(bolt.set_name, 'LEA');
  assert.strictEqual(bolt.price_trend, 0.5, 'resolved price_trend');
  assert.ok(Array.isArray(bolt.subtypes), 'parseCardRow hydrated the JSON array columns');

  // Language scope: a non-English request wraps the whole query so an `or`
  // inside it cannot let a different-language branch through — the unique:cards
  // dedup rides along, OUTSIDE the language scope.
  requested = [];
  await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7, lang: 'ja' });
  assert.strictEqual(requested[0].q, `(${QUERY}) unique:cards lang:ja`,
    'non-English scopes the full query; unique:cards rides outside the scope');

  // A catalog query that matches nothing upstream is an empty answer, not an
  // error — and the complete empty membership is cached durably.
  requested = [];
  scryfallApi.client.defaults.adapter = async (config) => { throw httpError(404); };
  const none = await scryfallApi.resolveCollectionQuery({ q: 'otag:nosuchtag123', userId: userId7 });
  assert.deepStrictEqual(none.cards, []);
  assert.strictEqual(none.total, 0);
  assert.strictEqual(none.complete, true, 'an empty answer is a valid, complete answer');
  assert.strictEqual(none.upstreamTotal, 0, 'empty answers carry an explicit zero upstream total');
  assert.strictEqual(none.cacheStatus, 'resolved', 'the first 404 resolves a complete empty membership');
  requested = [];
  const noneAgain = await scryfallApi.resolveCollectionQuery({ q: 'otag:nosuchtag123', userId: userId7 });
  assert.strictEqual(noneAgain.cacheStatus, 'fresh', 'a valid empty answer is cached');
  assert.strictEqual(requested.length, 0, 'cached empty answer makes no second upstream request');

  // A bad query (400 upstream) is a fixable-query error, not a silent [].
  requested = [];
  scryfallApi.client.defaults.adapter = async (config) => { throw httpError(400); };
  await assert.rejects(() => scryfallApi.resolveCollectionQuery({ q: 'bogus:1', userId: userId7 }),
    (err) => err.message === 'INVALID_QUERY');

  // 2. The upstream match list is cached per query: a broad tag can be dozens
  //    of rate-limited pages, so re-running it must NOT re-walk them. Restore
  //    the real adapter for these calls.
  scryfallApi.client.defaults.adapter = async (config) => {
    const url = new URL(config.url, 'https://api.scryfall.com');
    const q = url.searchParams.get('q');
    requested.push({ q });
    if (MATCHES.has(q) || STALE_MATCHES.has(q)) return STALE_RESPONSE();
    throw httpError(404);
  };
  requested = [];
  const fresh1 = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  const fresh2 = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  assert.strictEqual(requested.length, 0, 'cached query makes no upstream round trips');
  assert.strictEqual(fresh1.cacheStatus, 'fresh', 'a young cache entry is served without a walk');
  assert.strictEqual(fresh2.cacheStatus, 'fresh');
  assert.strictEqual(fresh2.total, fresh1.total, 'fresh hits still intersect the live collection');

  // But the INTERSECT runs live against the collection every time: a new
  // printing of a matched card, added after the first resolve, must show up.
  await cacheRow('cca1b', 'Lightning Bolt', 'unh', 'UNH', '145', 'Common', 0.4);
  await own(userId7, 'cca1b', 3);
  requested = [];
  const after = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  assert.strictEqual(requested.length, 0, 'still no upstream round trip after the addition');
  assert.ok(after.cards.some(c => c.name === 'Lightning Bolt' && c.set_name === 'UNH' && c.quantity === 3),
    'live intersect sees a card added after the match list was cached');

  // 3. The resolved name set is also persisted to disk (collection_query_cache):
  //    a container restart must be able to serve the walk from the database
  //    instead of re-walking Scryfall. Written per (scoped query, CANONICAL
  //    language code) — absent/'en' collapse to one key, so the same tag in
  //    English never pays for two walks. Names are lowercased, DFC faces
  //    included — exactly what the intersect matches on.
  const persisted = await db.all(
    'SELECT names, expires_at FROM collection_query_cache WHERE query = ? AND lang = ?',
    [QUERY, languages.toCode(null)]
  );
  assert.strictEqual(persisted.length, 1, 'the match list is persisted per scoped query + canonical lang');
  const storedNames = new Set(JSON.parse(persisted[0].names));
  assert.ok(storedNames.has('lightning bolt'), 'persisted names include the matched cards');
  assert.ok(storedNames.has('delver of secrets'), 'DFC front face is persisted (an intersect key)');
  assert.ok(persisted[0].expires_at > Date.now(), 'persisted entry is not already expired');

  // 4. Stale-while-revalidate. The walk above is FRESH (6h window), so aging
  //    the in-memory entry past 6h — still within the 7d stale bound — must
  //    (a) answer from cache WITHOUT blocking, and (b) fire a background
  //    revalidation that refreshes the entry in place (the re-walk itself may
  //    be served from the short-lived raw-page cache — that is correct
  //    behavior, so the observable is the entry's fresh resolvedAt, not the
  //    number of adapter hits).
  const staleKey = `${QUERY}\u0000${languages.toCode(null)}`;
  const freshEntry = scryfallApi.collectionQueryCache.get(staleKey);
  assert.ok(freshEntry, 'the fresh entry is in the in-process cache');
  const staledAt = Date.now() - 12 * 60 * 60 * 1000; // 12h old → stale
  scryfallApi.collectionQueryCache.set(staleKey, { ...freshEntry, resolvedAt: staledAt });
  requested = [];
  const staleServed = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  assert.strictEqual(staleServed.cacheStatus, 'stale',
    'a stale-but-usable entry is served without waiting on the re-walk');
  assert.strictEqual(staleServed.total, after.total, 'the stale answer is the cached names ∩ live collection');
  // Give the background revalidation time to land (bounded).
  for (let i = 0; i < 200 && scryfallApi.collectionQueryCache.get(staleKey).resolvedAt === staledAt; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.notStrictEqual(scryfallApi.collectionQueryCache.get(staleKey).resolvedAt, staledAt,
    'the background revalidation refreshed the entry in place');
  const revalidated = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  assert.strictEqual(revalidated.cacheStatus, 'fresh', 'after the revalidation lands, the entry is fresh again');

  // 5. A COMPLETE durable result serves stale indefinitely. Seed a 30-day-old
  //    disk entry for a query whose raw page has never been fetched, then hold
  //    its provider response open. Two callers must both return immediately and
  //    start exactly one background revalidation.
  const veryOldAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const staleWalkKey = `${STALE_QUERY}\u0000${languages.toCode(null)}`;
  scryfallApi.collectionQueryCache.delete(staleWalkKey);
  await db.run(
    `INSERT INTO collection_query_cache
      (query, lang, names, upstream_total, fetched_count, complete, resolved_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(query, lang) DO UPDATE SET names=excluded.names, complete=1,
       resolved_at=excluded.resolved_at, expires_at=excluded.expires_at`,
    [STALE_QUERY, languages.toCode(null), JSON.stringify(['lightning bolt']), 1, 1,
     veryOldAt, veryOldAt + 7 * 24 * 60 * 60 * 1000]
  );
  let releaseWalk;
  const heldWalk = new Promise(resolve => { releaseWalk = resolve; });
  requested = [];
  scryfallApi.client.defaults.adapter = async (config) => {
    const url = new URL(config.url, 'https://api.scryfall.com');
    const q = url.searchParams.get('q');
    requested.push({ q });
    if (q === `${STALE_QUERY} unique:cards`) {
      await heldWalk;
      return STALE_RESPONSE();
    }
    throw httpError(404);
  };
  const old1 = await scryfallApi.resolveCollectionQuery({ q: STALE_QUERY, userId: userId7 });
  const old2 = await scryfallApi.resolveCollectionQuery({ q: STALE_QUERY, userId: userId7 });
  assert.strictEqual(old1.cacheStatus, 'stale', '30-day complete entry serves without blocking');
  assert.strictEqual(old2.cacheStatus, 'stale', 'concurrent caller also serves stale without joining the walk');
  for (let i = 0; i < 100 && requested.length === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(requested.filter(r => r.q === `${STALE_QUERY} unique:cards`).length, 1,
    'exactly one background revalidation runs');
  releaseWalk();
  for (let i = 0; i < 200 && scryfallApi.collectionQueryCache.get(staleWalkKey).resolvedAt === veryOldAt; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(scryfallApi.collectionQueryCache.get(staleWalkKey).resolvedAt > veryOldAt,
    'background revalidation refreshes the complete entry');

  // 6. A walk cut at its page cap is a PARTIAL answer: persisted and surfaced
  //    as incomplete=true with the upstream total, never as a silent prefix.
  //    (An explicit small `limit` is the cap — the same knob a production
  //    broad tag hits when its match list exceeds the walk budget.)
  scryfallApi.client.defaults.adapter = async (config) => {
    const url = new URL(config.url, 'https://api.scryfall.com');
    requested.push({ q: url.searchParams.get('q') });
    if (url.searchParams.get('q') === 'otag:enormous unique:cards') {
      // Upstream claims 50,000 cards; the walk's cap is reached after one page.
      return STALE_RESPONSE({ has_more: true, total_cards: 50000 });
    }
    throw httpError(404);
  };
  const partial = await scryfallApi.resolveCollectionQuery({ q: 'otag:enormous', userId: userId7, walkLimit: 5 });
  assert.strictEqual(partial.complete, false, 'a cap-cut walk is flagged incomplete');
  assert.strictEqual(partial.upstreamTotal, 50000, 'the upstream total says how much was left behind');
  const partialRow = await db.all(
    'SELECT complete FROM collection_query_cache WHERE query = ? AND lang = ?',
    ['otag:enormous', languages.toCode(null)]
  );
  assert.strictEqual(partialRow.length, 1, 'the partial answer is persisted (the resolved names are real)');
  assert.strictEqual(partialRow[0].complete, 0, '…and persisted as incomplete');

  console.log('collectioncatalogquery.test.js: all assertions passed');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
