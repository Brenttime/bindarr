// Minimum value + cheapest-printing rewrite for card lists. Temp DB, fake-in-
// SPI style not needed — this uses DB_PATH + the real router, like
// listsownership.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-listmin-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const listsRouter = require('../src/routes/lists');

function routeHandler(method, routePath) {
  const layer = listsRouter.stack.find(candidate =>
    candidate.route && candidate.route.path === routePath && candidate.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function jsonResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function call(handler, params, user, body = {}) {
  const res = jsonResponse();
  await handler({ params, body, user: { id: user } }, res);
  return res;
}

async function main() {
  await db.initDb();
  const owner = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES ('min-owner','x','member','tok1')`);
  const stranger = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES ('min-other','x','member','tok2')`);

  // One logical card with three cached USD printings: cheapest is 'cheap-1' at
  // 1.50; 'mid-1' at 3.00 is where the list starts. A second logical card has
  // NO priced printing; a third has prices only in a non-USD currency.
  const cards = [
    ['cheap-1', 'Cheap Bolt', 'one', '11', 1.5, 6.0, 5.0, 2.0],
    ['mid-1',   'Cheap Bolt', 'two', '22', 3.0, 3.5, 3.2, 3.1],
    ['dear-1',  'Cheap Bolt', 'thr', '33', 9.0, 9.1, 9.2, 9.3],
    ['plain-a', 'No Price Any', 'pnp', '1', null, null, null, null],
    ['euro-b',  'Euro Only', 'eur', '2', null, null, null, null],
  ];
  await db.run(`UPDATE card_cache SET price_currency='EUR' WHERE 0`); // no-op guard
  for (const [id, name, set, num] of cards) {
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, subtypes, types) VALUES (?, ?, ?, ?, '[]', '[]')`,
      [id, name, set, num]);
  }
  await db.run(`UPDATE card_cache SET price_normal=1.50, price_holofoil=6.00, price_etched=5.00, price_trend=2.00 WHERE id='cheap-1'`);
  await db.run(`UPDATE card_cache SET price_normal=3.00, price_trend=3.10 WHERE id='mid-1'`);
  await db.run(`UPDATE card_cache SET price_normal=9.00 WHERE id='dear-1'`);
  await db.run(`UPDATE card_cache SET price_currency='EUR', price_normal=2.00 WHERE id='euro-b'`);

  const list = await db.run(
    `INSERT INTO card_lists (user_id, name, description, accent_color) VALUES (?, 'Buy list', 'x', '#10b981')`,
    [owner.lastID]);
  const foreign = await db.run(
    `INSERT INTO card_lists (user_id, name) VALUES (?, 'Someone else')`, [stranger.lastID]);
  // starts on the mid printing (3 rows) + an unpriced card (1) + a EUR-only one (1)
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'mid-1', 3)`, [list.lastID]);
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'plain-a', 1)`, [list.lastID]);
  await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'euro-b', 1)`, [list.lastID]);

  const getOne = routeHandler('get', '/:id');
  const getList = routeHandler('get', '/');
  const putCheapest = routeHandler('put', '/:id/cheapest-printings');

  // --- minimum value on the list-page rows ---
  const listRes = await call(getList, {}, owner.lastID);
  assert.strictEqual(listRes.statusCode, 200);
  const row = listRes.body.find(l => l.id === list.lastID);
  assert.strictEqual(Number(row.minimum_value), 4.5, `floor sums cheapest USD printings (every cached printing, 3x1.50): ${row.minimum_value}`);
  assert.strictEqual(row.minimum_value_currency, 'USD');
  assert.strictEqual(row.unpriced_cards, 2, 'unpriced + non-USD cards counted aside');
  assert.strictEqual(row.unpriced_card_types, 2);

  // --- minimum value on the detail ---
  const detail = await call(getOne, { id: String(list.lastID) }, owner.lastID);
  assert.strictEqual(detail.statusCode, 200);
  assert.strictEqual(Number(detail.body.minimum_value), 4.5, 'detail carries the same floor as the list row');

  // --- foreign list: 404 before any rewrite ---
  const foreignRes = await call(putCheapest, { id: String(foreign.lastID) }, owner.lastID);
  assert.strictEqual(foreignRes.statusCode, 404);

  // --- rewrite ---
  const swap = await call(putCheapest, { id: String(list.lastID) }, owner.lastID);
  assert.strictEqual(swap.statusCode, 200, JSON.stringify(swap.body));
  assert.strictEqual(swap.body.moved, 1, 'only the misaligned logical card moves');

  const rows = await db.all(`SELECT card_id, quantity FROM list_cards WHERE list_id = ? ORDER BY card_id`, [list.lastID]);
  assert.deepStrictEqual(rows, [
    { card_id: 'cheap-1', quantity: 3 },  // folded onto cheapest, quantity preserved
    { card_id: 'euro-b', quantity: 1 },   // non-USD price alone: left alone
    { card_id: 'plain-a', quantity: 1 },  // no price on record: left alone
  ], 'rewrite keeps total copies');

  // floor refreshed: 3x cheapest (1.5) = 4.5, still two unpriced types
  const detail2 = await call(getOne, { id: String(list.lastID) }, owner.lastID);
  assert.strictEqual(Number(detail2.body.minimum_value), 4.5);
  assert.strictEqual(detail2.body.unpriced_cards, 2);

  // --- idempotent: rerun changes nothing ---
  const again = await call(putCheapest, { id: String(list.lastID) }, owner.lastID);
  assert.strictEqual(again.body.moved, 0);
  const rows2 = await db.all(`SELECT card_id, quantity FROM list_cards WHERE list_id = ? ORDER BY card_id`, [list.lastID]);
  assert.deepStrictEqual(rows2, rows, 'rerun is a no-op');

  console.log('PASS: list minimum value and cheapest-printing rewrite');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(resolve => db.dbConnection.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  });