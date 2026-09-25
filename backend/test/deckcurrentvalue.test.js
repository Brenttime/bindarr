// GET /api/decks/:id must report BOTH value axes: the cheapest-printings floor
// (minimum_value, already asserted in test/e2e/deck-value.test.js) and the
// current-printings value — each deck copy priced at its OWN cached printing.
// Temp DB + the real router, same convention as listminimumvalue.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `scrybox-deckcur-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const decksRouter = require('../src/routes/decks');

function routeHandler(method, routePath) {
  const layer = decksRouter.stack.find(candidate =>
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

async function main() {
  await db.initDb();
  const owner = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES ('cur-owner','x','member','tok1')`);

  // One logical card with two printings at different prices: the deck holds
  // FOUR copies of the expensive reprint (6.00) while a cheaper printing of
  // the same name (2.00) sits in the cache unused. A second logical card has
  // no price on record at all.
  for (const [id, name, set, num] of [
    ['cur-dear',  'Bolt Twofer', 'seta', '11'],
    ['cur-cheap', 'Bolt Twofer', 'setb', '22'],
    ['cur-none',  'No Price Any', 'setc', '33'],
  ]) {
    await db.run(
      `INSERT INTO card_cache (id, name, set_id, number, subtypes, types) VALUES (?, ?, ?, ?, '[]', '[]')`,
      [id, name, set, num]);
  }
  await db.run(`UPDATE card_cache SET price_normal=6.00 WHERE id='cur-dear'`);
  await db.run(`UPDATE card_cache SET price_normal=2.00 WHERE id='cur-cheap'`);

  const deck = await db.run(`INSERT INTO decks (user_id, name) VALUES (?, 'Value Deck')`, [owner.lastID]);
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'cur-dear', 4)`, [deck.lastID]);
  await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'cur-none', 1)`, [deck.lastID]);

  const handler = routeHandler('get', '/:id');
  const res = { params: { id: String(deck.lastID) }, user: { id: owner.lastID } };
  const out = jsonResponse();
  await handler(res, out);

  assert.strictEqual(out.statusCode, 200, JSON.stringify(out.body));
  const body = out.body;

  // Current printings: 4 x 6.00, the unpriced single copy counted aside.
  assert.strictEqual(Number(body.current_printing_value), 24.0,
    `own-printing total prices every copy at its own cached price: ${body.current_printing_value}`);
  assert.strictEqual(Number(body.current_unpriced_cards), 1,
    `unpriced copies counted aside like the floor does: ${body.current_unpriced_cards}`);

  // Cheapest floor: 4 x 2.00 from the cheaper printing of the same logical card.
  assert.strictEqual(Number(body.minimum_value), 8.0,
    `cheapest floor unchanged and lower than the current value: ${body.minimum_value}`);
  assert.strictEqual(Number(body.unpriced_cards), 1);

  // Per-card view: the priced row carries both axes, the unpriced row is
  // honestly null rather than 0.
  const bolt = body.cards.find(c => c.name === 'Bolt Twofer');
  assert.ok(bolt, 'deck card present in detail');
  assert.strictEqual(Number(bolt.current_price), 6.0, 'current_price is the deck row OWN printing');
  assert.strictEqual(Number(bolt.cheapest_price), 2.0, 'cheapest_price is the logical card cheapest printing');
  assert.strictEqual(Number(bolt.quantity), 4);
  const free = body.cards.find(c => c.name === 'No Price Any');
  assert.ok(free, 'unpriced deck card present');
  assert.strictEqual(free.current_price, null, 'no own-printing price yields null');
  assert.strictEqual(free.cheapest_price, null, 'no cached price yields null');

  console.log('PASS: deck current-printings value vs cheapest floor');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await new Promise(resolve => db.dbConnection.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  });