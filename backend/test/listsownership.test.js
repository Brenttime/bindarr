const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-lists-ownership-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const listsRouter = require('../src/routes/lists');

function detailHandler() {
  const layer = listsRouter.stack.find(candidate =>
    candidate.route && candidate.route.path === '/:id' && candidate.route.methods.get
  );
  assert.ok(layer, 'GET /:id list-detail route exists');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function jsonResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function getDetail(handler, listId, userId) {
  const res = jsonResponse();
  await handler({ params: { id: String(listId) }, user: { id: userId } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function main() {
  await db.initDb();
  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token)
     VALUES ('list-owner', 'x', 'member', 'list-owner-share')`
  );
  const other = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token)
     VALUES ('other-owner', 'x', 'member', 'other-owner-share')`
  );

  const cards = [
    ['bolt-a', 'Lightning Bolt', 'lea', '161'],
    ['bolt-b', 'Lightning Bolt', '2xm', '122'],
    ['custom-a', 'My Custom Card', 'custom', '1'],
    ['unowned-a', 'Unowned Target', 'tst', '2'],
  ];
  for (const [id, name, setId, number] of cards) {
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, subtypes, types)
       VALUES (?, ?, ?, ?, '[]', '[]')`,
      [id, name, setId, number]
    );
  }

  const list = await db.run(
    `INSERT INTO card_lists (user_id, name, description, accent_color)
     VALUES (?, 'Ownership parity', 'fixture', '#123456')`,
    [user.lastID]
  );
  // Legacy duplicate logical demand split across two physical printings.
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'bolt-a', 2)`, [list.lastID]);
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'bolt-b', 3)`, [list.lastID]);
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'custom-a', 1)`, [list.lastID]);
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'unowned-a', 4)`, [list.lastID]);

  // Ownership is split across printings, finishes, and duplicate collection rows.
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, language)
     VALUES ('bolt-a', ?, 1, 'Normal', 'English')`,
    [user.lastID]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, language)
     VALUES ('bolt-b', ?, 2, 'Holofoil', 'Japanese')`,
    [user.lastID]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, language)
     VALUES ('bolt-b', ?, 4, 'Normal', 'French')`,
    [user.lastID]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing)
     VALUES ('bolt-a', ?, 0, 'Normal')`,
    [user.lastID]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing)
     VALUES ('bolt-a', ?, -20, 'Normal')`,
    [user.lastID]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing)
     VALUES ('bolt-a', ?, 99, 'Normal')`,
    [other.lastID]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing)
     VALUES ('custom-a', ?, 2, 'Holofoil')`,
    [user.lastID]
  );

  const originalAll = db.all;
  let detailQuery = null;
  db.all = async (sql, params = []) => {
    if (!/^\s*EXPLAIN/i.test(sql) && /WITH requested AS/.test(sql) && /owned_qty/.test(sql)) {
      detailQuery = { sql, params };
    }
    return originalAll(sql, params);
  };

  try {
    const handler = detailHandler();
    const detail = await getDetail(handler, list.lastID, user.lastID);
    assert.deepStrictEqual(
      detail.cards.map(card => ({ id: card.id, name: card.name, quantity: card.quantity, owned_qty: card.owned_qty })),
      [
        { id: 'bolt-a', name: 'Lightning Bolt', quantity: 5, owned_qty: 7 },
        { id: 'custom-a', name: 'My Custom Card', quantity: 1, owned_qty: 2 },
        { id: 'unowned-a', name: 'Unowned Target', quantity: 4, owned_qty: 0 },
      ],
      'detail preserves logical-card quantities and sums positive ownership across exact printings'
    );

    const empty = await db.run(
      `INSERT INTO card_lists (user_id, name) VALUES (?, 'Empty list')`,
      [user.lastID]
    );
    const emptyDetail = await getDetail(handler, empty.lastID, user.lastID);
    assert.deepStrictEqual(emptyDetail.cards, [], 'empty lists retain an empty cards array');

    assert.ok(detailQuery, 'list-detail SQL was captured');
    assert.deepStrictEqual(detailQuery.params, [String(empty.lastID), user.lastID],
      'detail query stays bounded to list and tenant parameters');
    const plan = await originalAll(`EXPLAIN QUERY PLAN ${detailQuery.sql}`, detailQuery.params);
    const planText = plan.map(row => row.detail).join('\n');
    assert.doesNotMatch(planText, /CORRELATED SCALAR SUBQUERY/i,
      `ownership must be aggregated once, not rescanned under every requested card:\n${planText}`);
    assert.match(planText, /MATERIALIZE owned/i,
      `ownership should be one materialized tenant aggregate:\n${planText}`);

    // Exercise more requested physical IDs than SQLite's historical 32,766
    // variable ceiling. The route must not turn target IDs into SQL placeholders.
    const large = await db.run(
      `INSERT INTO card_lists (user_id, name) VALUES (?, 'Large target set')`,
      [user.lastID]
    );
    const requestedCount = 32767;
    await db.run(`
      WITH RECURSIVE seq(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM seq WHERE n < ?
      )
      INSERT INTO card_cache (id, name, set_id, number, subtypes, types)
      SELECT printf('bulk-%05d', n), printf('Bulk Card %05d', n), 'bulk', CAST(n AS TEXT), '[]', '[]'
      FROM seq
    `, [requestedCount]);
    await db.run(`
      INSERT INTO list_cards (list_id, card_id, quantity)
      SELECT ?, id, 1 FROM card_cache WHERE id LIKE 'bulk-%'
    `, [large.lastID]);

    detailQuery = null;
    const largeDetail = await getDetail(handler, large.lastID, user.lastID);
    assert.strictEqual(largeDetail.cards.length, requestedCount,
      'list detail supports target sets above the SQLite variable ceiling');
    assert.ok(detailQuery);
    assert.strictEqual(detailQuery.params.length, 2,
      'large target sets do not generate target-sized placeholder lists');

    console.log('PASS: list-detail ownership is set-wise, logically correct, and variable-limit safe');
  } finally {
    db.all = originalAll;
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
