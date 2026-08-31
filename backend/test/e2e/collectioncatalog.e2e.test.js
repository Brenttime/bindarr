const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');

// Route-level proof for catalog-only collection queries: /api/search?scope=
// collection&q=otag:x must be resolved LIVE against Scryfall (mocked) and
// intersected with the user's owned cards — the response is the user's OWN
// rows, not the raw upstream match list. Boots the real Express app against a
// throwaway DB, the same way scryfall.test.js does, with the Scryfall mock
// preloaded so no request ever reaches api.scryfall.com.

const tmpDb = path.join(os.tmpdir(), `bindarr-colcatalog-e2e-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
const db = require('../../src/db');
const projectRoot = path.join(__dirname, '../../../');

async function waitForServer(port) {
  const url = `http://localhost:${port}/api/health`;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

async function waitForDatabase() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
      if (admin) return admin.id;
    } catch (e) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Database did not initialize in time');
}

async function runTests() {
  const port = '3041';
  const base = `http://localhost:${port}`;
  const mockScript = path.join(__dirname, 'scryfall-mock.js');
  const serverScript = path.join(projectRoot, 'backend/src/server.js');
  const server = spawn('node', ['-r', mockScript, serverScript], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb, HTTPS_PORT: '', DEFAULT_ADMIN_PASSWORD: 'test-admin-password' }
  });

  try {
    await waitForServer(port);
    await waitForDatabase();

    // The test process talks to the same DB file the server does.
    const adminId = await db.get(`SELECT id FROM users WHERE username = ?`, ['admin']);
    assert.ok(adminId, 'admin user exists');

    // Seed: the admin owns a Black Lotus (the mock's otag list includes it) and
    // NOT a Time Warp (the mock's otag list also includes that, so the
    // intersect is observable).
    await db.run(`INSERT INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, price_trend, price_normal, language)
                  VALUES ('mtg-lea-232', 'Black Lotus', 'MTG', '["Artifact"]', '["Artifact"]', 'Rare', 'lea', 'LEA', '232', 10000, 10000, 'English')`);
    await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('mtg-lea-232', ?, 1)`, [adminId.id]);

    // Log in through the process under test so the session is committed by its
    // own connection (cross-process session inserts 401 — see scryfall.test.js).
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-admin-password' })
    });
    assert.strictEqual(login.status, 200, `test login returned ${login.status}`);
    const token = (await login.json()).token;
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // F4-TC1: catalog-only query resolves live and returns the user's OWN row.
    let res = await fetch(`${base}/api/search?scope=collection&q=${encodeURIComponent('otag:sneak')}`, { headers: authHeaders });
    assert.strictEqual(res.status, 200, `catalog collection query returned ${res.status}`);
    assert.strictEqual(res.headers.get('x-total-count'), '1', 'X-Total-Count reflects the owned rows, not the upstream match count');
    assert.strictEqual(res.headers.get('x-catalog-complete'), '1', 'a walk that finished cleanly is flagged complete');
    assert.strictEqual(res.headers.get('x-catalog-upstream-total'), '2', 'the upstream total is surfaced');
    assert.strictEqual(res.headers.get('x-catalog-cache'), 'resolved', 'the first answer pays for the walk');
    const data = await res.json();
    assert.strictEqual(data.length, 1, 'intersect yields exactly the owned match');
    assert.strictEqual(data[0].name, 'Black Lotus');
    assert.strictEqual(data[0].card_id, 'mtg-lea-232', 'the user own printing row, not a synthesized one');
    assert.strictEqual(data[0].quantity, 1, 'per-entry quantity survives');
    assert.ok(typeof data[0].entry_id === 'number', 'entry_id present for bulk actions');
    assert.ok(!data.some(c => c.name === 'Time Warp'), 'non-owned upstream match is NOT in the result');
    console.log('PASS: F4-TC1');

    // F4-TC5: re-running the SAME tag is served from the durable cache —
    // no fresh walk (X-Catalog-Cache: fresh) — yet still intersects the LIVE
    // collection, so the answer is the user's own rows either way.
    res = await fetch(`${base}/api/search?scope=collection&q=${encodeURIComponent('otag:sneak')}`, { headers: authHeaders });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-catalog-cache'), 'fresh', 'a repeat of a young tag is served from cache');
    assert.strictEqual(res.headers.get('x-total-count'), '1', 'the cached answer still intersects the live collection');
    const cached = await res.json();
    assert.strictEqual(cached.length, 1, 'cache hit returns the same owned row');
    console.log('PASS: F4-TC5');

    // F4-TC2: a data-backed-only query does NOT take the live path — the
    // pinned searchCards contract (collection scope, no API) still holds, and
    // the answer is the field-filtered local rows (Black Lotus is not a land,
    // so is:land yields nothing here even though it is owned).
    res = await fetch(`${base}/api/search?scope=collection&q=${encodeURIComponent('is:land')}`, { headers: authHeaders });
    assert.strictEqual(res.status, 200);
    const local = await res.json();
    assert.deepStrictEqual(local, [], 'local-scope raw query stays on the pinned no-API path');
    console.log('PASS: F4-TC2');

    // F4-TC3: an unparseable catalog query is a fixable-query 400, not a 500.
    res = await fetch(`${base}/api/search?scope=collection&q=${encodeURIComponent('(otag:sneak')}`, { headers: authHeaders });
    assert.strictEqual(res.status, 400, `syntax error should be 400, got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.error, 'INVALID_QUERY');
    console.log('PASS: F4-TC3');

    // F4-TC4: unauthenticated requests are rejected by the auth gate.
    res = await fetch(`${base}/api/search?scope=collection&q=${encodeURIComponent('otag:sneak')}`);
    assert.ok(res.status === 401 || res.status === 403, `catalog query must require auth, got ${res.status}`);
    console.log('PASS: F4-TC4');
  } finally {
    server.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
    }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => { console.error('FAIL: collectioncatalog.e2e -', err.message); setTimeout(() => process.exit(1), 500); });
