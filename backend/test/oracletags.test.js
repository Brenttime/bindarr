// Local Oracle Tags index, hierarchy, collection SQL, generation safety and
// oracle_id persistence/backfill. All provider payloads are tiny gzipped JSONL
// fixtures; no real network is permitted.
const assert = require('assert');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

process.env.SCRYFALL_GAP_SCALE = '0';
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-oracle-tags-${process.pid}.db`);
const db = require('../src/db');
const oracleTags = require('../src/oracleTags');
const scryfallApi = require('../src/scryfallApi');
const { analyze } = require('../../shared/scryfallQuery');

const TAGS = [
  {
    object: 'tag', type: 'oracle', id: 'tag-interaction', slug: 'interaction',
    label: 'Interaction', aliases: ['interact'], child_ids: ['tag-removal', 'tag-bounce'], taggings: [],
  },
  {
    object: 'tag', type: 'oracle', id: 'tag-removal', slug: 'removal',
    label: 'Removal', parent_ids: ['tag-interaction'],
    taggings: [
      { oracle_id: 'oracle-one', weight: 'strong' },
      { oracle_id: 'oracle-two', weight: 'median' },
    ],
  },
  {
    object: 'tag', type: 'oracle', id: 'tag-bounce', slug: 'bounce',
    label: 'Bounce', parent_ids: ['tag-interaction'],
    // oracle-one is deliberately tagged under two descendants. An EXISTS-based
    // parent match must still return its collection row once.
    taggings: [
      { oracle_id: 'oracle-one', weight: 'median' },
      { oracle_id: 'oracle-four', weight: 'weak' },
    ],
  },
  {
    object: 'tag', type: 'oracle', id: 'tag-ramp', slug: 'ramp', label: 'Ramp',
    taggings: [
      { oracle_id: 'oracle-three', weight: 'strong' },
      { oracle_id: 'oracle-plane', weight: 'strong' },
    ],
  },
];

function jsonlGzip(objects) {
  return zlib.gzipSync(Buffer.from(objects.map(value => JSON.stringify(value)).join('\n') + '\n'));
}

function fakeBulkHttp(type, updatedAt, bytes, url = `https://fixtures.invalid/${type}.jsonl.gz`) {
  return {
    async get(request) {
      if (request === `https://api.scryfall.com/bulk-data/${type}`) {
        return { data: { object: 'bulk_data', type, updated_at: updatedAt, jsonl_download_uri: url } };
      }
      if (request === url) return { data: Readable.from([bytes]) };
      throw new Error(`unexpected fixture URL: ${request}`);
    },
  };
}

async function seedOwned(userId) {
  const rows = [
    ['mtg-card-one', 'oracle-one', 'One Mana Answer', 'Common', ['Instant']],
    ['mtg-card-two', 'oracle-two', 'Rare Answer', 'Rare', ['Instant']],
    ['mtg-card-three', 'oracle-three', 'Ramp Creature', 'Common', ['Creature']],
    ['mtg-card-four', 'oracle-four', 'Bounce Creature', 'Uncommon', ['Creature']],
    ['mtg-card-plane', 'oracle-plane', 'Ramp Plane', 'Common', ['Plane'], 0],
  ];
  for (const [id, oracleId, name, rarity, subtypes, eligible = 1] of rows) {
    await db.run(
      `INSERT INTO card_cache
        (id, oracle_id, scryfall_search_eligible, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, color_identity, language)
       VALUES (?, ?, ?, ?, '', ?, '[]', ?, 'tst', 'Test', ?, '[]', 'English')`,
      [id, oracleId, eligible, name, JSON.stringify(subtypes), rarity, id.slice(-3)],
    );
    await db.run(
      `INSERT INTO collection (card_id, user_id, quantity, added_at)
       VALUES (?, ?, 1, '2026-01-01 00:00:00')`,
      [id, userId],
    );
  }
}

async function main() {
  await db.initDb();
  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token)
     VALUES ('oracle-user', 'x', 'member', 'oracle-share')`,
  );
  await seedOwned(user.lastID);
  const imported = await oracleTags.importTagObjects(TAGS, '2026-08-30T00:00:00Z');
  assert.strictEqual(imported.tags, 4);
  assert.strictEqual(imported.assignments, 6);
  assert.strictEqual(await oracleTags.isReady(), true, 'active tags + complete card identities make the local index ready');
  for (const query of [
    'otag:token-version-of-a-card type:token',
    'otag:token-version-of-a-card set:t40k',
    'otag:token-version-of-a-card is:token',
    'otag:token-version-of-a-card name:token',
    'otag:token-version-of-a-card number:1',
    'otag:token-version-of-a-card token',
    'otag:token-version-of-a-card "token card"',
  ]) {
    assert.strictEqual(oracleTags.supportsLocalCollectionQuery(analyze(query)), false,
      `${query} must fall back because Scryfall can implicitly include extras`);
  }

  // Any Scryfall call is a test failure: all of these catalog-classified otag
  // queries must compile to SQLite once the index is ready.
  let upstreamCalls = 0;
  scryfallApi.client.defaults.adapter = async () => {
    upstreamCalls += 1;
    throw new Error('local otag query reached Scryfall');
  };

  let result = await scryfallApi.resolveCollectionQuery({
    q: 'otag:interaction', userId: user.lastID, rowLimit: 20,
  });
  assert.strictEqual(upstreamCalls, 0, 'local otag makes no /cards/search request');
  assert.strictEqual(result.cacheStatus, 'local');
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.total, 3, 'parent tag includes direct assignments of all descendants');
  assert.deepStrictEqual(
    result.cards.map(card => card.name).sort(),
    ['Bounce Creature', 'One Mana Answer', 'Rare Answer'],
  );
  assert.strictEqual(result.cards.filter(card => card.oracle_id === 'oracle-one').length, 1,
    'a card tagged under two descendants is not duplicated');

  result = await scryfallApi.resolveCollectionQuery({
    q: 'otag:interact', userId: user.lastID, rowLimit: 20,
  });
  assert.strictEqual(result.total, 3, 'current tag aliases resolve to the stable tag UUID');

  result = await scryfallApi.resolveCollectionQuery({
    q: '(otag:interaction rarity:rare) or (otag:ramp rarity:common)',
    userId: user.lastID, rowLimit: 20,
  });
  assert.deepStrictEqual(result.cards.map(card => card.name).sort(), ['Ramp Creature', 'Rare Answer'],
    'mixed AND/OR query preserves AST semantics');
  assert.ok(!result.cards.some(card => card.name === 'Ramp Plane'),
    'default local search excludes supplemental plane/token-style objects like /cards/search');

  result = await scryfallApi.resolveCollectionQuery({
    q: 'otag:interaction -rarity:rare', userId: user.lastID, rowLimit: 20,
  });
  assert.deepStrictEqual(result.cards.map(card => card.name).sort(), ['Bounce Creature', 'One Mana Answer'],
    'negated local operator compiles inside an otag query');

  result = await scryfallApi.resolveCollectionQuery({
    q: '-otag:interaction', userId: user.lastID, rowLimit: 20,
  });
  assert.deepStrictEqual(result.cards.map(card => card.name), ['Ramp Creature'],
    'negating otag itself excludes the complete descendant set');

  // Pagination counts the complete matching catalog but returns independent,
  // deterministic local row windows with no overlap.
  const page1 = await scryfallApi.resolveCollectionQuery({
    q: 'otag:interaction or otag:ramp', userId: user.lastID, rowLimit: 2, rowOffset: 0,
  });
  const page2 = await scryfallApi.resolveCollectionQuery({
    q: 'otag:interaction or otag:ramp', userId: user.lastID, rowLimit: 2, rowOffset: 2,
  });
  assert.strictEqual(page1.total, 4);
  assert.strictEqual(page2.total, 4);
  assert.strictEqual(page1.cards.length, 2);
  assert.strictEqual(page2.cards.length, 2);
  const ids = [...page1.cards, ...page2.cards].map(card => card.entry_id);
  assert.strictEqual(new Set(ids).size, 4, 'stable added_at DESC, id DESC pages have no duplicate rows');
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => b - a), 'pages preserve deterministic newest-first order');

  // Coverage and result rows share one read snapshot. Insert an unresolved owned
  // card after readiness is established but before the local SELECT; the answer
  // remains complete for its pinned snapshot, and the next readiness check sees
  // the mutation and fails closed.
  const originalIsReady = oracleTags.isReady;
  let insertedDuringRead = false;
  oracleTags.isReady = async (readDb, ownerId) => {
    const ready = await originalIsReady(readDb, ownerId);
    if (ready && !insertedDuringRead) {
      insertedDuringRead = true;
      await db.run(`INSERT INTO card_cache (id, name, language)
        VALUES ('mtg-race-unresolved', 'Race Unresolved', 'English')`);
      await db.run(`INSERT INTO collection (card_id, user_id, quantity, added_at)
        VALUES ('mtg-race-unresolved', ?, 1, '2026-01-01 00:00:00')`, [user.lastID]);
    }
    return ready;
  };
  try {
    const pinned = await scryfallApi.resolveCollectionQuery({
      q: 'otag:interaction', userId: user.lastID, rowLimit: 20,
    });
    assert.strictEqual(pinned.cacheStatus, 'local');
    assert.strictEqual(pinned.complete, true);
    assert.strictEqual(pinned.total, 3, 'read transaction reports one internally consistent snapshot');
  } finally {
    oracleTags.isReady = originalIsReady;
  }
  assert.strictEqual(await oracleTags.isReady(db, user.lastID), false,
    'a later request sees the newly owned unresolved card and must use fallback');
  await db.run(`DELETE FROM collection WHERE card_id = 'mtg-race-unresolved'`);
  await db.run(`DELETE FROM card_cache WHERE id = 'mtg-race-unresolved'`);

  // A failed daily refresh never changes the active generation.
  const before = await db.get('SELECT id, source_updated_at FROM oracle_tag_generations WHERE active = 1');
  const broken = Buffer.from(`${JSON.stringify(TAGS[0])}\n{broken-json\n`);
  await assert.rejects(
    () => oracleTags.refreshOracleTags({
      force: true,
      now: Date.now(),
      http: fakeBulkHttp('oracle_tags', '2026-08-31T00:00:00Z', broken),
    }),
    /Invalid JSONL/,
  );
  const after = await db.get('SELECT id, source_updated_at FROM oracle_tag_generations WHERE active = 1');
  assert.deepStrictEqual(after, before, 'failed refresh retains the prior active generation');
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM oracle_tag_generations')).n, 1,
    'failed refresh leaves no partial generation');
  assert.strictEqual((await db.get('SELECT oracle_tags_checked_at AS at FROM app_settings WHERE id = 1')).at, null,
    'a failed refresh does not advance the daily success gate');

  // Fault-inject after several committed staging batches. The incomplete
  // generation is never active and is reaped without disturbing the prior one.
  let stagingTransactions = 0;
  const injectedDb = {
    ...db,
    withDedicatedTransaction: async (fn) => {
      stagingTransactions += 1;
      if (stagingTransactions === 2) throw new Error('injected mid-import failure');
      return db.withDedicatedTransaction(fn);
    },
  };
  await assert.rejects(
    () => oracleTags.importTagObjects(TAGS, '2026-08-31T01:00:00Z', { dbClient: injectedDb }),
    /injected mid-import failure/,
  );
  assert.ok(stagingTransactions >= 2, 'fault was injected after a committed staging transaction');
  assert.deepStrictEqual(
    await db.get('SELECT id, source_updated_at FROM oracle_tag_generations WHERE active = 1'),
    before,
    'mid-transaction failure preserves the old active generation',
  );
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM oracle_tag_generations')).n, 1,
    'mid-transaction failure leaves no inactive generation residue');
  const current = await oracleTags.refreshOracleTags({
    force: true,
    now: Date.now(),
    http: fakeBulkHttp('oracle_tags', '2026-08-30T00:00:00Z', jsonlGzip(TAGS)),
  });
  assert.strictEqual(current.status, 'current', 'verified current metadata advances the daily gate');
  const notDue = await oracleTags.refreshOracleTags({
    now: Date.now(),
    http: { get: async () => { throw new Error('refresh ran more than once today'); } },
  });
  assert.strictEqual(notDue.status, 'not-due', 'successful checks are durably limited to once per day');

  // Production-sized staging must yield SQLite's writer between bounded batch
  // statements. Pause after one committed staging chunk and prove an
  // ordinary collection mutation completes before the import is released.
  let stagingStartedResolve;
  let releaseStagingResolve;
  const stagingStarted = new Promise(resolve => { stagingStartedResolve = resolve; });
  const releaseStaging = new Promise(resolve => { releaseStagingResolve = resolve; });
  let paused = false;
  const yieldingDb = {
    ...db,
    withDedicatedTransaction: async (fn) => {
      const result = await db.withDedicatedTransaction(fn);
      if (!paused) {
        paused = true;
        stagingStartedResolve();
        await releaseStaging;
      }
      return result;
    },
  };
  const largeTag = {
    ...TAGS[0],
    id: 'tag-large-import',
    slug: 'large-import',
    aliases: ['large-import'],
    parent_ids: [],
    child_ids: [],
    taggings: Array.from({ length: 5000 }, (_, index) => ({ oracle_id: `large-oracle-${index}` })),
  };
  let importSettled = false;
  const largeImport = oracleTags.importTagObjects([largeTag], '2026-09-01T00:00:00Z', {
    dbClient: yieldingDb,
  }).finally(() => { importSettled = true; });
  await stagingStarted;
  await db.run('UPDATE collection SET notes = ? WHERE user_id = ?', ['writer-yield-probe', user.lastID]);
  assert.strictEqual(importSettled, false, 'user write completed while the import was paused between batches');
  releaseStagingResolve();
  await largeImport;

  // Every newly normalized/cached card permanently stores raw.oracle_id.
  const normalized = scryfallApi.normalizeCard({
    id: 'fresh-print', oracle_id: 'oracle-fresh', name: 'Fresh Card', lang: 'en',
    set: 'tst', set_name: 'Test', collector_number: '99', rarity: 'common', layout: 'normal',
  });
  assert.strictEqual(normalized.oracle_id, 'oracle-fresh');
  const reversible = scryfallApi.normalizeCard({
    id: 'reversible-print', name: 'Front // Back', lang: 'en', set: 'tst', layout: 'reversible_card',
    set_name: 'Test', collector_number: '100', rarity: 'rare',
    card_faces: [
      { name: 'Front', oracle_id: 'oracle-reversible' },
      { name: 'Back', oracle_id: 'oracle-reversible' },
    ],
  });
  assert.strictEqual(reversible.oracle_id, 'oracle-reversible',
    'reversible cards inherit the shared Oracle identity exposed on their faces');
  await scryfallApi.cacheCards([normalized]);
  assert.strictEqual((await db.get('SELECT oracle_id FROM card_cache WHERE id = ?', [normalized.id])).oracle_id,
    'oracle-fresh', 'cache upsert persists oracle_id');

  // One-time legacy backfill streams Default Cards for exact English printing
  // ids, then sends only unresolved rows through the existing batched resolver.
  await db.run(`INSERT INTO card_cache (id, name, language) VALUES ('mtg-bulk-print', 'Bulk Legacy', 'English')`);
  await db.run(`INSERT INTO card_cache (id, name, language) VALUES ('mtg-fallback-print', 'Fallback Legacy', 'Japanese')`);
  await db.run('UPDATE app_settings SET oracle_id_backfill_completed_at = NULL WHERE id = 1');
  let fallbackRows = null;
  const backfill = await oracleTags.backfillOracleIds({
    force: true,
    now: Date.now(),
    http: fakeBulkHttp('default_cards', '2026-08-31T00:00:00Z', jsonlGzip([
      { id: 'bulk-print', oracle_id: 'oracle-bulk', lang: 'en', layout: 'normal' },
      // Must not apply: exact id but not an English Default Cards printing.
      { id: 'fallback-print', oracle_id: 'wrong-language-oracle', lang: 'ja' },
    ])),
    bulkFetchByIdentifier: async (rows) => {
      fallbackRows = rows;
      const row = rows.find(value => value.id === 'mtg-fallback-print');
      return { pairs: row ? [{ row, card: { oracle_id: 'oracle-fallback', layout: 'normal' } }] : [] };
    },
  });
  assert.strictEqual(backfill.bulk, 1);
  assert.strictEqual(backfill.fallback, 1);
  assert.ok(fallbackRows.some(row => row.id === 'mtg-fallback-print'));
  assert.strictEqual((await db.get(`SELECT oracle_id FROM card_cache WHERE id = 'mtg-bulk-print'`)).oracle_id, 'oracle-bulk');
  assert.strictEqual((await db.get(`SELECT oracle_id FROM card_cache WHERE id = 'mtg-fallback-print'`)).oracle_id, 'oracle-fallback');
  assert.ok((await db.get('SELECT oracle_id_backfill_completed_at AS at FROM app_settings WHERE id = 1')).at,
    'completed backfill is durable and will not repeat on startup');

  // Readiness is scoped to the querying owner. An unrelated legacy cache row
  // must not disable local search for this user, while an owned unresolved row
  // must fail closed to the remote compatibility path even after a backfill run
  // has been marked complete.
  const other = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token)
     VALUES ('oracle-missing-user', 'x', 'member', 'oracle-missing-share')`,
  );
  await db.run(`INSERT INTO card_cache (id, name, language) VALUES ('mtg-never-resolved', 'Unknown Legacy', 'English')`);
  assert.strictEqual(await oracleTags.isReady(db, user.lastID), true,
    'unowned unresolved cache rows do not disable a complete owner');
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity) VALUES ('mtg-never-resolved', ?, 1)`,
    [other.lastID],
  );
  assert.strictEqual(await oracleTags.isReady(db, other.lastID), false,
    'an owned unresolved identity cannot produce a silently incomplete local tag answer');
  const residualRetry = await oracleTags.backfillOracleIds({
    http: { get: async () => { throw new Error('completed bulk scan must not repeat'); } },
    bulkFetchByIdentifier: async rows => ({
      pairs: [{
        row: rows.find(value => value.id === 'mtg-never-resolved'),
        card: {
          layout: 'reversible_card',
          card_faces: [
            { oracle_id: 'oracle-residual' },
            { oracle_id: 'oracle-residual' },
          ],
        },
      }],
    }),
  });
  assert.strictEqual(residualRetry.bulk, 0, 'completed Default Cards scan is not downloaded again');
  assert.strictEqual(residualRetry.fallback, 1, 'residual identities are retried through the small exact-id path');
  assert.strictEqual(await oracleTags.isReady(db, other.lastID), true,
    'a recovered reversible identity enables the local path for its owner');

  console.log('oracletags.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
