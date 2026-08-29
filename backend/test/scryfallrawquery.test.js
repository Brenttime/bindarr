// Runnable smoke test for LIVE (catalog) raw Scryfall-syntax searches on
// /api/search (`q` parameter → searchCards({ q })). These are queries that carry
// an operator the stored rows cannot answer (otag:, artist:, t:, ...), so they
// MUST reach Scryfall verbatim — the local cache cannot interpret them — and
// everything else (language suffix, paging, caching, error shapes) must behave
// like the field-based path.
//
// Data-backed queries (is:, color:, set:, rarity:, ...) are a DIFFERENT path:
// they are answered from the card_cache and must not call Scryfall at all. That
// is covered by rawquerylocal.test.js. No framework — plain node + assert, same
// stub shape as scryfallpaging.
// Run: `node test/scryfallrawquery.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.SCRYFALL_GAP_SCALE = '0';
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-scryraw-${process.pid}.db`);
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

const SCRY_PAGE = 175;
const TOTAL = 400;

// db.all is promise-based — no callback to wrap.
const dbAll = (sql, params = []) => db.all(sql, params);

// Stub the axios adapter: serve TOTAL fake cards in 175-card pages for a catalog
// query, and record every (url, params) the app asks for. Like the real adapter
// it REJECTS on 4xx — resolving them would look like success to axios.
let requested = [];
const httpError = (status, data) => {
  const err = new Error('Request failed with status code ' + status);
  err.response = { status, data };
  return err;
};
scryfallApi.client.defaults.adapter = async (config) => {
  const url = new URL(config.url, 'https://api.scryfall.com');
  const page = parseInt(url.searchParams.get('page'), 10) || 1;
  const q = url.searchParams.get('q');
  requested.push({ q, page, include_multilingual: url.searchParams.get('include_multilingual') });
  // A catalog query Scryfall cannot parse (400) and one that matches nothing (404).
  if (q === 'bogus:1') throw httpError(400, { object: 'error', code: 'bad_request', status: 400, details: 'All of your terms were ignored.' });
  if (q && q.includes('nothing99999')) throw httpError(404, { object: 'error', code: 'not_found', status: 404 });
  const start = (page - 1) * SCRY_PAGE;
  const data = [];
  for (let i = start; i < Math.min(start + SCRY_PAGE, TOTAL); i++) {
    data.push({ id: `55f1c8b0-0000-0000-0000-${String(i + 1).padStart(8, '0')}`, name: `Card ${i + 1}`,
      type_line: 'Creature — Beast', rarity: 'common' });
  }
  return { status: 200, statusText: 'OK', headers: {}, config,
    data: { data, has_more: start + SCRY_PAGE < TOTAL, total_cards: TOTAL } };
};

async function main() {
  await db.initDb();

  // 1. A catalog query reaches Scryfall unchanged — no name/number/set surgery,
  //    and the paging parameters are the app's own.
  let r = await scryfallApi.searchCards({ q: 'otag:seed rarity:rare', scope: 'internet', page: 1, limit: 60 });
  assert.strictEqual(r.cards.length, 60);
  assert.strictEqual(r.total, TOTAL);
  assert.strictEqual(r.source, 'scryfall', 'a catalog answer is flagged live');
  assert.strictEqual(requested[0].q, 'otag:seed rarity:rare', 'query must pass through verbatim');
  assert.strictEqual(requested[0].page, 1);

  // 2. A later page walks the same query from the right offset (repeats are
  //    served from the raw-page cache, so the upstream walk does not re-run).
  r = await scryfallApi.searchCards({ q: 'otag:seed rarity:rare', scope: 'internet', page: 2, limit: 60 });
  assert.strictEqual(r.cards.length, 60);
  assert.strictEqual(r.cards[0].name, 'Card 61', 'page 2 must continue where page 1 left off');
  assert.strictEqual(requested[0].q, 'otag:seed rarity:rare');

  // 3. A non-English language scopes the complete raw query, so an `or` in the
  //    query cannot let a different-language branch through.
  requested = [];
  r = await scryfallApi.searchCards({ q: 'otag:a or otag:b', lang: 'ja', scope: 'internet' });
  assert.strictEqual(requested[0].q, '(otag:a or otag:b) lang:ja');
  assert.strictEqual(requested[0].include_multilingual, 'true');

  // 4. Results are cached like any other search: the first card of the result
  //    now has a row in card_cache.
  const cached = await dbAll('SELECT id, language FROM card_cache WHERE id = ?', 'mtg-55f1c8b0-0000-0000-0000-00000001');
  assert.strictEqual(cached.length, 1, 'raw-query results must be cached on the way home');
  assert.strictEqual(cached[0].language, 'Japanese', 'cached under the requested language');

  // 5. Collection scope answers with field filters only — a raw query has no
  //    meaning against "what do I own", so it must not hit the API at all.
  requested = [];
  r = await scryfallApi.searchCards({ q: 'otag:seed', scope: 'collection', userId: 1 });
  assert.deepStrictEqual(r.cards, []);
  assert.strictEqual(requested.length, 0, 'collection scope must not call Scryfall');

  // 6. A valid catalog query matching nothing is an answer (404 upstream → []),
  //    not an error.
  r = await scryfallApi.searchCards({ q: 'otag:nothing99999', scope: 'internet' });
  assert.deepStrictEqual(r.cards, []);
  assert.strictEqual(r.total, null);

  // 7. A query Scryfall itself rejects is a named error the UI can explain
  //    (400 upstream → INVALID_QUERY), not a generic "API is down".
  await assert.rejects(
    () => scryfallApi.searchCards({ q: 'bogus:1', scope: 'internet' }),
    (err) => err.message === 'INVALID_QUERY'
  );

  // 8. Without q nothing changed: the field path still builds its own query.
  requested = [];
  r = await scryfallApi.searchCards({ name: 'Sol Ring', set: 'lea', scope: 'internet' });
  assert.ok(requested.length > 0);
  assert.ok(!requested.some(x => x.q === 'otag:seed rarity:rare'));

  console.log('scryfallrawquery.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
