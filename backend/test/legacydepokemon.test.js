// Regression: the de-Pokemon/graded migration must survive a *real* legacy DB,
// not just a fresh one. The production failure this guards against:
//
//   ALTER TABLE collection DROP COLUMN game
//     -> SQLITE_ERROR: error in index idx_collection_user_game after drop column
//
// SQLite refuses to drop a column that an index still names. A legacy collection
// table carried two user-created indexes that referenced columns this migration
// drops:
//   idx_collection_user_game (user_id, game)
//   idx_collection_cert      (user_id, grader, cert_number)
// The first DROP COLUMN (game) threw, the migration aborted mid-way, and the
// server (which logs and continues on an init error) kept serving on a
// half-migrated schema, re-logging the failure on every restart.
//
// This test builds the legacy shape — the two blocking indexes included — with
// both Pokemon and MTG rows, runs initDb, and asserts the migration completes,
// the columns and indexes are gone, and every MTG row survived.
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-legacy-depokemon-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;
const db = require('../src/db');

function cleanup() {
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

// Build the legacy tables (card_cache + collection, with the two blocking
// indexes and the graded columns) BEFORE initDb runs, so its CREATE TABLE IF
// NOT EXISTS statements are no-ops and the migration has to drop the columns
// out of tables that are not in the new shape.
function buildLegacy() {
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3');
    const conn = new sqlite3.Database(tmpDb, (err) => {
      if (err) return reject(err);
      conn.run(`
        CREATE TABLE card_cache (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          game TEXT,
          set_id TEXT,
          number TEXT,
          language TEXT DEFAULT 'English'
        )
      `, (e0) => {
        if (e0) return reject(e0);
        conn.run(`
          CREATE TABLE collection (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            condition TEXT DEFAULT 'Near Mint',
            printing TEXT DEFAULT 'Normal',
            language TEXT DEFAULT 'English',
            purchase_price REAL,
            favorite INTEGER DEFAULT 0,
            is_trade INTEGER DEFAULT 0,
            list_type TEXT DEFAULT 'collection',
            user_id INTEGER,
            game TEXT,
            grader TEXT,
            grade REAL,
            cert_number TEXT,
            market_value REAL,
            market_value_source TEXT,
            market_value_at DATETIME,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(card_id) REFERENCES card_cache(id)
          )
        `, (e1) => {
          if (e1) return reject(e1);
          conn.run(`CREATE INDEX idx_collection_user_game ON collection(user_id, game)`, (e2) => {
            if (e2) return reject(e2);
            conn.run(`CREATE INDEX idx_collection_cert ON collection(user_id, grader, cert_number)`, (e3) => {
              if (e3) return reject(e3);
              conn.close(() => resolve());
            });
          });
        });
      });
    });
  });
}

async function main() {
  await buildLegacy();

  // One Pokemon card/row (to be removed) and two MTG rows (to survive), all
  // referencing real card_cache ids so the FK holds. game is set explicitly the
  // way production stores it ('mtg' for the survivors, 'pokemon' for the one
  // being dropped) — the migration's delete keys on that.
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-keep-1', 'Lightning Bolt', 'mtg']);
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-keep-2', 'Black Lotus', 'mtg']);
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['pkm-drop', 'Pikachu ex', 'pokemon']);
  await db.run(
    `INSERT INTO collection (card_id, quantity, user_id, game, grader, cert_number, market_value) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['mtg-keep-1', 2, 1, 'mtg', null, null, null]
  );
  await db.run(
    `INSERT INTO collection (card_id, quantity, user_id, game, grader, cert_number, market_value) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['mtg-keep-2', 1, 1, 'mtg', 'PSA', '123456', 42000]
  );
  await db.run(
    `INSERT INTO collection (card_id, quantity, user_id, game, grader, cert_number, market_value) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['pkm-drop', 5, 1, 'pokemon', 'PSA', '654321', 999]
  );

  // The whole point of the test: initDb must migrate this legacy shape
  // without throwing on the index-blocked DROP COLUMN.
  await db.initDb();

  // Columns gone from collection.
  const cols = (await db.all(`PRAGMA table_info(collection)`)).map(c => c.name);
  for (const gone of ['game', 'grader', 'grade', 'cert_number', 'market_value', 'market_value_source', 'market_value_at']) {
    assert.ok(!cols.includes(gone), `${gone} should have been dropped`);
  }
  // game gone from card_cache too.
  const cacheCols = (await db.all(`PRAGMA table_info(card_cache)`)).map(c => c.name);
  assert.ok(!cacheCols.includes('game'), 'card_cache.game should have been dropped');
  // Blocking user-created indexes gone (dropped as part of the column removal).
  const indexNames = (await db.all(`PRAGMA index_list(collection)`))
    .filter(ix => ix.origin === 'c')
    .map(ix => ix.name);
  assert.ok(!indexNames.includes('idx_collection_user_game'), 'idx_collection_user_game should be gone');
  assert.ok(!indexNames.includes('idx_collection_cert'), 'idx_collection_cert should be gone');

  // Rows: Pokemon deleted, MTG kept.
  const rows = await db.all(`SELECT card_id, quantity FROM collection ORDER BY card_id`);
  assert.deepStrictEqual(
    rows,
    [{ card_id: 'mtg-keep-1', quantity: 2 }, { card_id: 'mtg-keep-2', quantity: 1 }],
    'Pokemon rows deleted, MTG rows preserved'
  );
}

main()
  .then(() => {
    console.log('PASS: legacy de-pokemon migration (index-blocked drops)');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  })
  .finally(cleanup);
