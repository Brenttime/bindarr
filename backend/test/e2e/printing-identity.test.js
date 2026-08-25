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
const moxfieldSync = require('../../src/moxfieldSync');
const moxfieldApi = require('../../src/moxfieldApi');

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
      ['brain-a', 'Brainstorm', 'ice', '61', 'Instant', '["Instant"]'],
      ['stack-a', 'Stack Merge Probe', 'tst', '1', 'Instant', '["Instant"]'],
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

    // A quantity reduction racing checkout is ordered: either the reduction wins
    // and checkout sees less supply, or checkout wins and the reduction is blocked.
    const brainEntry = await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('brain-a', ?, 3)`, [userId]);
    const brainDeck = await createDeck('Concurrent inventory reduction');
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'brain-a', 3)`, [brainDeck]);
    const reductionRace = await Promise.all([
      fetch(api(`/decks/${brainDeck}/checkout`), { method: 'PUT', headers: auth }),
      fetch(api(`/collection/${brainEntry.lastID}`), {
        method: 'PUT', headers: json, body: JSON.stringify({ quantity: 2 })
      }),
    ]);
    assert.strictEqual(reductionRace.filter(response => response.status === 200).length, 1);
    assert.ok(reductionRace.some(response => response.status === 400 || response.status === 409));
    const brainState = await db.get(`
      SELECT
        (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE user_id = ? AND card_id = 'brain-a') AS owned,
        (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
         WHERE d.id = ? AND d.checked_out = 1) AS locked
    `, [userId, brainDeck]);
    assert.ok(brainState.locked <= brainState.owned, 'concurrent reduction must never undercut checked-out demand');
    if (brainState.locked) {
      assert.strictEqual((await fetch(api(`/decks/${brainDeck}/return`), { method: 'PUT', headers: auth })).status, 200);
    }

    // A metadata edit can move one row into another physical stack. The guard
    // must account for the target stack before setStackQuantity trims it.
    const stackEntry = await db.run(`
      INSERT INTO collection (card_id, user_id, quantity, condition, printing, language)
      VALUES ('stack-a', ?, 1, 'Near Mint', 'Normal', 'English')
    `, [userId]);
    const destinationStack = await db.run(`
      INSERT INTO collection (card_id, user_id, quantity, condition, printing, language)
      VALUES ('stack-a', ?, 4, 'Lightly Played', 'Normal', 'English')
    `, [userId]);
    const stackDeck = await createDeck('Metadata stack reduction guard');
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'stack-a', 3)`, [stackDeck]);
    assert.strictEqual((await fetch(api(`/decks/${stackDeck}/checkout`), { method: 'PUT', headers: auth })).status, 200);
    const negativeLegacy = await db.run(`
      INSERT INTO collection (card_id, user_id, quantity, condition, printing, language)
      VALUES ('stack-a', ?, -2, 'Lightly Played', 'Normal', 'English')
    `, [userId]);
    const mergeReduction = await fetch(api(`/collection/${stackEntry.lastID}`), {
      method: 'PUT', headers: json, body: JSON.stringify({ condition: 'Lightly Played', quantity: 1 })
    });
    assert.strictEqual(mergeReduction.status, 409, 'target-stack merge cannot undercut checked-out demand');
    const stackState = await db.get(`
      SELECT SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS owned,
             SUM(CASE WHEN id = ? AND condition = 'Near Mint' THEN 1 ELSE 0 END) AS original_unchanged
      FROM collection WHERE user_id = ? AND card_id = 'stack-a'
    `, [stackEntry.lastID, userId]);
    assert.strictEqual(stackState.owned, 5);
    assert.strictEqual(stackState.original_unchanged, 1);
    const guardedBulkDelete = await fetch(api('/collection/bulk'), {
      method: 'POST', headers: json,
      body: JSON.stringify({ entry_ids: [destinationStack.lastID, negativeLegacy.lastID], action: 'delete' })
    });
    assert.strictEqual(guardedBulkDelete.status, 409, 'negative legacy rows cannot mask a reserved positive deletion');
    await db.run(`DELETE FROM collection WHERE id = ?`, [negativeLegacy.lastID]);
    assert.strictEqual((await fetch(api(`/decks/${stackDeck}/return`), { method: 'PUT', headers: auth })).status, 200);
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
    await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('split-a', ?, 0)`, [userId]);
    const zeroOwnedSearch = await fetch(
      api('/search?scope=collection&name=Fire%20%2F%2F%20Ice'),
      { headers: auth }
    ).then(r => r.json());
    assert.strictEqual(zeroOwnedSearch.length, 0, 'nonpositive collection rows are not owned search results');
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

    // F8-TC7: nonpositive legacy rows are ignored; positive orphan rows are represented in
    // summaries and fail closed in details/exports instead of silently disappearing.
    await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'bolt-a', 0)`, [listId]);
    let zeroSummary = (await fetch(api('/lists'), { headers: auth }).then(r => r.json())).find(row => row.id === listId);
    assert.strictEqual(zeroSummary.total_card_types, 0);
    assert.strictEqual(zeroSummary.total_cards, 0);
    await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'missing-list-card', 1)`, [listId]);
    await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, 'missing-list-card-2', 1)`, [listId]);
    zeroSummary = (await fetch(api('/lists'), { headers: auth }).then(r => r.json())).find(row => row.id === listId);
    assert.strictEqual(zeroSummary.total_card_types, 2, 'distinct positive list orphans stay distinct');
    assert.strictEqual(zeroSummary.unresolved_card_types, 2);
    assert.strictEqual((await fetch(api(`/lists/${listId}`), { headers: auth })).status, 422);
    assert.strictEqual((await fetch(api(`/lists/${listId}/cardlist`), { headers: auth })).status, 422);
    await db.run(`DELETE FROM list_cards WHERE list_id = ? AND card_id LIKE 'missing-list-card%'`, [listId]);

    const physicalExport = await fetch(api('/collection/cardlist'), { headers: auth });
    assert.strictEqual(physicalExport.status, 200);
    assert.ok(!(await physicalExport.text()).includes('Fire // Ice'), 'zero physical rows are omitted from exports');
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('missing-collection-card', ?, 1)`, [userId]);
    await db.run('PRAGMA foreign_keys = ON');
    assert.strictEqual((await fetch(api('/collection/cardlist'), { headers: auth })).status, 422);
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run(`DELETE FROM collection WHERE user_id = ? AND card_id = 'missing-collection-card'`, [userId]);
    await db.run('PRAGMA foreign_keys = ON');

    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'missing-deck-card', 1)`, [legacy]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'missing-deck-card-2', 1)`, [legacy]);
    const deckSummary = (await fetch(api('/decks'), { headers: auth }).then(r => r.json())).find(row => row.id === legacy);
    assert.strictEqual(deckSummary.total_card_types, 3, 'two distinct positive deck orphans remain separate from the valid card');
    assert.strictEqual(deckSummary.unresolved_card_types, 2);
    assert.strictEqual((await fetch(api(`/decks/${legacy}`), { headers: auth })).status, 422);
    assert.strictEqual((await fetch(api(`/decks/${legacy}/locations`), { headers: auth })).status, 422);
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id LIKE 'missing-deck-card%'`, [legacy]);
    console.log('PASS: F8-TC7');

    // F8-TC8: disabling or removing Moxfield tracking cannot discard a checked-out mirror.
    assert.strictEqual((await fetch(api(`/decks/${deckA}/checkout`), { method: 'PUT', headers: auth })).status, 200);
    const author = await db.run(
      `INSERT INTO moxfield_authors (user_id, moxfield_user) VALUES (?, 'identity-test')`,
      [userId]
    );
    await assert.rejects(
      () => moxfieldSync.syncDecklist(author.lastID, { user: { id: userId + 1 } }),
      /not found/i
    );
    await assert.rejects(
      () => moxfieldSync.runContentSync(author.lastID, { user: { id: userId + 1 } }),
      /not found/i
    );
    await db.run(
      `INSERT INTO moxfield_decks (author_id, public_id, name, bindarr_deck_id, enabled)
       VALUES (?, 'identity-public-id', 'Protected mirror', ?, 1)`,
      [author.lastID, deckA]
    );
    await assert.rejects(
      () => moxfieldSync.setDeckEnabled(userId, 'identity-public-id', false),
      error => error && error.code === 'ALLOCATION_CONFLICT'
    );
    await assert.rejects(
      () => moxfieldSync.removeAuthor(userId, author.lastID),
      error => error && error.code === 'ALLOCATION_CONFLICT'
    );
    assert.ok(await db.get(`SELECT id FROM moxfield_authors WHERE id = ?`, [author.lastID]));
    assert.ok(await db.get(`SELECT id FROM decks WHERE id = ? AND checked_out = 1`, [deckA]));
    assert.strictEqual((await fetch(api(`/decks/${deckA}/return`), { method: 'PUT', headers: auth })).status, 200);

    // A pull that started before disable may finish its remote I/O afterward;
    // it must re-check tracking state under the allocation lock and stay gone.
    await db.run(`UPDATE decks SET source = 'moxfield' WHERE id = ?`, [deckA]);
    const originalGetDeckDetails = moxfieldApi.getDeckDetails;
    let markRemoteStarted;
    const remoteStarted = new Promise(resolve => { markRemoteStarted = resolve; });
    let releaseRemote;
    moxfieldApi.getDeckDetails = async () => {
      markRemoteStarted();
      return new Promise(resolve => {
        releaseRemote = () => resolve({
          name: 'Protected mirror', format: 'commander', lastUpdatedAtUtc: '2026-08-25T00:00:00Z', boards: {}
        });
      });
    };
    try {
      const stalePull = moxfieldSync.pullDeckContentByPublicId(userId, 'identity-public-id');
      await remoteStarted;
      await moxfieldSync.setDeckEnabled(userId, 'identity-public-id', false);
      releaseRemote();
      const staleResult = await stalePull;
      assert.strictEqual(staleResult.skipped, true);
      assert.strictEqual(staleResult.reason, 'tracking-disabled-or-removed');
      const trackingAfterRace = await db.get(
        `SELECT enabled, bindarr_deck_id FROM moxfield_decks WHERE author_id = ? AND public_id = 'identity-public-id'`,
        [author.lastID]
      );
      assert.strictEqual(trackingAfterRace.enabled, 0);
      assert.strictEqual(trackingAfterRace.bindarr_deck_id, null);
      assert.strictEqual(await db.get(`SELECT id FROM decks WHERE id = ?`, [deckA]), undefined);
    } finally {
      moxfieldApi.getDeckDetails = originalGetDeckDetails;
    }
    await moxfieldSync.removeAuthor(userId, author.lastID);

    // Discovery that finishes after author removal must not create an orphan
    // tracking row or local mirror.
    const discoveryAuthor = await db.run(
      `INSERT INTO moxfield_authors (user_id, moxfield_user) VALUES (?, 'discovery-race')`,
      [userId]
    );
    const originalGetUser = moxfieldApi.getUser;
    const originalGetSummaries = moxfieldApi.getAuthorDeckSummaries;
    let markDiscoveryStarted;
    const discoveryStarted = new Promise(resolve => { markDiscoveryStarted = resolve; });
    let releaseDiscovery;
    moxfieldApi.getUser = async () => ({ userName: 'discovery-race', displayName: 'Discovery Race', profileImageUrl: null });
    moxfieldApi.getAuthorDeckSummaries = async () => {
      markDiscoveryStarted();
      return new Promise(resolve => {
        releaseDiscovery = () => resolve([{
          publicId: 'stale-discovery-deck', name: 'Stale Discovery', format: 'commander', lastUpdatedAtUtc: '2026-08-25T00:00:00Z'
        }]);
      });
    };
    try {
      const staleDiscovery = moxfieldSync.syncDecklist(discoveryAuthor.lastID, { user: { id: userId } });
      await discoveryStarted;
      await moxfieldSync.removeAuthor(userId, discoveryAuthor.lastID);
      releaseDiscovery();
      const staleReport = await staleDiscovery;
      assert.strictEqual(staleReport.stale, true);
      assert.strictEqual(await db.get(`SELECT id FROM moxfield_decks WHERE public_id = 'stale-discovery-deck'`), undefined);
      assert.strictEqual(await db.get(`SELECT id FROM decks WHERE moxfield_public_id = 'stale-discovery-deck'`), undefined);
    } finally {
      moxfieldApi.getUser = originalGetUser;
      moxfieldApi.getAuthorDeckSummaries = originalGetSummaries;
    }

    const brainstormBeforeRollback = (await db.get(
      `SELECT COUNT(*) AS count FROM collection WHERE user_id = ? AND card_id = 'brain-a'`,
      [userId]
    )).count;
    await assert.rejects(db.withDedicatedTransaction(async tx => {
      await tx.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('brain-a', ?, 1)`, [userId]);
      throw new Error('injected rollback probe');
    }), /injected rollback probe/);
    assert.strictEqual(
      (await db.get(`SELECT COUNT(*) AS count FROM collection WHERE user_id = ? AND card_id = 'brain-a'`, [userId])).count,
      brainstormBeforeRollback
    );
    console.log('PASS: F8-TC8');

    // F8-TC9: deck registration remains additive and printing-specific at the physical collection boundary.
    const registrationDeck = await createDeck('Physical printing registration');
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'split-b', 2)`, [registrationDeck]);
    const before = await db.get(`SELECT COALESCE(SUM(quantity), 0) AS qty FROM collection WHERE user_id = ? AND card_id = 'split-b'`, [userId]);
    const register = await fetch(api(`/decks/${registrationDeck}/register-collection`), { method: 'POST', headers: auth });
    assert.strictEqual(register.status, 201, await register.text());
    const after = await db.get(`SELECT COALESCE(SUM(quantity), 0) AS qty FROM collection WHERE user_id = ? AND card_id = 'split-b'`, [userId]);
    assert.strictEqual(after.qty - before.qty, 2);
    console.log('PASS: F8-TC9');
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
