const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

// Isolated temp DB and unique port
const tmpDb = path.join(os.tmpdir(), `bindarr-cardlist-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3013';

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

// The same builder the endpoint calls — the assertions below are byte-exact
// against its output, so any drift between endpoint and formatter fails here.
const { buildCardListText } = require('../../../shared/cardListText.js');

async function waitForServer(port) {
  const url = `http://localhost:${port}/api/health`;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function waitForDatabase() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
      if (admin) return admin.id;
    } catch (e) {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function runTests() {
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });
  server.stderr.on('data', (d) => process.stderr.write(d.toString()));

  try {
    await waitForServer(port);
    const adminId = await waitForDatabase();

    // Authenticated as admin via a planted session, like the other e2e suites.
    const token = 'cardlist-test-token';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1);
    await db.run(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [token, adminId, expiresAt.toISOString()]
    );
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // Seed: one MTG card with set+number, one without, one in a wishlist
    // entry that must NOT appear in the export.
    await db.run(`INSERT OR IGNORE INTO card_cache (id, name, set_id, number, game) VALUES (?, ?, ?, ?, ?)`,
      ['cl-c1', 'Lightning Bolt', 'jud', '124', 'mtg']);
    await db.run(`INSERT OR IGNORE INTO card_cache (id, name, set_id, number, game) VALUES (?, ?, ?, ?, ?)`,
      ['cl-c2', 'The Legend of Yangchen // Avatar Yangchen', 'tla', '27', 'mtg']);
    await db.run(`INSERT OR IGNORE INTO card_cache (id, name, set_id, number, game) VALUES (?, ?, ?, ?, ?)`,
      ['cl-c3', 'Unsettled Basic', null, null, 'mtg']);
    await db.run(
      `INSERT INTO collection (card_id, quantity, user_id, list_type) VALUES (?, ?, ?, ?)`,
      ['cl-c1', 4, adminId, 'collection']);
    await db.run(
      `INSERT INTO collection (card_id, quantity, user_id, list_type) VALUES (?, ?, ?, ?)`,
      ['cl-c2', 1, adminId, 'collection']);
    await db.run(
      `INSERT INTO collection (card_id, quantity, user_id, list_type) VALUES (?, ?, ?, ?)`,
      ['cl-c3', 2, adminId, 'collection']);
    await db.run(
      `INSERT INTO collection (card_id, quantity, user_id, list_type) VALUES (?, ?, ?, ?)`,
      ['cl-c1', 9, adminId, 'wishlist']); // must be excluded

    const res = await fetch(`http://localhost:${port}/api/collection/cardlist`, { headers: authHeaders });
    assert.strictEqual(res.status, 200, 'cardlist requires a valid token');
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    const plain = await res.text();
    const plainLines = plain.trim().split('\n');
    assert.strictEqual(plainLines.length, 3, 'three collection entries, wishlist excluded');
    assert.ok(plainLines.every(l => !l.includes('(')), 'vanilla lines carry no set codes');
    assert.strictEqual(plainLines.find(l => l.startsWith('4 ')), '4 Lightning Bolt');
    assert.strictEqual(plainLines.find(l => l.startsWith('2 ')), '2 Unsettled Basic', 'missing set/number stays bare');

    const resD = await fetch(`http://localhost:${port}/api/collection/cardlist?style=detailed`, { headers: authHeaders });
    assert.strictEqual(resD.status, 200);
    const detailed = await resD.text();
    assert.ok(detailed.includes('4 Lightning Bolt (JUD) 124'), 'set code uppercased + collector number');
    assert.ok(detailed.includes('1 The Legend of Yangchen // Avatar Yangchen (TLA) 27'), 'split name stays one line');
    assert.strictEqual(detailed.split('\n').filter(l => l.trim()).length, 3);
    // Unknown style values fall back to plain.
    const resU = await fetch(`http://localhost:${port}/api/collection/cardlist?style=garbage`, { headers: authHeaders });
    assert.strictEqual(await resU.text(), plain, 'unknown style falls back to plain');

    // No token — the whole /api surface sits behind the auth gate.
    const resA = await fetch(`http://localhost:${port}/api/collection/cardlist`);
    assert.strictEqual(resA.status, 401, 'cardlist requires auth');

    console.log('PASS: cardlist e2e');
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try {
      await new Promise(resolve => {
        db.dbConnection.close(() => resolve());
      });
    } catch {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
}

runTests()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
