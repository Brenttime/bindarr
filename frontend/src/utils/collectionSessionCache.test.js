import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCollectionSessionCache,
  makeCollectionSessionQuery,
} from './collectionSessionCache.js';

function query(authKey, revision, tradeOnly = false) {
  return makeCollectionSessionQuery({ authKey, revision, tradeOnly });
}

function rows(...ids) {
  return ids.map(entry_id => ({ entry_id }));
}

test('cache isolates auth sessions, collection revisions, and trade mode', () => {
  const cache = createCollectionSessionCache({ maxEntries: 8 });
  const alice = query('alice-token', 4);
  const bob = query('bob-token', 4);
  const revised = query('alice-token', 5);
  const trade = query('alice-token', 4, true);

  const lease = cache.begin(alice);
  assert.equal(cache.write(lease, { rows: rows(1, 2), total: 2, status: 'complete' }), true);

  assert.deepEqual(cache.read(alice)?.rows, rows(1, 2));
  assert.equal(cache.read(bob), null);
  assert.equal(cache.read(revised), null);
  assert.equal(cache.read(trade), null);
});

test('cache retains sets with the auth session without crossing identities', () => {
  const cache = createCollectionSessionCache({ maxEntries: 4 });
  const alice = query('alice-token', 1);
  const bob = query('bob-token', 1);

  cache.setSets(alice, [{ code: 'lea', name: 'Limited Edition Alpha' }]);
  cache.write(cache.begin(alice), { rows: rows(1), total: 1, status: 'complete' });
  cache.write(cache.begin(bob), { rows: rows(9), total: 1, status: 'complete' });

  assert.equal(cache.read(alice).sets[0].code, 'lea');
  assert.equal(cache.read(alice).setsReady, true);
  assert.equal(cache.readSets(query('alice-token', 2)).sets[0].code, 'lea',
    'set metadata survives collection revision changes within the auth session');
  assert.deepEqual(cache.read(bob).sets, []);
  assert.equal(cache.read(bob).setsReady, false);
});

test('bounded LRU eviction prevents revisions and toggles growing without limit', () => {
  const cache = createCollectionSessionCache({ maxEntries: 2 });
  const first = query('session', 1);
  const second = query('session', 2);
  const third = query('session', 3, true);

  cache.write(cache.begin(first), { rows: rows(1), total: 1, status: 'complete' });
  cache.write(cache.begin(second), { rows: rows(2), total: 1, status: 'complete' });
  cache.read(first); // first is now the most recently used entry
  cache.write(cache.begin(third), { rows: rows(3), total: 1, status: 'complete' });

  assert.equal(cache.size, 2);
  assert.ok(cache.read(first));
  assert.equal(cache.read(second), null);
  assert.ok(cache.read(third));
});

test('partial and failed entries never masquerade as complete cache hits', () => {
  const cache = createCollectionSessionCache({ maxEntries: 4 });
  const current = query('session', 7);
  let lease = cache.begin(current);

  cache.write(lease, { rows: rows(1), total: 2, status: 'partial' });
  assert.equal(cache.read(current).complete, false);
  assert.equal(cache.read(current).status, 'partial');

  cache.write(lease, { rows: rows(1), total: 2, status: 'complete' });
  assert.equal(cache.read(current).complete, false, 'row-count mismatch is still partial');
  assert.equal(cache.read(current).status, 'partial');

  cache.write(lease, { rows: rows(1, 1), total: 2, status: 'complete' });
  assert.equal(cache.read(current).complete, false, 'duplicate stable IDs are not a complete result');

  cache.write(lease, { rows: rows(1), total: 2, status: 'error', error: 'page failed' });
  assert.equal(cache.read(current).complete, false);
  assert.equal(cache.read(current).status, 'error');
  assert.equal(cache.read(current).error, 'page failed');

  lease = cache.begin(current);
  cache.write(lease, { rows: rows(1, 2), total: 2, status: 'complete' });
  assert.equal(cache.read(current).complete, true);
  assert.equal(cache.read(current).status, 'complete');
});

test('invalidation removes matching data and rejects its outstanding generation', () => {
  const cache = createCollectionSessionCache({ maxEntries: 4 });
  const oldRevision = query('session', 10);
  const nextRevision = query('session', 11);
  const lease = cache.begin(oldRevision);

  cache.write(lease, { rows: rows(1), total: 2, status: 'partial' });
  cache.invalidate(oldRevision);

  assert.equal(cache.read(oldRevision), null);
  assert.equal(cache.read(nextRevision), null);
  assert.equal(cache.write(lease, { rows: rows(1, 2), total: 2, status: 'complete' }), false);
});

test('superseded generations cannot write rows or completion state', () => {
  const cache = createCollectionSessionCache({ maxEntries: 4 });
  const current = query('session', 12);
  const stale = cache.begin(current);
  const active = cache.begin(current);

  assert.equal(cache.write(stale, { rows: rows(1), total: 1, status: 'complete' }), false);
  assert.equal(cache.read(current), null);
  assert.equal(cache.write(active, { rows: rows(2), total: 1, status: 'complete' }), true);
  assert.deepEqual(cache.read(current).rows, rows(2));
});

test('mocked visit gate makes a complete warm revisit request-free and revision fetch again', async () => {
  const cache = createCollectionSessionCache({ maxEntries: 4 });
  const calls = [];
  const request = async resource => {
    calls.push(resource);
    return resource === 'sets' ? [{ code: 'lea' }] : rows(1, 2);
  };
  const visit = async current => {
    const cached = cache.read(current);
    const cachedSets = cache.readSets(current);
    if (!cachedSets?.setsReady) cache.setSets(current, await request('sets'));
    if (cached?.complete) return cached.rows;
    const loaded = await request('collection');
    cache.write(cache.begin(current), { rows: loaded, total: loaded.length, status: 'complete' });
    return loaded;
  };

  await visit(query('session', 20));
  assert.deepEqual(calls, ['sets', 'collection']);
  await visit(query('session', 20));
  assert.deepEqual(calls, ['sets', 'collection'], 'warm revisit makes zero collection/sets requests');
  await visit(query('session', 21));
  assert.deepEqual(calls, ['sets', 'collection', 'collection'],
    'collection revision misses rows but retains auth-scoped set metadata');
});
