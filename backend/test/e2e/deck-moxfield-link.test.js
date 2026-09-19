const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

// The deck builder offers "open on Moxfield" for decks mirrored from Moxfield,
// both in the deck list (which reads /api/decks) and in the opened header (which
// reads /api/decks/:id). Both need the deck's remote public id, so this pins the
// API contract those two views depend on: the id is present on moxfield-sourced
// rows and null for hand-made ones, and adding the column must not disturb the
// aggregate totals the same query reports.
const tmpDb = path.join(os.tmpdir(), `bindarr-deck-moxfield-link-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3033';
const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Deck Moxfield link test server did not start');
}

async function waitForAdmin() {
  for (let i = 0; i < 150; i++) {
    const admin = await db.get(`SELECT id FROM users WHERE username = 'admin'`).catch(() => null);
    if (admin) return admin.id;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Admin user was not initialized');
}

async function runTests() {
  const server = spawn('node', [path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });
  server.stderr.on('data', chunk => process.stderr.write(chunk.toString()));

  try {
    await waitForServer();
    const userId = await waitForAdmin();
    const token = 'deck-moxfield-link-token';
    await db.run(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [token, userId, new Date(Date.now() + 86400000).toISOString()]
    );
    const bearer = (t) => `Bearer ${t}`;
    const auth = { Authorization: bearer(token) };
    const json = { ...auth, ["Content-Type"]: "application/json" };
    const api = pathName => `http://localhost:${port}/api${pathName}`;

    await db.run(
      `INSERT INTO card_cache (id, name, printed_name, set_name) VALUES ('link-bolt', 'Lightning Bolt', 'Lightning Bolt', 'M10')`
    );

    // A hand-made deck through the normal API path, plus cards, so the aggregates
    // are exercised alongside the new projection.
    const created = await fetch(api('/decks'), {
      method: 'POST', headers: json,
      body: JSON.stringify({ name: 'Hand Made', format: 'Commander / EDH' })
    });
    assert.strictEqual(created.status, 201);
    const handMadeId = (await created.json()).id;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'link-bolt', 4)`, [handMadeId]);

    // A Moxfield mirror exactly as moxfieldSync.ensureLocalDeck creates it.
    const mirror = await db.run(
      `INSERT INTO decks (name, description, format, category, accent_color, target_size, user_id, source, moxfield_public_id)
       VALUES ('Mirror Deck', '', 'commander', 'Moxfield Sync', '#22d3ee', 100, ?, 'moxfield', 'abc123')`,
      [userId]
    );

    const list = await (await fetch(api('/decks'), { headers: auth })).json();
    const handRow = list.find(row => row.id === handMadeId);
    const mirrorRow = list.find(row => row.id === mirror.lastID);

    assert.ok(handRow && mirrorRow, 'both decks appear in the list');
    assert.strictEqual(mirrorRow.moxfield_public_id, 'abc123',
      'the deck list must carry the Moxfield public id so the builder can link out');
    assert.strictEqual(mirrorRow.source, 'moxfield');
    assert.strictEqual(handRow.moxfield_public_id, null,
      'a hand-made deck has no remote id and must not offer the link');
    assert.strictEqual(handRow.total_cards, 4, 'adding the column leaves the aggregates intact');
    assert.strictEqual(handRow.total_card_types, 1);
    console.log('PASS: F7-TC1');

    // The opened deck header reads the detail endpoint; it must expose the same id.
    const detail = await (await fetch(api(`/decks/${mirror.lastID}`), { headers: auth })).json();
    assert.strictEqual(detail.moxfield_public_id, 'abc123');
    assert.strictEqual(detail.source, 'moxfield');
    const handDetail = await (await fetch(api(`/decks/${handMadeId}`), { headers: auth })).json();
    assert.strictEqual(handDetail.moxfield_public_id, null);
    console.log('PASS: F7-TC2');

    // The id is scoped to its owner: a second account must not see it through
    // either endpoint, so the link can not leak another user's deck identity.
    const other = await db.run(
      `INSERT INTO users (username, password_hash, role, share_token, created_at)
       VALUES ('link-outsider', 'x', 'member', 'link-outsider-share', CURRENT_TIMESTAMP)`
    );
    const otherToken = 'deck-moxfield-link-other';
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [
      otherToken, other.lastID, new Date(Date.now() + 86400000).toISOString()
    ]);
    const otherAuth = { Authorization: bearer(otherToken) };
    const otherList = await (await fetch(api('/decks'), { headers: otherAuth })).json();
    assert.strictEqual(otherList.length, 0, 'another user sees none of the decks');
    assert.strictEqual((await fetch(api(`/decks/${mirror.lastID}`), { headers: otherAuth })).status, 404);
    console.log('PASS: F7-TC3');
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try {
      await new Promise(resolve => db.dbConnection.close(() => resolve()));
    } catch {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
}

runTests()
  .then(() => process.exit(0))
  .catch(error => { console.error(error); process.exit(1); });
