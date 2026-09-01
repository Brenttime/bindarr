// The two card_cache query builders (collection scope + local cache).
//
// Pinned here: no language filter in collection scope, leading-zero number
// matching, and the CAST-only-when-numeric guard.
// No framework — plain node + assert. Run: `node test/cardsearchsql.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-searchsql-${process.pid}.db`);
const { collectionQuery, localCacheQuery, numberClause, nameClause } = require('../src/utils/cardSearchSql');

const squash = (s) => s.replace(/\s+/g, ' ').trim();

function testNumberMatching() {
  // Written either way round: "004" must find a stored "4" and vice versa. Only
  // one provider did this before; it is a pure OR, so it can only find more.
  const padded = numberClause('number', '004');
  assert.ok(padded.clause.includes('number = ?'), 'exact form is matched');
  // as typed, zero-stripped, then the numeric CAST comparison
  assert.deepStrictEqual(padded.params, ['004', '4', '004']);

  // A number with no leading zeros needs no stripped variant.
  const plain = numberClause('number', '4');
  assert.strictEqual(plain.params.filter(p => p === '4').length, 2, 'exact + CAST, no redundant stripped term');

  // THE LATENT BUG. SQLite casts any non-numeric string to 0, so
  // CAST('TG12') = CAST('SV49') = 0 — the CAST branch matched every card whose
  // number starts with a letter. It is now only emitted for numeric input.
  const promo = numberClause('number', 'TG12');
  assert.ok(!promo.clause.includes('CAST'), 'no CAST for a non-numeric collector number');
  assert.deepStrictEqual(promo.params, ['TG12'], 'exact match only');

  const numeric = numberClause('number', '25');
  assert.ok(numeric.clause.includes('CAST'), 'CAST still applies where it means something');

  // Fractions (for example 5/64) and hash prefixes (#5) extract the collector number.
  const frac = numberClause('number', '5/64');
  assert.ok(frac.clause.includes('CAST'), 'CAST applies to the numeric part of a fraction');
  assert.deepStrictEqual(frac.params, ['5/64', '5', '5']);

  const hashNum = numberClause('number', '#5');
  assert.deepStrictEqual(hashNum.params, ['#5', '5', '5']);

  // Column name is honoured, so the aliased collection query and the bare local
  // one cannot diverge.
  assert.ok(numberClause('cc.number', '7').clause.includes('cc.number'));

  for (const empty of ['', null, undefined, '   ']) {
    assert.strictEqual(numberClause('number', empty), null, `no clause for ${JSON.stringify(empty)}`);
  }
}

function testNameMatching() {
  // Both columns: `name` is the searchable one, `printed_name` the localized one.
  // One provider's local query checked only `name` before.
  const n = nameClause('', 'Celebi');
  assert.ok(n.clause.includes('name LIKE ?') && n.clause.includes('printed_name LIKE ?'));
  assert.deepStrictEqual(n.params, ['%Celebi%', '%Celebi%']);
  assert.ok(nameClause('cc.', 'x').clause.includes('cc.printed_name'), 'prefix is applied to both columns');
  for (const empty of ['', null, undefined, '  ']) {
    assert.strictEqual(nameClause('', empty), null, `no clause for ${JSON.stringify(empty)}`);
  }
}

function testCollectionScopeIgnoresLanguage() {
  // Collection scope answers "what do I own": you own the card whatever
  // language you own it in, so there is NO language filter here.
  const { sql, params } = collectionQuery({
    userId: 7, name: 'Celebi', number: '004', setList: [], limit: 60, offset: 0,
  });
  assert.ok(!/language/i.test(sql), 'collection scope must NOT filter by language');
  assert.strictEqual((sql.match(/\bcollection\b/g) || []).length, 1,
    'collection search must make one bounded pass over the tenant collection');
  assert.ok(!squash(sql).includes('logical_owned.card_key = LOWER('),
    'logical ownership must not be rejoined to targets by expression');

  assert.strictEqual(params[0], 7, 'userId first');
  assert.strictEqual(params[params.length - 2], 60, 'limit');
  assert.strictEqual(params[params.length - 1], 0, 'offset');
}

function legacyCollectionQuery({ userId, name, number, setList = [], limit, offset }) {
  let sql = `
    WITH logical_owned AS (
      SELECT LOWER(TRIM(COALESCE(owned_cc.name, ''))) AS card_key,
             SUM(owned.quantity) AS owned_qty
      FROM collection owned
      JOIN card_cache owned_cc ON owned.card_id = owned_cc.id
      WHERE owned.user_id = ? AND owned.quantity > 0
      GROUP BY LOWER(TRIM(COALESCE(owned_cc.name, '')))
    )
    SELECT cc.*, logical_owned.owned_qty
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    JOIN logical_owned
      ON logical_owned.card_key = LOWER(TRIM(COALESCE(cc.name, '')))
    WHERE c.user_id = ? AND c.quantity > 0`;
  const params = [userId, userId];
  for (const part of [
    nameClause('cc.', name),
    numberClause('cc.number', number),
    require('../src/utils/setQuery').setSqlFilter(setList, 'cc'),
  ]) {
    if (!part) continue;
    sql += ` AND ${part.clause}`;
    params.push(...part.params);
  }
  sql += ' GROUP BY cc.id LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return { sql, params };
}

function openFixture() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
  const close = () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  return { run, all, close };
}

async function testCollectionResultAndCountParity() {
  const db = openFixture();
  await db.run(`CREATE TABLE card_cache (
    id TEXT PRIMARY KEY, name TEXT, printed_name TEXT, set_id TEXT,
    set_name TEXT, number TEXT, language TEXT
  )`);
  await db.run(`CREATE TABLE collection (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, card_id TEXT, quantity INTEGER
  )`);

  const cards = [
    ['bolt-z', 'Lightning Bolt', null, '2xm', 'Double Masters', '117', 'English'],
    ['bolt-a', 'Lightning Bolt', '稲妻', 'lea', 'Limited Edition Alpha', '161', 'Japanese'],
    ['custom-z', 'Custom Hero', null, 'custom', 'Custom Cards', 'C-1', 'English'],
    ['custom-a', 'Custom Hero', null, 'custom', 'Custom Cards', 'C-2', 'English'],
    ['island-a', 'Island', null, 'lea', 'Limited Edition Alpha', '001', 'English'],
  ];
  for (const card of cards) {
    await db.run(`INSERT INTO card_cache
      (id, name, printed_name, set_id, set_name, number, language)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, card);
  }
  for (const row of [
    [1, 'bolt-a', 2], [1, 'bolt-a', 1], [1, 'bolt-z', 4],
    [1, 'custom-z', 2], [1, 'custom-z', 3], [1, 'custom-a', 1],
    [1, 'island-a', 1], [1, 'island-a', 0],
    [2, 'bolt-a', 100],
  ]) {
    await db.run('INSERT INTO collection (user_id, card_id, quantity) VALUES (?, ?, ?)', row);
  }

  const cases = [
    { name: '', number: '', setList: [] },
    { name: 'Lightning Bolt', number: '', setList: [] },
    { name: '稲妻', number: '', setList: [] },
    { name: '', number: '161', setList: ['lea'] },
    { name: 'Custom Hero', number: '', setList: [] },
  ];
  for (const filters of cases) {
    const args = { userId: 1, ...filters, limit: 100, offset: 0 };
    const before = legacyCollectionQuery(args);
    const after = collectionQuery(args);
    const expected = await db.all(before.sql, before.params);
    const actual = await db.all(after.sql, after.params);
    assert.deepStrictEqual(actual, expected, `result/count parity for ${JSON.stringify(filters)}`);
    assert.strictEqual(actual.length, expected.length, `count parity for ${JSON.stringify(filters)}`);
  }

  const allOwnedQuery = collectionQuery({
    userId: 1, name: '', number: '', setList: [], limit: 100, offset: 0,
  });
  const allOwned = await db.all(allOwnedQuery.sql, allOwnedQuery.params);
  assert.deepStrictEqual(allOwned.map(row => row.id),
    ['bolt-a', 'bolt-z', 'custom-a', 'custom-z', 'island-a'],
    'ordering is stable by printing id, including the final tie-breaker');
  assert.strictEqual(allOwned.filter(row => row.name === 'Lightning Bolt').length, 2,
    'logical cards retain every owned printing rather than picking one preferred printing');
  assert.strictEqual(allOwned.find(row => row.name === 'Lightning Bolt').id, 'bolt-a',
    'stable printing order preserves the deck picker preferred-printing choice');
  assert.ok(allOwned.filter(row => row.name === 'Lightning Bolt').every(row => row.owned_qty === 7),
    'each printing reports the logical total across duplicate entries and printings');

  const narrowedArgs = {
    userId: 1, name: '', number: '161', setList: ['lea'], limit: 100, offset: 0,
  };
  const narrowedQuery = collectionQuery(narrowedArgs);
  const narrowed = await db.all(narrowedQuery.sql, narrowedQuery.params);
  assert.deepStrictEqual(narrowed.map(row => [row.id, row.owned_qty]), [['bolt-a', 7]],
    'set/number narrow the returned printing without narrowing logical ownership');

  const custom = allOwned.filter(row => row.name === 'Custom Hero');
  assert.deepStrictEqual(custom.map(row => [row.id, row.owned_qty]),
    [['custom-a', 6], ['custom-z', 6]],
    'custom cards and duplicate collection rows preserve exact-printing results and logical totals');

  const paged = [];
  for (let offset = 0; offset < allOwned.length; offset += 2) {
    const query = collectionQuery({
      userId: 1, name: '', number: '', setList: [], limit: 2, offset,
    });
    paged.push(...await db.all(query.sql, query.params));
  }
  assert.deepStrictEqual(paged, allOwned, 'stable ordering keeps pagination complete and duplicate-free');
  await db.close();
}

function testLocalCacheKeepsLanguage() {
  // The opposite call, and deliberately so: in the cache, language is part of a
  // printing's identity, so a Japanese search must not be answered with the
  // English row sitting next to it.
  const { sql, params } = localCacheQuery({
    language: 'Japanese', name: '', number: '', setList: [], limit: 60, offset: 0,
  });
  assert.ok(/language = \?/.test(sql), 'local cache MUST filter by language');
  assert.ok(!sql.includes('JOIN'), 'no collection join — this is the plain cache');
  assert.deepStrictEqual(params, ['Japanese', 60, 0]);
}

function testParamOrderMatchesClauseOrder() {
  // The failure this catches is silent and total: parameters binding to the wrong
  // placeholders returns confident nonsense rather than an error.
  const { sql, params } = localCacheQuery({
    language: 'English', name: 'Bolt', number: '007', limit: 5, offset: 10,
  });
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, params.length, `${placeholders} placeholders vs ${params.length} params`);
  assert.deepStrictEqual(params, ['English', '%Bolt%', '%Bolt%', '007', '7', '007', 5, 10]);
}

async function main() {
  testNumberMatching();
  testNameMatching();
  testCollectionScopeIgnoresLanguage();
  testLocalCacheKeepsLanguage();
  testParamOrderMatchesClauseOrder();
  await testCollectionResultAndCountParity();
  console.log('cardsearchsql.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
