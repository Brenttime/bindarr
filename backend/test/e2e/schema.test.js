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

function cleanup() {
  try { db.dbConnection.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

async function runTests() {
  await db.initDb();

  // F2-TC1: The collection table has no game column (single-game app).
  try {
    const cols = await db.all(`PRAGMA table_info(collection)`);
    const hasGame = cols.some(c => c.name === 'game');
    assert.ok(!hasGame, 'collection table must NOT have a game column');
    console.log('PASS: F2-TC1');
  } catch (err) {
    console.error('FAIL: F2-TC1 -', err.message);
    throw err;
  }

  // F2-TC2: The card_cache table has no game column.
  try {
    const cols = await db.all(`PRAGMA table_info(card_cache)`);
    const hasGame = cols.some(c => c.name === 'game');
    assert.ok(!hasGame, 'card_cache table must NOT have a game column');
    console.log('PASS: F2-TC2');
  } catch (err) {
    console.error('FAIL: F2-TC2 -', err.message);
    throw err;
  }

  // F2-TC3: Verify that MTG cards are sorted in WUBRG sequence.
  try {
    const cards = [
      { name: 'Mountain', types: ['Red'], color_identity: ['R'] },
      { name: 'Forest', types: ['Green'], color_identity: ['G'] },
      { name: 'Island', types: ['Blue'], color_identity: ['U'] },
      { name: 'Plains', types: ['White'], color_identity: ['W'] },
      { name: 'Swamp', types: ['Black'], color_identity: ['B'] }
    ];
    // WUBRG: White -> Blue -> Black -> Red -> Green
    const sorted = sortCards(cards, '[{"by":"color","dir":"asc"},{"by":"name","dir":"asc"}]', 'normals_first');
    const colorsSorted = sorted.map(c => c.types[0]);
    assert.deepStrictEqual(colorsSorted, ['White', 'Blue', 'Black', 'Red', 'Green'], 'MTG cards must sort in WUBRG order');
    console.log('PASS: F2-TC3');
  } catch (err) {
    console.error('FAIL: F2-TC3 -', err.message);
    throw err;
  }

  // F2-TC6: Verify DB schema migration idempotency.
  try {
    // Run initDb again on existing DB — no column may be duplicated or
    // resurrected.
    await db.initDb();
    const cols = await db.all(`PRAGMA table_info(collection)`);
    const gradeCols = cols.filter(c => ['grader', 'grade', 'cert_number', 'market_value'].includes(c.name));
    assert.strictEqual(gradeCols.length, 0, 'graded columns must stay removed even after running initDb twice');
    console.log('PASS: F2-TC6');
  } catch (err) {
    console.error('FAIL: F2-TC6 -', err.message);
    throw err;
  }

  // F2-TC7: Verify multicolor cards sorting order.
  try {
    const cards = [
      { name: 'Azorius Card', types: ['White', 'Blue'], color_identity: ['W', 'U'] },
      { name: 'Island', types: ['Blue'], color_identity: ['U'] },
      { name: 'Boros Card', types: ['Red', 'White'], color_identity: ['R', 'W'] },
      { name: 'Plains', types: ['White'], color_identity: ['W'] }
    ];
    const sorted = sortCards(cards, '[{"by":"color","dir":"asc"},{"by":"name","dir":"asc"}]', 'normals_first');
    // Expected order: Plains (White) -> Island (Blue) -> multicolors.
    assert.strictEqual(sorted[0].name, 'Plains');
    assert.strictEqual(sorted[1].name, 'Island');
    assert.ok(['Azorius Card', 'Boros Card'].includes(sorted[2].name));
    assert.ok(['Azorius Card', 'Boros Card'].includes(sorted[3].name));
    console.log('PASS: F2-TC7');
  } catch (err) {
    console.error('FAIL: F2-TC7 -', err.message);
    throw err;
  }

  // F2-TC10: Verify price history handles null/zero values safely.
  try {
    await db.run(
      `INSERT INTO card_cache (id, name, price_trend) VALUES (?, ?, ?)`,
      ['mtg-c3', 'Promo Lotus', null]
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

  // F2-TC11: Upgrade a legacy storage/notes/graded schema without losing card data.
  try {
    await db.run(`CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT)`);
    await db.run(`CREATE TABLE compartments (id INTEGER PRIMARY KEY, location_id INTEGER)`);
    await db.run(`CREATE TABLE compartment_assignments (compartment_id INTEGER, filter_value TEXT)`);
    await db.run(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`);
    await db.run(`ALTER TABLE collection ADD COLUMN location_id INTEGER`);
    await db.run(`ALTER TABLE collection ADD COLUMN compartment_id INTEGER`);
    await db.run(`ALTER TABLE collection ADD COLUMN position REAL DEFAULT 0`);
    await db.run(`INSERT INTO locations (id, name) VALUES (7, 'Legacy binder')`);
    await db.run(`INSERT INTO compartments (id, location_id) VALUES (9, 7)`);
    await db.run(`
      INSERT INTO collection (
        card_id, quantity, condition, printing, language, purchase_price,
        favorite, is_trade, list_type, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'mtg-c3', 2, 'Lightly Played', 'Holofoil', 'English', 12.5,
      1, 1, 'collection', 'keep this per-card note'
    ]);

    await db.initDb();

    const migratedCols = await db.all(`PRAGMA table_info(collection)`);
    for (const removed of ['location_id', 'compartment_id', 'position']) {
      assert.ok(!migratedCols.some(c => c.name === removed), `${removed} should be removed`);
    }
    const remainingStorage = await db.all(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('locations', 'compartments', 'compartment_assignments', 'notes')
    `);
    assert.deepStrictEqual(remainingStorage, [], 'retired storage and notes tables should be removed');

    const migrated = await db.get(`SELECT * FROM collection WHERE card_id = 'mtg-c3'`);
    assert.ok(migrated, 'legacy collection row should survive migration');
    assert.strictEqual(migrated.quantity, 2);
    assert.strictEqual(migrated.condition, 'Lightly Played');
    assert.strictEqual(migrated.printing, 'Holofoil');
    assert.strictEqual(migrated.purchase_price, 12.5);
    assert.strictEqual(migrated.notes, 'keep this per-card note');
    assert.strictEqual((await db.get(`PRAGMA foreign_keys`)).foreign_keys, 1);

    // A partially removed legacy schema must also be cleaned up. Earlier code
    // only looked for `locations`, leaving orphan compartment tables behind.
    await db.run(`CREATE TABLE compartments (id INTEGER PRIMARY KEY)`);
    await db.initDb();
    const orphan = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compartments'`);
    assert.strictEqual(orphan, undefined);
    console.log('PASS: F2-TC11');
  } catch (err) {
    console.error('FAIL: F2-TC11 -', err.message);
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
