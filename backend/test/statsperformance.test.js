// Regression coverage for dashboard statistics semantics and bounded query shape.
// Plain node + assert; auto-discovered by test/run.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-stats-performance-${process.pid}.db`);
process.env.DB_PATH = dbPath;
const db = require('../src/db');
const statsRouter = require('../src/routes/stats');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const stamp = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

function handlerFor(routePath) {
  const layer = statsRouter.stack.find(candidate => candidate.route && candidate.route.path === routePath);
  assert.ok(layer, `missing ${routePath} route`);
  return layer.route.stack[0].handle;
}

async function request(routePath, userId, query = {}) {
  const handler = handlerFor(routePath);
  return new Promise((resolve, reject) => {
    const req = { user: { id: userId }, query };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function addCard(id, name, setId, setName, rarity, types, subtypes, prices = {}) {
  await db.run(`
    INSERT INTO card_cache
      (id, name, set_id, set_name, rarity, types, subtypes, supertype,
       price_trend, price_normal, price_holofoil)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, name, setId, setName, rarity, JSON.stringify(types), JSON.stringify(subtypes),
    prices.supertype || null, prices.trend ?? null, prices.normal ?? null, prices.holo ?? null]);
}

async function own(userId, cardId, quantity, printing, addedDaysAgo, purchasePrice = null, condition = 'Near Mint') {
  await db.run(`
    INSERT INTO collection
      (user_id, card_id, quantity, printing, added_at, purchase_price, condition)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, cardId, quantity, printing, stamp(addedDaysAgo), purchasePrice, condition]);
}

async function history(cardId, daysAgo, price) {
  await db.run(`INSERT INTO price_history (card_id, price, recorded_at) VALUES (?, ?, ?)`,
    [cardId, price, stamp(daysAgo)]);
}

async function main() {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    await db.initDb();
    const smallUser = (await db.run(`
      INSERT INTO users (username, password_hash, role, share_token)
      VALUES ('stats-small', 'x', 'member', 'stats-small-token')
    `)).lastID;
    const largeUser = (await db.run(`
      INSERT INTO users (username, password_hash, role, share_token)
      VALUES ('stats-large', 'x', 'member', 'stats-large-token')
    `)).lastID;

    await db.run(`INSERT INTO sets (id, name, printed_total, total) VALUES
      ('lea', 'Alpha', 295, 295), ('mrd', 'Mirrodin', 306, 306),
      ('xyz', 'Example', 1, 1), ('abc', 'Artifacts', 10, 10)`);
    await addCard('multi', 'Many Finishes', 'lea', 'Alpha', 'Rare', ['Creature'], ['Wizard'],
      { trend: 11, normal: 10, holo: 20 });
    await addCard('fallback', 'No History Land', 'mrd', 'Mirrodin', 'Common', [], ['Island'],
      { trend: 1, normal: 2, holo: 6 });
    await addCard('late-history', 'Late History', 'xyz', 'Example', 'Mythic', [], [],
      { trend: 100, normal: 100 });
    await addCard('boundary', 'Boundary', 'abc', 'Artifacts', 'Uncommon', ['Artifact', 'Creature'], [],
      { trend: 3, normal: 3 });

    // Four physical rows for one printing identity exercise stacked ownership;
    // history remains card-id scoped, while present value remains finish-aware.
    await own(smallUser, 'multi', 2, 'Normal', 60, 3);
    await own(smallUser, 'multi', 3, 'Holofoil', 40, 4, 'Lightly Played');
    await own(smallUser, 'multi', 4, 'Holofoil', 3, 5);
    await own(smallUser, 'multi', 5, 'Normal', 20, 2);
    await own(smallUser, 'fallback', 2, 'Normal', 10);
    await own(smallUser, 'fallback', 1, 'Holofoil', 10);
    await own(smallUser, 'late-history', 1, 'Normal', 100, 10);
    await own(smallUser, 'boundary', 2, 'Normal', 7, 1);

    await history('multi', 45, 4);
    await history('multi', 30, 5);
    await history('multi', 7, 7);
    await history('multi', 1, 9);
    await history('late-history', 2, 50); // carried backward by timeline semantics
    await history('boundary', 50, 1);
    await history('boundary', 7, 2);      // exact cutoff is inclusive
    await history('boundary', 0, 3);

    const stats = await request('/stats', smallUser);
    assert.strictEqual(stats.status, 200);
    assert.deepStrictEqual(stats.body.summary, {
      totalCards: 20,
      uniqueCards: 8,
      totalValue: 326,
      totalSpent: 60,
      roi: { abs: 266, pct: 443.3 },
      avgCardValue: 16.3,
      duplicateCopies: 12,
      mintRate: 85,
      vintageRatio: 70,
      change7d: { available: true, abs: 22, pct: 29.7 },
      change30d: { available: true, abs: 20, pct: 80 },
      change1y: { available: false, abs: null, pct: null },
      change5y: { available: false, abs: null, pct: null }
    });
    assert.deepStrictEqual(Object.fromEntries(stats.body.types.map(x => [x.name, x.value])),
      { Creature: 16, Land: 3, Colorless: 1, Artifact: 2 });
    assert.deepStrictEqual(Object.fromEntries(stats.body.rarities.map(x => [x.name, x.value])),
      { Rare: 14, Common: 3, Mythic: 1, Uncommon: 2 });
    assert.deepStrictEqual(Object.fromEntries(stats.body.sets.map(x => [x.id, [x.count, x.value]])),
      { lea: [14, 210], mrd: [3, 10], xyz: [1, 100], abc: [2, 6] });
    assert.strictEqual(stats.body.topValuable[0].card_id, 'late-history');
    assert.strictEqual(stats.body.topValuable[0].price_trend, 100);
    assert.strictEqual(stats.body.topValuable.filter(x => x.card_id === 'multi' && x.printing === 'Holofoil')[0].price_trend, 20);
    assert.deepStrictEqual(Object.fromEntries(stats.body.setProgress.map(x => [x.setId, x.ownedUnique])),
      { xyz: 1, abc: 1, lea: 1, mrd: 1 });

    const sevenDays = await request('/stats/history', smallUser, { period: '7d' });
    assert.strictEqual(sevenDays.status, 200);
    assert.deepStrictEqual(sevenDays.body.map(point => point.value), [134, 134, 134, 162, 162, 190, 192],
      'timeline must preserve earliest-point carryback, finish fallback, additions, and inclusive cutoffs');

    // More than SQLite's common 32,766 variable ceiling: neither dashboard route
    // may turn owned IDs into one generated placeholder list.
    const DISTINCT_IDS = 33000;
    await db.run(`
      WITH RECURSIVE ids(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < ?
      )
      INSERT INTO card_cache (id, name, set_id, set_name, rarity, types, subtypes, price_trend)
      SELECT printf('scale-%05d', n), printf('Scale card %05d', n), 'scale', 'Scale',
             'Common', '["Creature"]', '[]', 1
      FROM ids
    `, [DISTINCT_IDS]);
    await db.run(`
      INSERT INTO collection (user_id, card_id, quantity, printing, added_at)
      SELECT ?, id, 1, 'Normal', ? FROM card_cache WHERE id LIKE 'scale-%'
    `, [largeUser, stamp(100)]);

    const observedParamCounts = [];
    const originalAll = db.all;
    db.all = async (sql, params = []) => {
      observedParamCounts.push(params.length);
      return originalAll(sql, params);
    };
    try {
      const largeStats = await request('/stats', largeUser);
      assert.strictEqual(largeStats.status, 200, JSON.stringify(largeStats.body));
      assert.strictEqual(largeStats.body.summary.uniqueCards, DISTINCT_IDS);
      const largeHistory = await request('/stats/history', largeUser, { period: '7d' });
      assert.strictEqual(largeHistory.status, 200, JSON.stringify(largeHistory.body));
      assert.deepStrictEqual(largeHistory.body.map(point => point.value), Array(7).fill(DISTINCT_IDS));
    } finally {
      db.all = originalAll;
    }
    assert.ok(Math.max(...observedParamCounts) < 32766,
      `dashboard query used ${Math.max(...observedParamCounts)} bound variables`);

    console.log('statsperformance.test.js: all assertions passed');
  } finally {
    Date.now = originalDateNow;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ }
    }
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
