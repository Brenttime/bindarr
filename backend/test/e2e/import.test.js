const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-import-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const db = require('../../src/db');
const port = '3027';
const base = `http://localhost:${port}`;
const projectRoot = path.join(__dirname, '../../../');

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('import test server did not start');
}

async function waitForAdmin() {
  for (let i = 0; i < 150; i++) {
    try {
      const row = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
      if (row) return row.id;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('import test database did not initialize');
}

async function runTests() {
  const server = spawn('node', ['-r', path.join(__dirname, 'scryfall-mock.js'), path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb }
  });
  try {
    await waitForServer();
    const adminId = await waitForAdmin();
    const token = 'import-test-token';
    await db.run(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
      [token, adminId]
    );
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const send = (data) => fetch(`${base}/api/import`, {
      method: 'POST', headers, body: JSON.stringify({ format: 'json', data })
    });

    // Explicit retired-domain rows remain rejected.
    let res = await send([{
      id: 'legacy-pokemon-row', game: 'pokemon', name: 'Pikachu',
      set_code: 'base1', collector_number: '1', printing: 'Normal'
    }]);
    assert.strictEqual(res.status, 400);

    // Missing and forged discriminators are not trusted. This shape used to be
    // synthesized directly into card_cache from client fields.
    for (const game of [undefined, 'mtg']) {
      const row = {
        id: `legacy-pokemon-${game || 'missing'}`,
        name: 'Pikachu', set_code: 'base1', collector_number: '1', printing: 'Normal'
      };
      if (game) row.game = game;
      res = await send([row]);
      assert.strictEqual(res.status, 400, `${game || 'missing'} game legacy row must be rejected`);
      const body = await res.json();
      assert.match(body.rejected[0].reason, /not recognized by Scryfall/);
    }
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection`)).n, 0);
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM card_cache WHERE id LIKE 'legacy-pokemon-%'`)).n, 0);

    // Even an unexpected stale cache row must not bypass the MTG id boundary.
    await db.run(`INSERT INTO card_cache (id, name) VALUES ('legacy-cached-card', 'Old cached card')`);
    res = await send([{ id: 'legacy-cached-card', printing: 'Normal' }]);
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).rejected[0].reason, /cached card id is not an MTG printing/);
    assert.strictEqual((await db.get(`SELECT COUNT(*) n FROM collection`)).n, 0);
    await db.run(`DELETE FROM card_cache WHERE id = 'legacy-cached-card'`);

    // A real uncached MTG identifier is accepted, but provider-normalized fields
    // and the canonical Scryfall id win over the import's forged client fields.
    res = await send([{
      id: 'client-invented-id', name: 'Definitely Not Provider Data',
      set_code: 'eld', collector_number: '171', rarity: 'Mythic',
      printing: 'Normal', quantity: 2
    }]);
    assert.strictEqual(res.status, 200, await res.text());
    const cached = await db.get(`SELECT id, name, set_id, number FROM card_cache WHERE id = 'mtg-eld-171'`);
    assert.deepStrictEqual(cached, { id: 'mtg-eld-171', name: 'Questing Beast', set_id: 'eld', number: '171' });
    assert.strictEqual(await db.get(`SELECT id FROM card_cache WHERE id = 'client-invented-id'`), undefined);
    const owned = await db.get(`SELECT card_id, quantity FROM collection`);
    assert.deepStrictEqual(owned, { card_id: 'mtg-eld-171', quantity: 2 });
    console.log('PASS: F2-TC12');
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try { await new Promise(resolve => db.dbConnection.close(resolve)); } catch {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error('FAIL: F2-TC12 -', err.message);
  process.exit(1);
});
