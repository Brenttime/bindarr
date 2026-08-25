const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-deck-value-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3024';
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
  throw new Error('Deck value test server did not start');
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
    const token = 'deck-value-token';
    await db.run(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [token, userId, new Date(Date.now() + 86400000).toISOString()]
    );
    const auth = { Authorization: `Bearer ${token}` };

    const cards = [
      ['value-bolt-active', 'Lightning Bolt', 8, 8, null, 'USD'],
      ['value-bolt-cheap', ' Lightning Bolt ', 2.25, 2.25, 1.5, 'USD'],
      ['value-bolt-eur', 'Lightning Bolt', 0.1, 0.1, null, 'EUR'],
      ['value-bolt-negative', 'Lightning Bolt', 10, 10, null, 'USD'],
      ['value-unpriced', 'Brainstorm', null, null, null, 'USD'],
    ];
    for (const card of cards) {
      await db.run(
        `INSERT INTO card_cache
          (id, name, price_trend, price_normal, price_holofoil, price_currency)
         VALUES (?, ?, ?, ?, ?, ?)`,
        card
      );
    }

    const valuedDeck = await db.run(`INSERT INTO decks (user_id, name) VALUES (?, 'Minimum Value Deck')`, [userId]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'value-bolt-active', 2)`, [valuedDeck.lastID]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'value-bolt-cheap', 1)`, [valuedDeck.lastID]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'value-bolt-negative', -10)`, [valuedDeck.lastID]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'value-unpriced', 2)`, [valuedDeck.lastID]);
    const emptyDeck = await db.run(`INSERT INTO decks (user_id, name) VALUES (?, 'Empty Value Deck')`, [userId]);

    const listResponse = await fetch(`http://localhost:${port}/api/decks`, { headers: auth });
    assert.strictEqual(listResponse.status, 200);
    const decks = await listResponse.json();
    const summary = decks.find(deck => deck.id === valuedDeck.lastID);
    assert.strictEqual(summary.minimum_value, 4.5,
      'three logical copies use the cheapest USD printing/finish, not the active printing or cheaper EUR quote');
    assert.strictEqual(summary.minimum_value_currency, 'USD');
    assert.strictEqual(summary.unpriced_cards, 2);
    assert.strictEqual(summary.unpriced_card_types, 1);
    assert.ok(await db.get(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_card_cache_logical_name'`));
    const empty = decks.find(deck => deck.id === emptyDeck.lastID);
    assert.strictEqual(empty.minimum_value, 0);
    assert.strictEqual(empty.unpriced_cards, 0);
    console.log('PASS: F9-TC1');

    const detailResponse = await fetch(`http://localhost:${port}/api/decks/${valuedDeck.lastID}`, { headers: auth });
    assert.strictEqual(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.strictEqual(detail.minimum_value, 4.5);
    assert.strictEqual(detail.unpriced_cards, 2);
    assert.strictEqual(detail.cards.find(card => card.name.trim() === 'Lightning Bolt').quantity, 3,
      'legacy active-print rows remain one logical card while valuation sums their quantity');
    console.log('PASS: F9-TC2');

    const unauthenticated = await fetch(`http://localhost:${port}/api/decks`);
    assert.strictEqual(unauthenticated.status, 401);
    console.log('PASS: F9-TC3');
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
