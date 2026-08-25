const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

// Isolated temp DB and unique port
const tmpDb = path.join(os.tmpdir(), `bindarr-scenarios-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const port = '3012';

const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

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
  // Start server preloading scryfall-mock.js
  const mockScript = path.join(__dirname, 'scryfall-mock.js');
  const serverScript = path.join(projectRoot, 'backend/src/server.js');
  const server = spawn('node', ['-r', mockScript, serverScript], {
    env: {
      ...process.env,
      PORT: port,
      DB_PATH: tmpDb,
      // F6-TC5 exercises the self-registration flow, which is invite-only unless
      // explicitly enabled.
      ALLOW_REGISTRATION: 'true'
    }
  });

  try {
    await waitForServer(port);
    const adminId = await waitForDatabase();

    // Insert a valid session token for authentication
    const token = 'test-token-123';
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1);
    await db.run(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
      [token, adminId, expiresAt.toISOString()]
    );

    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // F6-TC2: Collection sorting by color (WUBRG order)
    try {
      const { sortCards } = require('../../src/utils/cardSort');
      const cards = [
        { name: 'Swamp', types: ['Black'], color_identity: ['B'] },
        { name: 'Swords to Plowdown', types: ['Red'], color_identity: ['R'] },
        { name: 'Plains', types: ['White'], color_identity: ['W'] },
        { name: 'Llanowar Elves', types: ['Green'], color_identity: ['G'] },
        { name: 'Island', types: ['Blue'], color_identity: ['U'] }
      ];
      const sorted = sortCards(cards, '[{"by":"color","dir":"asc"},{"by":"name","dir":"asc"}]', 'normals_first');
      // WUBRG: White -> Blue -> Black -> Red -> Green
      assert.strictEqual(sorted[0].name, 'Plains');
      assert.strictEqual(sorted[1].name, 'Island');
      assert.strictEqual(sorted[2].name, 'Swamp');
      assert.strictEqual(sorted[3].name, 'Swords to Plowdown');
      assert.strictEqual(sorted[4].name, 'Llanowar Elves');
      console.log('PASS: F6-TC2');
    } catch (err) {
      console.error('FAIL: F6-TC2 -', err.message);
      throw err;
    }

    // F6-TC3: Scryfall proxy search & add to collection with price history writing
    try {
      const searchRes = await fetch(`http://localhost:${port}/api/search?game=mtg&name=Lotus`, { headers: authHeaders });
      const cards = await searchRes.json();
      assert.ok(cards.length > 0, 'Should return Lotus card');
      assert.strictEqual(cards[0].name, 'Black Lotus');

      // Add to collection
      const addRes = await fetch(`http://localhost:${port}/api/collection`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          card_id: cards[0].id,
          quantity: 1,
          condition: 'Near Mint',
          printing: 'Normal',
          language: 'English',
          purchase_price: 10000.0
        })
      });
      assert.strictEqual(addRes.status, 200);

      // Verify price history row exists for this card
      const priceHist = await db.all(`SELECT * FROM price_history WHERE card_id = ?`, [cards[0].id]);
      assert.ok(priceHist.length > 0, 'Price history record must be written');
      console.log('PASS: F6-TC3');
    } catch (err) {
      console.error('FAIL: F6-TC3 -', err.message);
      throw err;
    }

    // F6-TC4: set/number code -> API search result
    try {
      const scanText = 'ELD/171';
      // Parse a set code + collector number
      const match = scanText.match(/^([A-Z0-9]{3,5})[\s\/]+([0-9a-zA-Z★]+)$/);
      assert.ok(match);
      const set = match[1];
      const num = match[2];

      const searchRes = await fetch(`http://localhost:${port}/api/search?game=mtg&set=${set}&number=${num}`, { headers: authHeaders });
      const matches = await searchRes.json();
      assert.ok(matches.length > 0);
      assert.strictEqual(matches[0].name, 'Questing Beast');
      console.log('PASS: F6-TC4');
    } catch (err) {
      console.error('FAIL: F6-TC4 -', err.message);
      throw err;
    }

    // F6-TC5: Complete user session flow: register -> login -> scan multiple -> add -> verify stats
    try {
      const uniqueUsername = `tester_${Date.now()}`;
      // 1. Register User
      const regRes = await fetch(`http://localhost:${port}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uniqueUsername, password: 'password123' })
      });
      assert.strictEqual(regRes.status, 201);

      // 2. Login User
      const loginRes = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uniqueUsername, password: 'password123' })
      });
      assert.strictEqual(loginRes.status, 200);
      const { token: userToken } = await loginRes.json();
      assert.ok(userToken);

      const userHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      };

      // 3. Add cards to the user's collection
      const addRes1 = await fetch(`http://localhost:${port}/api/collection`, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          // Cards fetched from Scryfall are cached under the "mtg-" id prefix
          // (see F3-TC2/F5-TC3); F6-TC4 above cached this card as mtg-eld-171.
          card_id: 'mtg-eld-171',
          quantity: 1,
          condition: 'Near Mint',
          printing: 'Normal',
          language: 'English',
          purchase_price: 10.0
        })
      });
      assert.strictEqual(addRes1.status, 200);

      // 5. Verify stats/collection list endpoint
      const collectionListRes = await fetch(`http://localhost:${port}/api/collection`, {
        headers: userHeaders
      });
      assert.strictEqual(collectionListRes.status, 200);
      const collectionList = await collectionListRes.json();
      assert.ok(collectionList.length > 0);
      console.log('PASS: F6-TC5');
    } catch (err) {
      console.error('FAIL: F6-TC5 -', err.message);
      throw err;
    }

    // F6-TC6: checkout ignores basic lands, still enforces non-basic cards
    // Seed two cache rows directly: a basic land and a spell, neither owned.
    await db.run(`INSERT INTO card_cache (id, name, supertype, subtypes, set_id, number) VALUES (?,?,?,?,?,?)`,
      ['smoke-plains', 'Plains', 'Land', '["Basic","Land"]', 'jud', '262']);
    await db.run(`INSERT INTO card_cache (id, name, supertype, subtypes, set_id, number) VALUES (?,?,?,?,?,?)`,
      ['smoke-bolt', 'Lightning Bolt', 'Instant', '["Instant","Spell"]', 'jud', '124']);
    const deckBasics = await db.run(
      `INSERT INTO decks (name, user_id, format, category, accent_color, target_size) VALUES ('Basic-only deck', ?, 'Standard', 'competitive', '#10b981', 60)`,
      [adminId]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?,?,?)`,
      [deckBasics.lastID, 'smoke-plains', 4]);
    const deckSpell = await db.run(
      `INSERT INTO decks (name, user_id, format, category, accent_color, target_size) VALUES ('Spell-short deck', ?, 'Standard', 'competitive', '#10b981', 60)`,
      [adminId]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?,?,?)`,
      [deckSpell.lastID, 'smoke-bolt', 1]);

    // A deck whose only shortfall is basic lands must check out: the wizard
    // and the endpoint use the same isBasicLand rule, so the user is never
    // bounced by the API after the wizard said "fully covered".
    const resBasics = await fetch(`http://localhost:${port}/api/decks/${deckBasics.lastID}/checkout`, {
      method: 'PUT', headers: authHeaders
    });
    assert.strictEqual(resBasics.status, 200, 'checkout must ignore missing basic lands');
    assert.strictEqual((await resBasics.json()).message, 'Deck checked out successfully');

    // A deck short on a NON-basic card must still be rejected.
    const resSpell = await fetch(`http://localhost:${port}/api/decks/${deckSpell.lastID}/checkout`, {
      method: 'PUT', headers: authHeaders
    });
    assert.strictEqual(resSpell.status, 400, 'checkout must still enforce non-basic cards');
    const spellErr = await resSpell.json();
    assert.ok((spellErr.details || []).some(d => d.includes('Lightning Bolt')),
      'the deficit must name the non-basic card');
    console.log('PASS: F6-TC6');

    // F6-TC7: precon search + import creates a deck from the WOTC list
    // The mock serves a one-deck MTGJSON index and a 5-card card list whose
    // printings (lea-232, m10-146) the Scryfall mock already knows.
    const searchRes = await fetch(`http://localhost:${port}/api/precons?q=precon`, { headers: authHeaders });
    assert.strictEqual(searchRes.status, 200);
    const search = await searchRes.json();
    assert.strictEqual(search.results.length, 1, 'index search returns the mocked deck');
    assert.strictEqual(search.results[0].name, 'precons-test');

    const importRes = await fetch(`http://localhost:${port}/api/precons/import`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ fileName: 'precons-test' })
    });
    assert.strictEqual(importRes.status, 201, 'precon import creates the deck');
    const imported = await importRes.json();
    assert.strictEqual(imported.cards, 2, 'both card types land in the deck');

    const vaultRes = await fetch(`http://localhost:${port}/api/decks`, { headers: authHeaders });
    assert.strictEqual(vaultRes.status, 200);
    const vaultDeck = (await vaultRes.json()).find(deck => deck.id === imported.id);
    assert.ok(vaultDeck, 'imported precon is returned by the deck vault API');
    assert.strictEqual(vaultDeck.source, 'precon', 'vault API exposes the source needed for the Precon label');

    // The imported deck carries the resolved printings, stamped as a precon.
    const importedDeck = await db.get(`SELECT id, source, name FROM decks WHERE id = ?`, [imported.id]);
    assert.ok(importedDeck, 'deck row exists');
    assert.strictEqual(importedDeck.source, 'precon');
    assert.strictEqual(importedDeck.name, 'precons-test');
    const rows = await db.all(
      `SELECT cc.name, dc.quantity FROM deck_cards dc JOIN card_cache cc ON dc.card_id = cc.id WHERE dc.deck_id = ? ORDER BY cc.name`,
      [imported.id]
    );
    assert.deepStrictEqual(
      rows.map(r => `${r.name}:${r.quantity}`),
      ['Black Lotus:2', 'Lightning Bolt:3'],
      'quantities and resolved card names must match the WOTC list'
    );

    // Importing the same precon again must not fail and must not duplicate rows.
    const importRes2 = await fetch(`http://localhost:${port}/api/precons/import`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ fileName: 'precons-test' })
    });
    assert.strictEqual(importRes2.status, 201);
    const rows2 = await db.all(
      `SELECT cc.name, dc.quantity FROM deck_cards dc JOIN card_cache cc ON dc.card_id = cc.id WHERE dc.deck_id = ? ORDER BY cc.name`,
      [(await importRes2.json()).id]
    );
    assert.deepStrictEqual(
      rows2.map(r => `${r.name}:${r.quantity}`),
      ['Black Lotus:2', 'Lightning Bolt:3']
    );
    console.log('PASS: F6-TC7');

    // F6-TC8: registering a deck creates newly owned copies with exact deck
    // quantities, then becomes unavailable once that deck is checked out.
    const registrationDeckRows = await db.all(
      `SELECT dc.card_id, dc.quantity FROM deck_cards dc WHERE dc.deck_id = ? ORDER BY dc.card_id`,
      [imported.id]
    );
    const registrationIds = registrationDeckRows.map(row => row.card_id);
    const registrationPlaceholders = registrationIds.map(() => '?').join(',');
    const ownedBefore = await db.all(
      `SELECT card_id, COALESCE(SUM(quantity), 0) AS qty FROM collection
       WHERE user_id = ? AND card_id IN (${registrationPlaceholders})
       GROUP BY card_id`,
      [adminId, ...registrationIds]
    );
    const beforeById = new Map(ownedBefore.map(row => [row.card_id, row.qty]));

    const registerRes = await fetch(`http://localhost:${port}/api/decks/${imported.id}/register-collection`, {
      method: 'POST', headers: authHeaders
    });
    assert.strictEqual(registerRes.status, 201);
    const registered = await registerRes.json();
    assert.strictEqual(registered.added, 5, 'all physical copies are registered');
    assert.strictEqual(registered.card_types, 2, 'response reports unique printings');

    const ownedAfter = await db.all(
      `SELECT card_id, COALESCE(SUM(quantity), 0) AS qty FROM collection
       WHERE user_id = ? AND card_id IN (${registrationPlaceholders})
       GROUP BY card_id`,
      [adminId, ...registrationIds]
    );
    const afterById = new Map(ownedAfter.map(row => [row.card_id, row.qty]));
    for (const row of registrationDeckRows) {
      assert.strictEqual(
        afterById.get(row.card_id) - (beforeById.get(row.card_id) || 0),
        row.quantity,
        `registration must add the deck quantity for ${row.card_id}`
      );
    }

    const registeredRows = await db.all(
      `SELECT card_id, quantity, condition, printing, language FROM collection
       WHERE user_id = ? AND card_id IN (${registrationPlaceholders})
       ORDER BY id DESC LIMIT ?`,
      [adminId, ...registrationIds, registrationIds.length]
    );
    assert.ok(registeredRows.every(row => row.condition === 'Near Mint' && row.printing === 'Normal'));

    const registeredCheckout = await fetch(`http://localhost:${port}/api/decks/${imported.id}/checkout`, {
      method: 'PUT', headers: authHeaders
    });
    assert.strictEqual(registeredCheckout.status, 200, 'registered copies cover checkout');

    const hiddenStateRes = await fetch(`http://localhost:${port}/api/decks/${imported.id}/register-collection`, {
      method: 'POST', headers: authHeaders
    });
    assert.strictEqual(hiddenStateRes.status, 409, 'a checked-out deck cannot be registered again');
    console.log('PASS: F6-TC8');

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
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('FAIL: uncaught error in scenario suite —', err && err.stack || err);
    process.exit(1);
  });
