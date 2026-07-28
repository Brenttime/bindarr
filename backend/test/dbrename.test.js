// Runnable check for the pokemon_cards.db -> bindarr.db rename.
// This is the data-loss path: point SQLite at a name that isn't there and it
// creates an empty database, which to a user is indistinguishable from the app
// deleting their entire collection. Every branch here exists to prevent that.
// No framework — plain node + assert. Run: `node test/dbrename.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Give the db module a scratch path so importing it doesn't touch a real DB.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-rename-'));
process.env.DB_PATH = path.join(scratch, 'bindarr.db');
const { resolveDbPath, DB_FILENAME, LEGACY_DB_FILENAME } = require('../src/db');

let caseNum = 0;
function freshDir() {
  const dir = path.join(scratch, `case-${++caseNum}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const write = (p, body) => fs.writeFileSync(p, body);
const exists = fs.existsSync;

function main() {
  // 1. Legacy file present, new name absent: rename it, WAL sidecars included.
  //    Losing the -wal would discard every un-checkpointed transaction.
  {
    const dir = freshDir();
    const legacy = path.join(dir, LEGACY_DB_FILENAME);
    const target = path.join(dir, DB_FILENAME);
    write(legacy, 'MAIN');
    write(legacy + '-wal', 'WAL');
    write(legacy + '-shm', 'SHM');

    assert.strictEqual(resolveDbPath(target), target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'MAIN', 'collection data must move');
    assert.strictEqual(fs.readFileSync(target + '-wal', 'utf8'), 'WAL', '-wal must move with it');
    assert.strictEqual(fs.readFileSync(target + '-shm', 'utf8'), 'SHM', '-shm must move with it');
    assert.ok(!exists(legacy), 'old file should be gone, not copied');
  }

  // 2. Both names present: never clobber the newer database.
  {
    const dir = freshDir();
    const legacy = path.join(dir, LEGACY_DB_FILENAME);
    const target = path.join(dir, DB_FILENAME);
    write(legacy, 'OLD');
    write(target, 'CURRENT');

    assert.strictEqual(resolveDbPath(target), target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'CURRENT', 'must not overwrite the live DB');
    assert.strictEqual(fs.readFileSync(legacy, 'utf8'), 'OLD', 'old file left untouched for the operator');
  }

  // 3. Nothing to migrate: a fresh install just uses the new name.
  {
    const dir = freshDir();
    const target = path.join(dir, DB_FILENAME);
    assert.strictEqual(resolveDbPath(target), target);
    assert.ok(!exists(target), 'resolving must not create the file itself');
  }

  // 4. A custom DB_PATH is the operator's choice — it must not adopt some
  //    unrelated pokemon_cards.db that happens to sit in the same directory.
  {
    const dir = freshDir();
    const legacy = path.join(dir, LEGACY_DB_FILENAME);
    const custom = path.join(dir, 'my-cards.db');
    write(legacy, 'OLD');

    assert.strictEqual(resolveDbPath(custom), custom);
    assert.ok(exists(legacy), 'custom target must leave the legacy file alone');
    assert.ok(!exists(custom), 'and must not invent one');
  }

  // 5. Someone explicitly pinned DB_PATH to the old name: respect it exactly.
  {
    const dir = freshDir();
    const legacy = path.join(dir, LEGACY_DB_FILENAME);
    write(legacy, 'OLD');

    assert.strictEqual(resolveDbPath(legacy), legacy, 'pinned legacy path stays as-is');
    assert.strictEqual(fs.readFileSync(legacy, 'utf8'), 'OLD');
  }

  // 6. Rename fails (locked/permissions): keep serving the OLD file rather than
  //    opening a new name and presenting an empty collection.
  {
    const dir = freshDir();
    const legacy = path.join(dir, LEGACY_DB_FILENAME);
    const target = path.join(dir, DB_FILENAME);
    write(legacy, 'MAIN');

    const realRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('EBUSY: resource busy or locked'); };
    try {
      assert.strictEqual(resolveDbPath(target), legacy, 'must fall back to the legacy file');
    } finally {
      fs.renameSync = realRename;
    }
    assert.strictEqual(fs.readFileSync(legacy, 'utf8'), 'MAIN', 'data still intact at the old name');
  }

  console.log('dbrename.test.js: all 6 scenarios passed');
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
