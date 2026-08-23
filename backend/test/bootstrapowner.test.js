// The owner account created by POST /api/auth/bootstrap has to inherit the rows a
// pre-multi-user database left behind (`user_id IS NULL`). initDb cannot do it —
// at that point there is no account to hand them to — so the bootstrap route calls
// db.adoptOrphanRows itself. This checks the shared helper both paths use.
//
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-bootstrap-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
// Deliberately unset: this is the wizard path, where initDb leaves users empty.
delete process.env.DEFAULT_ADMIN_PASSWORD;

const db = require('../src/db');

function cleanup() {
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

async function main() {
  await db.initDb();

  const users = await db.get(`SELECT COUNT(*) AS count FROM users`);
  assert.strictEqual(users.count, 0, 'no DEFAULT_ADMIN_PASSWORD => users table stays empty');

  const settings = await db.get(`SELECT setup_complete FROM app_settings WHERE id = 1`);
  assert.strictEqual(settings.setup_complete, 0, 'a new install has not completed the wizard');

  // Stand in for a database written before `user_id` existed.
  await db.run(`INSERT INTO card_cache (id, name) VALUES (?, ?)`, ['test-card-1', 'Test Card']);
  await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES (?, ?, NULL)`, ['test-card-1', 3]);

  // What the bootstrap route does after inserting the owner.
  const owner = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled) VALUES (?, ?, ?, ?, ?)`,
    ['admin', db.hashPassword('a-long-enough-password'), 'admin', 'token', 0]
  );
  await db.adoptOrphanRows(owner.lastID);

  const orphanCards = await db.get(`SELECT COUNT(*) AS count FROM collection WHERE user_id IS NULL`);
  assert.strictEqual(orphanCards.count, 0, 'orphan collection rows must be adopted');

  console.log('bootstrap owner adoption: OK');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch(err => { console.error(err); cleanup(); process.exit(1); });
