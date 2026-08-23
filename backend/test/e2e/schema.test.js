const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

// Point the db module at a throwaway file BEFORE requiring it.
//
// The name is keyed by PID and the file was never cleaned up, so once the OS
// recycled a PID this opened a database from an OLD run — one that already held
// this test's fixture rows — and the inserts below failed on a UNIQUE
// constraint. Rare, entirely dependent on which PID the OS handed out, and it
// looked like a real regression when it finally fired. Start from empty.
const tmpDb = path.join(os.tmpdir(), `bindarr-schema-test-${process.pid}.db`);
try { fs.rmSync(tmpDb, { force: true }); } catch { /* nothing to remove */ }
process.env.DB_PATH = tmpDb;

const db = require('../../src/db');
const { sortCards } = require('../../src/utils/cardSort');

// Setup mock fetchAndCacheSets
const tcgApi = require('../../src/tcgApi');
tcgApi.fetchAndCacheSets = async () => {};

function cleanup() {
  try { db.dbConnection.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

async function runTests() {
  await db.initDb();

  // F2-TC1: Assert that the collection table contains a game column
  try {
    const cols = await db.all(`PRAGMA table_info(collection)`);
    const hasGame = cols.some(c => c.name === 'game');
    assert.ok(hasGame, 'collection table must have game column');
    console.log('PASS: F2-TC1');
  } catch (err) {
    console.error('FAIL: F2-TC1 -', err.message);
    throw err;
  }

  // F2-TC2: Assert that the card_cache table contains a game column
  try {
    const cols = await db.all(`PRAGMA table_info(card_cache)`);
    const hasGame = cols.some(c => c.name === 'game');
    assert.ok(hasGame, 'card_cache table must have game column');
    console.log('PASS: F2-TC2');
  } catch (err) {
    console.error('FAIL: F2-TC2 -', err.message);
    throw err;
  }

  // F2-TC3: Verify that MTG cards are sorted in WUBRG sequence
  try {
    const cards = [
      { name: 'Mountain', types: ['Red'], game: 'mtg' },
      { name: 'Forest', types: ['Green'], game: 'mtg' },
      { name: 'Island', types: ['Blue'], game: 'mtg' },
      { name: 'Plains', types: ['White'], game: 'mtg' },
      { name: 'Swamp', types: ['Black'], game: 'mtg' }
    ];
    // WUBRG: White -> Blue -> Black -> Red -> Green
    const sorted = sortCards(cards, 'type-name', 'normals_first');
    const colorsSorted = sorted.map(c => c.types[0]);
    assert.deepStrictEqual(colorsSorted, ['White', 'Blue', 'Black', 'Red', 'Green'], 'MTG cards must sort in WUBRG order');
    console.log('PASS: F2-TC3');
  } catch (err) {
    console.error('FAIL: F2-TC3 -', err.message);
    throw err;
  }

  // F2-TC6: Verify DB schema migration idempotency
  try {
    // Run initDb again on existing DB
    await db.initDb();
    const cols = await db.all(`PRAGMA table_info(collection)`);
    const gameCols = cols.filter(c => c.name === 'game');
    assert.strictEqual(gameCols.length, 1, 'Should only have one game column even after running initDb twice');
    console.log('PASS: F2-TC6');
  } catch (err) {
    console.error('FAIL: F2-TC6 -', err.message);
    throw err;
  }

  // F2-TC7: Verify multicolor cards sorting order
  try {
    const cards = [
      { name: 'Azorius Card', types: ['White', 'Blue'], game: 'mtg' },
      { name: 'Island', types: ['Blue'], game: 'mtg' },
      { name: 'Boros Card', types: ['Red', 'White'], game: 'mtg' },
      { name: 'Plains', types: ['White'], game: 'mtg' }
    ];
    const sorted = sortCards(cards, 'type-name', 'normals_first');
    // Expected order: Plains (White) -> Island (Blue) -> Azorius Card (Multicolor) -> Boros Card (Multicolor)
    assert.strictEqual(sorted[0].name, 'Plains');
    assert.strictEqual(sorted[1].name, 'Island');
    assert.strictEqual(sorted[2].name, 'Azorius Card');
    assert.strictEqual(sorted[3].name, 'Boros Card');
    console.log('PASS: F2-TC7');
  } catch (err) {
    console.error('FAIL: F2-TC7 -', err.message);
    throw err;
  }

  // F2-TC10: Verify price history handles null/zero values safely
  try {
    await db.run(
      `INSERT INTO card_cache (id, name, game, price_trend) VALUES (?, ?, ?, ?)`,
      ['mtg-c3', 'Promo Lotus', 'mtg', null]
    );
    await db.run(
      `INSERT INTO price_history (card_id, price) VALUES (?, ?)`,
      ['mtg-c3', 0.0]
    );
    const row = await db.get(`SELECT * FROM price_history WHERE card_id = ?`, ['mtg-c3']);
    assert.strictEqual(row.price, 0.0);
    console.log('PASS: F2-TC10');
  } catch (err) {
    console.error('FAIL: F2-TC10 -', err.message);
    throw err;
  }
}

runTests()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch(err => {
    cleanup();
    process.exit(1);
  });
