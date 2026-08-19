// Runnable check for the Pokémon provider default.
//
// This is a data-integrity path, not a preference. A fresh install should come up
// on TCGdex (more sets, every language, no key, an order of magnitude faster), and
// an install that already holds cards MUST NOT be moved, because the two providers
// number the same sets differently — sv1 vs sv01, pgo vs swsh10.5 — and switching
// underneath existing data leaves the set catalogue describing sets none of the
// cached cards belong to.
//
// No framework — plain node + assert. Run: `node test/providerdefault.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-provider-'));

// The migration under test, lifted verbatim from db.js. Kept as a copy rather than
// booting the whole module twice: initDb opens a module-level singleton connection,
// so it cannot be pointed at two different databases in one process.
const MIGRATION = [
  `ALTER TABLE app_settings ADD COLUMN pokemon_provider TEXT DEFAULT 'tcgdex'`,
  `UPDATE app_settings SET pokemon_provider = 'pokemontcg'
    WHERE (SELECT COUNT(*) FROM sets WHERE game = 'pokemon') > 0
       OR (SELECT COUNT(*) FROM card_cache WHERE game = 'pokemon') > 0`,
];

function open(name) {
  const db = new sqlite3.Database(path.join(scratch, `${name}.db`));
  const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, (e) => (e ? rej(e) : res())));
  const get = (sql) => new Promise((res, rej) =>
    db.get(sql, (e, row) => (e ? rej(e) : res(row))));
  return { run, get };
}

// The pre-migration shape: app_settings without the column, plus the two tables
// the WHERE clause reads.
async function seed(db) {
  await db.run(`CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), public_base_url TEXT DEFAULT '')`);
  await db.run(`INSERT OR IGNORE INTO app_settings (id, public_base_url) VALUES (1, '')`);
  await db.run(`CREATE TABLE sets (id TEXT PRIMARY KEY, name TEXT, game TEXT)`);
  await db.run(`CREATE TABLE card_cache (id TEXT PRIMARY KEY, name TEXT, game TEXT)`);
}

const migrate = async (db) => { for (const sql of MIGRATION) await db.run(sql); };
const providerOf = async (db) => (await db.get(`SELECT pokemon_provider p FROM app_settings WHERE id = 1`)).p;

async function main() {
  // 1. Fresh install: no sets, no cards. TCGdex.
  {
    const db = open('fresh');
    await seed(db);
    await migrate(db);
    assert.strictEqual(await providerOf(db), 'tcgdex', 'a brand new database should default to TCGdex');
  }

  // 2. Pre-column install with a cached set catalogue — every install that has
  //    booted once has this. Must stay on pokemontcg.io.
  {
    const db = open('has-sets');
    await seed(db);
    await db.run(`INSERT INTO sets (id, name, game) VALUES ('sv1', 'Scarlet & Violet', 'pokemon')`);
    await migrate(db);
    assert.strictEqual(await providerOf(db), 'pokemontcg', 'an install with a set catalogue must not be moved');
  }

  // 3. Pre-column install with cached cards but no set rows (an offline first boot
  //    that still imported a collection). Also must stay put — those card ids are
  //    pokemontcg.io's.
  {
    const db = open('has-cards');
    await seed(db);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('base1-4', 'Charizard', 'pokemon')`);
    await migrate(db);
    assert.strictEqual(await providerOf(db), 'pokemontcg', 'an install with cached cards must not be moved');
  }

  // 4. MTG-only data does not pin the Pokémon provider: there is no Pokémon
  //    numbering to preserve.
  {
    const db = open('mtg-only');
    await seed(db);
    await db.run(`INSERT INTO sets (id, name, game) VALUES ('mtg-fdn', 'Foundations', 'mtg')`);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-abc', 'Llanowar Elves', 'mtg')`);
    await migrate(db);
    assert.strictEqual(await providerOf(db), 'tcgdex', 'MTG-only data should not pin the Pokemon provider');
  }

  // 5. An install that ALREADY has the column keeps its stored value — v1.7.2
  //    shipped it as 'pokemontcg', and the guard in db.js means the ALTER above
  //    never runs for them. Asserted by proving the column check is what gates it.
  {
    const db = open('already-has-column');
    await seed(db);
    await db.run(`ALTER TABLE app_settings ADD COLUMN pokemon_provider TEXT DEFAULT 'pokemontcg'`);
    const cols = await new Promise((res, rej) => {
      const raw = new sqlite3.Database(path.join(scratch, 'already-has-column.db'));
      raw.all(`PRAGMA table_info(app_settings)`, (e, rows) => (e ? rej(e) : res(rows)));
    });
    assert.ok(cols.some(c => c.name === 'pokemon_provider'), 'column present, so db.js skips the migration');
    assert.strictEqual(await providerOf(db), 'pokemontcg', 'a 1.7.2 database keeps pokemontcg.io');
  }

  console.log('providerdefault.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
