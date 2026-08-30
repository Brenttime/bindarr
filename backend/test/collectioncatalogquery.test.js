// Catalog-only collection queries: a raw query containing an operator the
// stored rows cannot answer (otag:, availability:, ...) is resolved LIVE
// against Scryfall, then intersected with the user's owned cards. Pinned here:
// the intersect is by canonical English name (front-face for DFCs, full
// "A // B" for splits), other users' cards never leak in, the answer shape
// is the /api/collection row shape, and the walk is by GAME CARD (the
// upstream query carries unique:cards) with the resolved names persisted to
// collection_query_cache so a restart does not re-walk. No framework —
// plain node + assert, same adapter-stub pattern as scryfallrawquery.
// Run: `node test/collectioncatalogquery.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.SCRYFALL_GAP_SCALE = '0';
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-colcatalog-${process.pid}.db`);
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

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
let requested = [];
scryfallApi.client.defaults.adapter = async (config) => {
  const url = new URL(config.url, 'https://api.scryfall.com');
  const q = url.searchParams.get('q');
  requested.push({ q });
  if (MATCHES.has(q)) {
    return { status: 200, statusText: 'OK', headers: {}, config,
      data: { data: SCRYFALL_MATCHES, has_more: false, total_cards: SCRYFALL_MATCHES.length } };
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
  await own(userId7, 'ccA4', 1); // owned, but Scryfall match must not return it (see below)
  await own(userId8, 'ccA5', 9); // different user's card

  // The match list intentionally does NOT include Black Lotus's id again: a4
  // IS Black Lotus, and user 7 owns it — so it should come back. a5 is owned
  // only by user 8 and must not.
  const { cards, total } = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });

  assert.strictEqual(requested.length, 1, 'exactly one Scryfall round trip');
  assert.strictEqual(requested[0].q, `${QUERY} unique:cards`,
    'the walk is by game card, not by printing (verbatim query + unique:cards)');
  assert.strictEqual(total, 4, `expected 4 owned matches, got ${total}`);
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

  // A catalog query that matches nothing upstream is an empty answer, not an error.
  requested = [];
  scryfallApi.client.defaults.adapter = async (config) => { throw httpError(404); };
  const none = await scryfallApi.resolveCollectionQuery({ q: 'otag:nosuchtag123', userId: userId7 });
  assert.deepStrictEqual(none.cards, []);
  assert.strictEqual(none.total, 0);

  // A bad query (400 upstream) is a fixable-query error, not a silent [].
  requested = [];
  scryfallApi.client.defaults.adapter = async (config) => { throw httpError(400); };
  await assert.rejects(() => scryfallApi.resolveCollectionQuery({ q: 'bogus:1', userId: userId7 }),
    (err) => err.message === 'INVALID_QUERY');

  // The upstream match list is cached per query: a broad tag can be dozens of
  // rate-limited pages, so re-running it must NOT re-walk them. Restore the
  // real adapter for these calls.
  scryfallApi.client.defaults.adapter = async (config) => {
    const url = new URL(config.url, 'https://api.scryfall.com');
    const q = url.searchParams.get('q');
    requested.push({ q });
    if (MATCHES.has(q)) {
      return { status: 200, statusText: 'OK', headers: {}, config,
        data: { data: SCRYFALL_MATCHES, has_more: false, total_cards: SCRYFALL_MATCHES.length } };
    }
    throw httpError(404);
  };
  requested = [];
  await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  assert.strictEqual(requested.length, 0, 'cached query makes no upstream round trips');

  // But the INTERSECT runs live against the collection every time: a new
  // printing of a matched card, added after the first resolve, must show up.
  await cacheRow('cca1b', 'Lightning Bolt', 'unh', 'UNH', '145', 'Common', 0.4);
  await own(userId7, 'cca1b', 3);
  requested = [];
  const after = await scryfallApi.resolveCollectionQuery({ q: QUERY, userId: userId7 });
  assert.strictEqual(requested.length, 0, 'still no upstream round trip after the addition');
  assert.ok(after.cards.some(c => c.name === 'Lightning Bolt' && c.set_name === 'UNH' && c.quantity === 3),
    'live intersect sees a card added after the match list was cached');

  // The resolved name set is also persisted to disk (collection_query_cache):
  // a container restart must be able to serve the walk from the database
  // instead of re-walking Scryfall. Written per (scoped query, lang), names
  // lowercased, DFC faces included — exactly what the intersect matches on.
  const persisted = await db.all(
    'SELECT names, expires_at FROM collection_query_cache WHERE query = ? AND lang = ?',
    [QUERY, '']
  );
  assert.strictEqual(persisted.length, 1, 'the match list is persisted per scoped query + lang');
  const storedNames = new Set(JSON.parse(persisted[0].names));
  assert.ok(storedNames.has('lightning bolt'), 'persisted names include the matched cards');
  assert.ok(storedNames.has('delver of secrets'), 'DFC front face is persisted (an intersect key)');
  assert.ok(persisted[0].expires_at > Date.now(), 'persisted entry is not already expired');

  console.log('collectioncatalogquery.test.js: all assertions passed');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
