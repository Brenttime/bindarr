// Route check for GET /api/auth/me under BOTH credential kinds.
//
// Regression: the de-Pokemon removal deleted the `safe` user projection, but
// the API-key branch of /me still returned it —
//   ReferenceError: safe is not defined
// — so every API-key call to /me 500'd while the session path looked fine.
// /me is the endpoint finance scripts and dashboards poll, which is what makes
// a silent break of the API-key path expensive to notice.
//
// The middleware is bypassed on purpose: it owns credential plumbing, and this
// test asserts the HANDLER'S contract — it must return the safe user object
// for a via_api_key request without throwing, and must not hand out secrets
// either way.
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-authme-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
// Seed the 'admin' user (id 1) so the handler has someone to return.
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');

function cleanup() {
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

// Pull the route handler off the express router: layer.route.stack is
// [authenticateToken, handler] for GET /me.
function getMeHandler(router) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/me') {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error('GET /me route not found on the auth router');
}

const jsonRes = () => {
  const body = { status: null, data: null };
  return {
    ...body,
    status(code) { this.status_ = code; return this; },
    json(data) { this.status_ = this.status_ || 200; this.data = data; return this; },
    _done() { return { status: this.status_ || 200, data: this.data }; },
  };
};

async function main() {
  await db.initDb();
  await db.run(`UPDATE users SET api_key = 'test-bnd-key' WHERE username = 'admin'`);

  const handler = getMeHandler(require('../src/routes/auth'));

  const userShape = async (viaApiKey) => {
    const req = {
      user: {
        id: 1,
        username: 'admin',
        role: 'admin',
        share_token: null,
        share_enabled: 0,
        api_key: 'test-bnd-key',
        via_api_key: viaApiKey,
      },
    };
    const res = jsonRes();
    await handler(req, res);
    return res._done();
  };

  // --- API-key branch: the one that used to throw -------------------------
  const byKey = await userShape(true);
  assert.strictEqual(byKey.status, 200, 'API-key /me must not 500');
  assert.strictEqual(byKey.data.user.id, 1);
  assert.strictEqual(byKey.data.user.username, 'admin');
  assert.strictEqual(byKey.data.user.via_api_key, true,
    'the credential kind must be visible to clients that gate on it');

  // --- session branch: unchanged behavior ----------------------------------
  const bySession = await userShape(false);
  assert.strictEqual(bySession.status, 200, 'session /me must not 500');
  assert.strictEqual(bySession.data.user.via_api_key, false);

  // --- no secret material may leak from /me --------------------------------
  const leaked = ['psa_api_token', 'graded_price_api_key', 'tcg_api_key', 'password_hash']
    .filter((k) => byKey.data.user[k] !== undefined && byKey.data.user[k] !== '');
  assert.deepStrictEqual(leaked, [], '/me must not return provider keys or the password hash');

  console.log('PASS: GET /me for API-key and session credentials');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error('FAIL:', err.stack || err.message); cleanup(); process.exit(1); });
