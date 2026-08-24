// Regression: the de-Pokemon/graded migration must survive a *real* legacy DB,
// not just a fresh one.
//
// Production failures this guards against (all reproduced against legacy shapes
// before the fix):
//
//   1. ALTER TABLE collection DROP COLUMN game
//        -> SQLITE_ERROR: error in index idx_collection_user_game after drop column
//      SQLite refuses to drop a column an index still names. The legacy
//      collection carried idx_collection_user_game and idx_collection_cert.
//
//   2. DELETE FROM card_cache WHERE game = 'pokemon'
//        -> SQLITE_CONSTRAINT: FOREIGN KEY constraint failed
//      tcgplayer_product.card_id is an FK to card_cache without CASCADE, so its
//      rows blocked the cache-row delete.
//
//   3. Rebuild of set_data_gaps without a game filter
//        -> SQLITE_CONSTRAINT: UNIQUE constraint failed
//      the old key (game, language, set_id) allowed the same language+set_id in
//      both games; the new key (language, set_id) collides on both.
//
// Plus the leaks that did not throw but left Pokemon data behind:
//      - app_settings.tcgcsv_prices_swept_at surviving the sweep
//      - price_history rows for deleted Pokemon cards (no FK)
//      - card_cache.price_reverse_holofoil / price_1st_edition surviving
//      - Pokemon set_data_gaps rows surviving into the MTG-only table
//
// The test builds the legacy shape with a throwaway connection, CLOSES it, and
// only then requires db (which opens the file a second time) — building while
// db was already open raced on the write lock (intermittent SQLITE_BUSY).
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-legacy-depokemon-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.DEFAULT_ADMIN_PASSWORD;

function cleanup() {
  const db = typeof dbRef === 'object' && dbRef ? dbRef : null;
  if (db) { try { db.dbConnection.close(); } catch { /* already closed */ } }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

// Build the pre-removal schema the way it actually looked on old installs,
// including every dependency the migration has to resolve: the two blocking
// collection indexes, the FK-child tcgplayer_product table, the colliding
// set_data_gaps rows, the dead provider settings, and orphaned price history.
function buildLegacy() {
  return new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3');
    const conn = new sqlite3.Database(tmpDb, (err) => {
      if (err) return reject(err);
      const stmts = [
        `CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT DEFAULT 'member',
          share_token TEXT,
          share_enabled INTEGER DEFAULT 0,
          psa_api_token TEXT,
          graded_price_api_key TEXT,
          tcg_api_key TEXT
        )`,
        `CREATE TABLE sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          expires_at DATETIME NOT NULL
        )`,
        `CREATE TABLE app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          public_base_url TEXT DEFAULT '',
          pokemon_provider TEXT DEFAULT 'tcgdex',
          pokemon_prices_swept_at DATETIME,
          tcgdex_prices_swept_at DATETIME,
          tcgcsv_prices_swept_at DATETIME,
          scan_exclude_digital INTEGER NOT NULL DEFAULT 1
        )`,
        `INSERT INTO app_settings (id, public_base_url) VALUES (1, '')`,
        `CREATE TABLE sets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          series TEXT,
          printed_total INTEGER,
          total INTEGER,
          release_date TEXT,
          ptcgo_code TEXT,
          symbol_url TEXT,
          logo_url TEXT,
          game TEXT
        )`,
        // Legacy card_cache: the Pokemon finishes, the rolling averages and
        // the game column all present.
        `CREATE TABLE card_cache (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          supertype TEXT,
          subtypes TEXT,
          types TEXT,
          rarity TEXT,
          set_id TEXT,
          set_name TEXT,
          number TEXT,
          image_url TEXT,
          price_trend REAL,
          price_normal REAL,
          price_holofoil REAL,
          price_reverse_holofoil REAL,
          price_avg1 REAL,
          price_avg7 REAL,
          price_avg30 REAL,
          price_1st_edition REAL,
          price_currency TEXT DEFAULT 'USD',
          price_source TEXT,
          cmc REAL,
          color_identity TEXT,
          language TEXT DEFAULT 'English',
          printed_name TEXT,
          tcgplayer_product_id INTEGER,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
          game TEXT
        )`,
        // Legacy collection: graded columns (grader with its real CHECK) plus
        // the two user-created indexes that block the DROP COLUMN.
        `CREATE TABLE collection (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id TEXT NOT NULL,
          quantity INTEGER DEFAULT 1,
          condition TEXT CHECK(condition IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')) DEFAULT 'Near Mint',
          printing TEXT CHECK(printing IN ('Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo')) DEFAULT 'Normal',
          language TEXT DEFAULT 'English',
          purchase_price REAL,
          favorite INTEGER DEFAULT 0,
          is_trade INTEGER DEFAULT 0,
          list_type TEXT DEFAULT 'collection',
          notes TEXT DEFAULT '',
          user_id INTEGER,
          game TEXT,
          grader TEXT CHECK(grader IN ('Raw','PSA','BGS','CGC','SGC','TAG')) DEFAULT 'Raw',
          grade REAL,
          cert_number TEXT,
          market_value REAL,
          market_value_source TEXT,
          market_value_at DATETIME,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(card_id) REFERENCES card_cache(id)
        )`,
        `CREATE INDEX idx_collection_user_game ON collection(user_id, game)`,
        `CREATE INDEX idx_collection_cert ON collection(user_id, grader, cert_number)`,
        // The FK child that made the card_cache delete fail.
        `CREATE TABLE tcgplayer_product (
          card_id TEXT PRIMARY KEY,
          product_id INTEGER NOT NULL,
          category_id INTEGER NOT NULL,
          confidence REAL DEFAULT 1,
          matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(card_id) REFERENCES card_cache(id)
        )`,
        `CREATE INDEX idx_tcgplayer_product_pid ON tcgplayer_product(product_id)`,
        `CREATE TABLE tcgplayer_catalog (
          product_id INTEGER PRIMARY KEY,
          set_id TEXT,
          card_number TEXT,
          game TEXT
        )`,
        `CREATE INDEX idx_tcgplayer_catalog_pid ON tcgplayer_catalog(product_id)`,
        `CREATE TABLE psa_cert (
          cert_number TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        // Old 3-column gap table with the colliding namespace: both games have
        // a gap for (English, me1).
        `CREATE TABLE set_data_gaps (
          game TEXT NOT NULL,
          language TEXT NOT NULL,
          set_id TEXT NOT NULL,
          reason TEXT,
          seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (game, language, set_id)
        )`,
        `CREATE TABLE price_history (
          card_id TEXT NOT NULL,
          price REAL NOT NULL,
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(card_id, recorded_at)
        )`,
        `CREATE TABLE decks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          checked_out INTEGER DEFAULT 0,
          checked_out_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          game TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE card_lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          game TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )`,
        // Legacy data.
        `INSERT INTO sets (id, name, game) VALUES
          ('mtg-ald', 'Alpha', 'mtg'),
          ('pkm-bas', 'Base', 'pokemon')`,
        `INSERT INTO card_cache (id, name, set_id, set_name, number, language, game,
          price_trend, price_normal, price_holofoil, price_reverse_holofoil, price_1st_edition)
         VALUES
          ('mtg-keep-1', 'Lightning Bolt', 'ald', 'Alpha', '82', 'English', 'mtg', 5, 5, 9, NULL, NULL),
          ('mtg-keep-2', 'Black Lotus', 'ald', 'Alpha', '1', 'English', 'mtg', 3000, 3000, 4000, 999, 9000),
          ('pkm-drop', 'Pikachu ex', 'bas', 'Base', '1', 'English', 'pokemon', 12, 12, 20, 7, 500)`,
        `INSERT INTO tcgplayer_product (card_id, product_id, category_id)
         VALUES ('pkm-drop', 42, 3)`,
        `INSERT INTO tcgplayer_catalog (product_id, set_id, card_number, game)
         VALUES (42, 'bas', '1', 'pokemon')`,
        `INSERT INTO psa_cert (cert_number, payload)
         VALUES ('654321', '{"card":"pkm-drop","grade":9}')`,
        `INSERT INTO set_data_gaps (game, language, set_id, reason) VALUES
          ('mtg', 'English', 'me1', 'no cards'),
          ('pokemon', 'English', 'me1', 'no cards')`,
        // One real price point, one orphan (its card is about to be deleted).
        `INSERT INTO price_history (card_id, price) VALUES ('mtg-keep-1', 5), ('pkm-orphan', 1)`,
        `INSERT INTO collection (card_id, quantity, user_id, game, grader, cert_number, market_value)
         VALUES
          ('mtg-keep-1', 2, NULL, 'mtg', 'Raw', NULL, NULL),
          ('mtg-keep-2', 1, NULL, 'mtg', 'PSA', '123456', 42000),
          ('pkm-drop', 5, NULL, 'pokemon', 'PSA', '654321', 999)`,
      ];
      let i = 0;
      const next = (err) => {
        if (err) { conn.close(() => reject(err)); return; }
        if (i >= stmts.length) { conn.close(() => resolve()); return; }
        conn.run(stmts[i++], next);
      };
      next(null);
    });
  });
}

let dbRef = null;

async function main() {
  // Build and fully close BEFORE requiring db, so the two connections never
  // hold the write lock at the same time.
  await buildLegacy();

  const db = require('../src/db');
  dbRef = db;

  // The whole point of the test: initDb must migrate this legacy shape without
  // an FK, index or primary-key collision.
  await db.initDb();

  const colsOf = async (table) =>
    (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);
  const tableGone = async (name) =>
    !(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));

  // --- collection: columns, indexes, rows ---------------------------------
  const cCols = await colsOf('collection');
  for (const gone of ['game', 'grader', 'grade', 'cert_number', 'market_value',
    'market_value_source', 'market_value_at']) {
    assert.ok(!cCols.includes(gone), `collection.${gone} should have been dropped`);
  }
  const cIndexes = (await db.all(`PRAGMA index_list(collection)`))
    .filter(ix => ix.origin === 'c').map(ix => ix.name);
  assert.ok(!cIndexes.includes('idx_collection_user_game'), 'blocking index should be gone');
  assert.ok(!cIndexes.includes('idx_collection_cert'), 'blocking index should be gone');
  assert.deepStrictEqual(
    await db.all(`SELECT card_id, quantity FROM collection ORDER BY card_id`),
    [{ card_id: 'mtg-keep-1', quantity: 2 }, { card_id: 'mtg-keep-2', quantity: 1 }],
    'Pokemon collection rows deleted, MTG rows preserved'
  );

  // --- card_cache: Pokemon finishes gone, MTG price data kept --------------
  const ccCols = await colsOf('card_cache');
  for (const gone of ['game', 'price_reverse_holofoil', 'price_1st_edition']) {
    assert.ok(!ccCols.includes(gone), `card_cache.${gone} should have been dropped`);
  }
  for (const kept of ['price_avg1', 'price_avg7', 'price_avg30', 'price_holofoil']) {
    assert.ok(ccCols.includes(kept), `card_cache.${kept} should be kept`);
  }
  assert.deepStrictEqual(
    await db.all(`SELECT id FROM card_cache ORDER BY id`),
    [{ id: 'mtg-keep-1' }, { id: 'mtg-keep-2' }],
    'Pokemon cache rows deleted, MTG rows preserved'
  );

  // --- sets / decks / card_lists: no game column, no Pokemon rows -----------
  for (const t of ['sets', 'decks', 'card_lists']) {
    assert.ok(!(await colsOf(t)).includes('game'), `${t}.game should be dropped`);
  }
  assert.deepStrictEqual(await db.all(`SELECT id FROM sets`), [{ id: 'mtg-ald' }],
    'Pokemon set deleted');

  // --- the FK child table ---------------------------------------------------
  assert.ok(await tableGone('tcgplayer_product'), 'tcgplayer_product table should be dropped');
  assert.ok(await tableGone('tcgplayer_catalog'), 'tcgplayer_catalog table should be dropped');
  assert.ok(await tableGone('psa_cert'), 'psa_cert table should be dropped');

  // --- users ----------------------------------------------------------------
  const uCols = await colsOf('users');
  for (const gone of ['psa_api_token', 'graded_price_api_key', 'tcg_api_key']) {
    assert.ok(!uCols.includes(gone), `users.${gone} should be dropped`);
  }
  assert.ok(uCols.includes('api_key'), 'users.api_key should be added');

  // --- app_settings ---------------------------------------------------------
  const sCols = await colsOf('app_settings');
  for (const gone of ['pokemon_provider', 'pokemon_prices_swept_at',
    'tcgdex_prices_swept_at', 'tcgcsv_prices_swept_at', 'scan_exclude_digital']) {
    assert.ok(!sCols.includes(gone), `app_settings.${gone} should be dropped`);
  }
  assert.ok(sCols.includes('mtg_prices_swept_at'), 'app_settings.mtg_prices_swept_at should be added');

  // --- set_data_gaps: MTG row kept, Pokemon row NOT copied ------------------
  const gCols = await colsOf('set_data_gaps');
  assert.ok(!gCols.includes('game'), 'set_data_gaps.game should be dropped');
  assert.deepStrictEqual(
    await db.all(`SELECT language, set_id, reason FROM set_data_gaps`),
    [{ language: 'English', set_id: 'me1', reason: 'no cards' }],
    'the two games shared (English, me1); only the MTG gap survives'
  );

  // --- price_history: orphan gone, real point kept ---------------------------
  assert.deepStrictEqual(
    await db.all(`SELECT card_id, price FROM price_history`),
    [{ card_id: 'mtg-keep-1', price: 5 }],
    'orphaned Pokemon price points deleted, MTG history preserved'
  );

  // --- idempotency: a second initDb on the migrated DB must be a no-op ------
  await db.initDb();
  assert.deepStrictEqual(
    await db.all(`SELECT card_id, quantity FROM collection ORDER BY card_id`),
    [{ card_id: 'mtg-keep-1', quantity: 2 }, { card_id: 'mtg-keep-2', quantity: 1 }],
    'second initDb must not touch data'
  );
}

main()
  .then(() => {
    console.log('PASS: legacy de-pokemon migration (indexes, FK child, gap collision, leaks)');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  })
  .finally(cleanup);
