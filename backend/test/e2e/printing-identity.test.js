const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-printing-identity-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3021';
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
  throw new Error('Printing identity test server did not start');
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
    const token = 'printing-identity-token';
    await db.run(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [token, userId, new Date(Date.now() + 86400000).toISOString()]
    );
    const auth = { Authorization: `Bearer ${token}` };
    const json = { ...auth, 'Content-Type': 'application/json' };
    const api = pathName => `http://localhost:${port}/api${pathName}`;

    const cards = [
      ['bolt-a', 'Lightning Bolt', 'lea', '161', 'Instant', '["Instant"]'],
      ['bolt-b', 'Lightning Bolt', 'm10', '146', 'Instant', '["Instant"]'],
      ['split-a', 'Fire // Ice', 'apc', '128', 'Instant', '["Instant"]'],
      ['split-b', 'Fire // Ice', 'mh2', '290', 'Instant', '["Instant"]'],
      ['island-a', 'Island', 'lea', '286', 'Land', '["Basic","Land","Island"]'],
    ];
    for (const card of cards) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, supertype, subtypes) VALUES (?, ?, ?, ?, ?, ?)`,
        card
      );
    }
    await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('bolt-a', ?, 1)`, [userId]);
    await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('bolt-b', ?, 2)`, [userId]);

    const createDeck = async name => {
      const result = await db.run(`INSERT INTO decks (user_id, name) VALUES (?, ?)`, [userId, name]);
      return result.lastID;
    };
    const deckA = await createDeck('Alpha printing request');
    const deckB = await createDeck('M10 printing request');
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'bolt-a', 2)`, [deckA]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'bolt-b', 2)`, [deckB]);

    // F8-TC1: a deck requesting printing A checks out against copies owned as B.
    const checkoutA = await fetch(api(`/decks/${deckA}/checkout`), { method: 'PUT', headers: auth });
    assert.strictEqual(checkoutA.status, 200, await checkoutA.text());
    const checkoutBBlocked = await fetch(api(`/decks/${deckB}/checkout`), { method: 'PUT', headers: auth });
    assert.strictEqual(checkoutBBlocked.status, 400, 'aggregate logical supply cannot be spent twice');
    const locations = await fetch(api(`/decks/${deckB}/locations`), { headers: auth }).then(r => r.json());
    assert.strictEqual(locations.length, 1);
    assert.strictEqual(locations[0].owned, 3);
    assert.strictEqual(locations[0].in_use, 2);
    assert.strictEqual(locations[0].available, 1);
    assert.strictEqual(locations[0].missing, 1);
    console.log('PASS: F8-TC1');

    // F8-TC2: check-in releases the shared pool; two concurrent requests cannot over-allocate it.
    assert.strictEqual((await fetch(api(`/decks/${deckA}/return`), { method: 'PUT', headers: auth })).status, 200);
    assert.strictEqual((await fetch(api(`/decks/${deckB}/checkout`), { method: 'PUT', headers: auth })).status, 200);
    assert.strictEqual((await fetch(api(`/decks/${deckB}/return`), { method: 'PUT', headers: auth })).status, 200);
    const concurrent = await Promise.all([
      fetch(api(`/decks/${deckA}/checkout`), { method: 'PUT', headers: auth }),
      fetch(api(`/decks/${deckB}/checkout`), { method: 'PUT', headers: auth }),
    ]);
    assert.deepStrictEqual(concurrent.map(r => r.status).sort(), [200, 400]);
    const checked = await db.all(`SELECT id FROM decks WHERE id IN (?, ?) AND checked_out = 1`, [deckA, deckB]);
    assert.strictEqual(checked.length, 1, 'exactly one competing deck is checked out');
    console.log('PASS: F8-TC2');

    // F8-TC3: checked-out allocation protects edits to both the deck and its logical inventory.
    const checkedId = checked[0].id;
    const cardEdit = await fetch(api(`/decks/${checkedId}/cards`), {
      method: 'POST', headers: json, body: JSON.stringify({ card_id: 'bolt-b', quantity: 1 })
    });
    assert.strictEqual(cardEdit.status, 409);
    const ownedBoltB = await db.get(`SELECT id FROM collection WHERE user_id = ? AND card_id = 'bolt-b'`, [userId]);
    const removeLocked = await fetch(api(`/collection/${ownedBoltB.id}`), { method: 'DELETE', headers: auth });
    assert.strictEqual(removeLocked.status, 409);
    assert.strictEqual((await fetch(api(`/decks/${checkedId}/return`), { method: 'PUT', headers: auth })).status, 200);
    console.log('PASS: F8-TC3');

    // F8-TC4: legacy duplicate printing rows collapse in reads and in later writes.
    const legacy = await createDeck('Legacy reprint rows');
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'split-a', 1)`, [legacy]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'split-b', 2)`, [legacy]);
    const legacyDetail = await fetch(api(`/decks/${legacy}`), { headers: auth }).then(r => r.json());
    assert.strictEqual(legacyDetail.cards.length, 1);
    assert.strictEqual(legacyDetail.cards[0].name, 'Fire // Ice');
    assert.strictEqual(legacyDetail.cards[0].quantity, 3);

    const updateBolt = await fetch(api(`/decks/${deckA}/cards`), {
      method: 'POST', headers: json, body: JSON.stringify({ card_id: 'bolt-b', quantity: 3 })
    });
    assert.strictEqual(updateBolt.status, 200, await updateBolt.text());
    const boltRows = await db.all(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ?`, [deckA]);
    assert.deepStrictEqual(boltRows, [{ card_id: 'bolt-a', quantity: 3 }]);
    console.log('PASS: F8-TC4');

    // F8-TC5: collection/search keep exact rows but every printing reports logical owned total.
    const collection = await fetch(api('/collection'), { headers: auth }).then(r => r.json());
    const exactBoltIds = collection.filter(row => row.name === 'Lightning Bolt').map(row => row.card_id).sort();
    assert.deepStrictEqual(exactBoltIds, ['bolt-a', 'bolt-b']);
    const search = await fetch(api('/search?scope=collection&name=Lightning%20Bolt'), { headers: auth }).then(r => r.json());
    assert.strictEqual(search.length, 2);
    assert.deepStrictEqual(search.map(card => card.id).sort(), ['bolt-a', 'bolt-b']);
    assert.ok(search.every(card => card.owned_qty === 3));
    console.log('PASS: F8-TC5');

    // F8-TC6: list add/count/detail/export/remove use logical identity, not printing id.
    const listCreate = await fetch(api('/lists'), {
      method: 'POST', headers: json, body: JSON.stringify({ name: 'Logical list' })
    });
    assert.strictEqual(listCreate.status, 201);
    const listId = (await listCreate.json()).id;
    assert.strictEqual((await fetch(api(`/lists/${listId}/cards`), {
      method: 'POST', headers: json, body: JSON.stringify({ card_id: 'bolt-a', quantity: 1 })
    })).status, 200);
    // Seed a legacy alternate-printing row, then update through the other printing.
    await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'bolt-b', 2)`, [listId]);
    assert.strictEqual((await fetch(api(`/lists/${listId}/cards`), {
      method: 'POST', headers: json, body: JSON.stringify({ card_id: 'bolt-b', quantity: 3 })
    })).status, 200);
    const listDetail = await fetch(api(`/lists/${listId}`), { headers: auth }).then(r => r.json());
    assert.strictEqual(listDetail.cards.length, 1);
    assert.strictEqual(listDetail.cards[0].quantity, 3);
    assert.strictEqual(listDetail.cards[0].owned_qty, 3);
    const listSummary = await fetch(api('/lists'), { headers: auth }).then(r => r.json());
    assert.strictEqual(listSummary[0].total_card_types, 1);
    assert.strictEqual(listSummary[0].total_cards, 3);
    const exported = await fetch(api(`/lists/${listId}/cardlist`), { headers: auth }).then(r => r.text());
    assert.strictEqual(exported.trim(), '3 Lightning Bolt');
    assert.strictEqual((await fetch(api(`/lists/${listId}/cards/bolt-b`), { method: 'DELETE', headers: auth })).status, 200);
    const emptyList = await fetch(api(`/lists/${listId}`), { headers: auth }).then(r => r.json());
    assert.strictEqual(emptyList.cards.length, 0);
    console.log('PASS: F8-TC6');

    // F8-TC7: deck registration remains additive and printing-specific at the physical collection boundary.
    const registrationDeck = await createDeck('Physical printing registration');
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'split-b', 2)`, [registrationDeck]);
    const before = await db.get(`SELECT COALESCE(SUM(quantity), 0) AS qty FROM collection WHERE user_id = ? AND card_id = 'split-b'`, [userId]);
    const register = await fetch(api(`/decks/${registrationDeck}/register-collection`), { method: 'POST', headers: auth });
    assert.strictEqual(register.status, 201, await register.text());
    const after = await db.get(`SELECT COALESCE(SUM(quantity), 0) AS qty FROM collection WHERE user_id = ? AND card_id = 'split-b'`, [userId]);
    assert.strictEqual(after.qty - before.qty, 2);
    console.log('PASS: F8-TC7');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
    }
  }
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
