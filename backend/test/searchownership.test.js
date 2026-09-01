const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const tmpDb = path.join(os.tmpdir(), `bindarr-search-ownership-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const collectionRouter = require('../src/routes/collection');

function searchHandler() {
  const layer = collectionRouter.stack.find(candidate =>
    candidate.route && candidate.route.path === '/search' && candidate.route.methods.get
  );
  assert.ok(layer, 'GET /search route exists');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function jsonResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function callSearch(handler, userId, scope, cards) {
  const res = jsonResponse();
  scryfallApi.searchCards = async () => ({
    cards: cards.map(card => ({ ...card })),
    total: cards.length,
    source: scope === 'internet' ? 'scryfall' : 'cache',
  });
  await handler({
    method: 'GET',
    query: { scope, limit: String(cards.length) },
    user: { id: userId },
  }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function insertCard(id, name, setId = 'tst', number = '1') {
  await db.run(
    `INSERT INTO card_cache (id, name, set_id, number, subtypes, types)
     VALUES (?, ?, ?, ?, '[]', '[]')`,
    [id, name, setId, number]
  );
}

async function main() {
  await db.initDb();
  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token)
     VALUES ('search-owner', 'x', 'member', 'search-owner-share')`
  );
  const other = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token)
     VALUES ('search-other', 'x', 'member', 'search-other-share')`
  );

  const targets = [];
  for (let i = 0; i < 250; i++) {
    let name = `Result Card ${String(i).padStart(3, '0')}`;
    if (i === 0 || i === 1) name = 'Lightning Bolt';
    if (i === 2) name = 'My Custom Card';
    if (i === 3) name = 'Unowned Result';
    const id = `target-${String(i).padStart(3, '0')}`;
    await insertCard(id, name, i === 2 ? 'custom' : 'tst', String(i + 1));
    targets.push({
      id,
      name,
      set: i === 2 ? 'custom' : 'tst',
      collector_number: String(i + 1),
      stable_marker: `marker-${i}`,
    });
  }

  // The same logical card is owned across multiple exact printings and duplicate
  // physical collection rows. Non-positive legacy rows and another tenant do not count.
  await insertCard('owned-bolt-a', 'Lightning Bolt', 'lea', '161');
  await insertCard('owned-bolt-b', 'Lightning Bolt', '2xm', '122');
  await insertCard('owned-custom', 'My Custom Card', 'custom', '99');
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, language) VALUES ('owned-bolt-a', ?, 2, 'Normal', 'English')`, [user.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, language) VALUES ('owned-bolt-b', ?, 3, 'Holofoil', 'Japanese')`, [user.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, language) VALUES ('owned-bolt-b', ?, 4, 'Normal', 'French')`, [user.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing) VALUES ('owned-bolt-a', ?, 0, 'Normal')`, [user.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing) VALUES ('owned-bolt-a', ?, -50, 'Normal')`, [user.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing) VALUES ('owned-bolt-a', ?, 99, 'Normal')`, [other.lastID]);
  await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing) VALUES ('owned-custom', ?, 2, 'Holofoil')`, [user.lastID]);

  // Production-shaped tenant volume: ownership enrichment must aggregate this once,
  // independent of whether the target result has 24, 60, or 250 rows.
  const fillerCount = 20000;
  await db.run(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < ?
    )
    INSERT INTO card_cache (id, name, set_id, number, subtypes, types)
    SELECT printf('owned-fill-%05d', n), printf('Owned Filler %05d', n), 'fill', CAST(n AS TEXT), '[]', '[]'
    FROM seq
  `, [fillerCount]);
  await db.run(`
    INSERT INTO collection (card_id, user_id, quantity, printing)
    SELECT id, ?, 1, 'Normal' FROM card_cache WHERE id LIKE 'owned-fill-%'
  `, [user.lastID]);

  const handler = searchHandler();
  const originalAll = db.all;
  const originalSearch = scryfallApi.searchCards;
  let captured = [];
  db.all = async (sql, params = []) => {
    if (!/^\s*EXPLAIN/i.test(sql) && /\bcollection\s+c\b/i.test(sql) && /owned_qty|\bqty\b/i.test(sql)) {
      captured.push({ sql, params });
    }
    return originalAll(sql, params);
  };

  try {
    let representativeQuery = null;
    for (const size of [24, 60, 250]) {
      captured = [];
      const input = targets.slice(0, size);
      const output = await callSearch(handler, user.lastID, 'database', input);

      assert.strictEqual(output.length, size, `${size} targets retain cardinality`);
      assert.deepStrictEqual(output.map(card => card.id), input.map(card => card.id), `${size} targets retain order`);
      assert.deepStrictEqual(
        output.map(card => card.stable_marker),
        input.map(card => card.stable_marker),
        `${size} targets retain unrelated response fields`
      );
      assert.strictEqual(output[0].owned_qty, 9, 'first Bolt printing receives logical ownership total');
      assert.strictEqual(output[1].owned_qty, 9, 'duplicate target logical name receives the same total');
      assert.strictEqual(output[2].owned_qty, 2, 'custom-card ownership is enriched');
      assert.strictEqual(output[3].owned_qty, 0, 'unowned target is explicitly zero');
      assert.ok(output.slice(4).every(card => card.owned_qty === 0), 'all other unowned targets are zero');

      assert.strictEqual(captured.length, 1, `${size} targets execute one ownership query`);
      assert.ok(captured[0].params.length <= 2,
        `${size} targets must not generate a target-sized placeholder list (got ${captured[0].params.length} params)`);
      assert.ok((captured[0].sql.match(/\?/g) || []).length <= 2,
        `${size} targets must have a constant SQL placeholder count`);
      representativeQuery = captured[0];
    }

    const plan = await originalAll(
      `EXPLAIN QUERY PLAN ${representativeQuery.sql}`,
      representativeQuery.params
    );
    const planText = plan.map(row => row.detail).join('\n');
    assert.match(planText, /MATERIALIZE owned/i,
      `ownership must be materialized once before joining target cards:\n${planText}`);
    const collectionSearches = plan.filter(row => /SEARCH c USING INDEX .*user_id=\?/i.test(row.detail));
    assert.strictEqual(collectionSearches.length, 1,
      `plan must contain one tenant collection search, got ${collectionSearches.length}:\n${planText}`);

    captured = [];
    const internetOutput = await callSearch(handler, user.lastID, 'internet', targets.slice(0, 24));
    assert.strictEqual(captured.length, 1, 'internet scope executes the same single set-wise ownership query');
    assert.strictEqual(internetOutput[0].owned_qty, 9, 'internet results receive logical ownership');
    assert.strictEqual(internetOutput[3].owned_qty, 0, 'internet results retain unowned=0 behavior');

    captured = [];
    const uncachedProviderCards = [
      {
        id: 'provider-uncached-bolt',
        name: 'Lightning Bolt',
        set: 'new',
        collector_number: '1',
      },
      {
        card_id: 'provider-card-id-bolt',
        name: 'Lightning Bolt',
        set: 'new',
        collector_number: '2',
      },
      {
        id: 'physical-collection-row-id',
        card_id: 'owned-custom',
        name: 'Noncanonical Caller Alias',
        set: 'custom',
        collector_number: '99',
      },
      {
        card_id: 'provider-card-id-unowned',
        name: 'Unowned Provider Card',
        set: 'new',
        collector_number: '3',
      },
    ];
    const uncachedOutput = await callSearch(handler, user.lastID, 'internet', uncachedProviderCards);
    assert.strictEqual(captured.length, 1,
      'uncached and card_id-alias targets still execute one set-wise ownership query');
    assert.strictEqual(uncachedOutput[0].owned_qty, 9,
      'an uncached provider printing is enriched from its provider name');
    assert.strictEqual(uncachedOutput[1].owned_qty, 9,
      'an uncached card_id-alias printing is enriched without a cache row');
    assert.strictEqual(uncachedOutput[2].owned_qty, 2,
      'card_id wins over a physical row id and caller-supplied name alias');
    assert.strictEqual(uncachedOutput[3].owned_qty, 0,
      'an unowned uncached card_id alias is explicitly zero');
    assert.deepStrictEqual(
      uncachedOutput.map(card => card.card_id),
      uncachedProviderCards.map(card => card.card_id),
      'card_id aliases and unrelated provider fields are preserved'
    );
    assert.ok(captured[0].params.length <= 2,
      'mixed uncached targets retain a constant ownership-query parameter count');

    captured = [];
    const collectionCards = targets.slice(0, 24).map((card, index) => ({
      ...card,
      owned_qty: index === 0 || index === 1 ? 9 : index === 2 ? 2 : 0,
    }));
    const collectionOutput = await callSearch(handler, user.lastID, 'collection', collectionCards);
    assert.strictEqual(captured.length, 0, 'collection scope performs no redundant ownership query');
    assert.deepStrictEqual(collectionOutput, collectionCards,
      'collection scope preserves owned_qty and every field from collectionQuery');

    // Warm-cache medians over the production-shaped 20k-row tenant fixture.
    const samples = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      await callSearch(handler, user.lastID, 'database', targets);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    assert.ok(medianMs < 200, `250-target ownership median ${medianMs.toFixed(3)}ms must be <200ms`);

    console.log(`PASS: search ownership is set-wise and scope-aware; 250-target median ${medianMs.toFixed(3)}ms`);
    console.log(`PLAN:\n${planText}`);
  } finally {
    db.all = originalAll;
    scryfallApi.searchCards = originalSearch;
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await new Promise(resolve => db.dbConnection.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  });
