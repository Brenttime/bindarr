// Persisted-volume cleanup regression: remove only retired scan catalogs and
// custom art whose card no longer exists. Plain Node + assert, throwaway dirs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-art-cleanup-'));
const databaseDir = path.join(root, 'database');
const modelDir = path.join(root, 'models');
process.env.DB_PATH = path.join(databaseDir, 'bindarr.db');
process.env.CV_MODEL_DIR = modelDir;

const db = require('../src/db');

async function main() {
  await db.initDb();
  const cardArt = require('../src/cardArt');
  fs.mkdirSync(cardArt.USER_DIR, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  await db.run(`INSERT INTO card_cache (id, name) VALUES ('mtg-retained-art', 'Retained Art')`);
  fs.writeFileSync(path.join(cardArt.USER_DIR, 'mtg-retained-art.png'), 'keep');
  fs.writeFileSync(path.join(cardArt.USER_DIR, 'orphan-card.png'), 'remove');
  fs.writeFileSync(path.join(cardArt.USER_DIR, 'orphan-card.jpg'), 'not managed');

  const retired = [
    'milo-pokemon.npz',
    'milo-pokemon-local.bin',
    'milo-pokemon-japanese-local.json',
    'milo-pokemon-chinese (simplified)-local.json',
    'milo-pokemon-local.bin.tmp'
  ];
  const retained = ['milo-mtg.npz', 'milo-mtg-local.bin', 'cornelius.onnx', 'pokemon-backup.npz'];
  for (const name of [...retired, ...retained]) fs.writeFileSync(path.join(modelDir, name), name);

  // initDb owns the startup sweep; exercising it here verifies the cleanup is
  // wired into real initialization rather than existing only as an unused helper.
  await db.initDb();

  for (const name of retired) assert.ok(!fs.existsSync(path.join(modelDir, name)), `${name} should be removed`);
  for (const name of retained) assert.ok(fs.existsSync(path.join(modelDir, name)), `${name} should be preserved`);
  assert.ok(fs.existsSync(path.join(cardArt.USER_DIR, 'mtg-retained-art.png')), 'referenced custom art should remain');
  assert.ok(!fs.existsSync(path.join(cardArt.USER_DIR, 'orphan-card.png')), 'orphan custom PNG should be removed');
  assert.ok(fs.existsSync(path.join(cardArt.USER_DIR, 'orphan-card.jpg')), 'non-managed files should remain');

  const second = await cardArt.cleanupRetiredData();
  assert.deepStrictEqual(second, { removedModels: 0, removedArt: 0 }, 'cleanup must be idempotent');
  console.log('legacyartcleanup.test.js: bounded persisted-data cleanup passed');
}

main()
  .then(() => new Promise(resolve => db.dbConnection.close(resolve)))
  .then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); })
  .catch(err => {
    console.error(err);
    try { db.dbConnection.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  });
