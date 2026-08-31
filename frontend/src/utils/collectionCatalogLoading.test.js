import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_BACKGROUND_PAGE_SIZE,
  CATALOG_INITIAL_PAGE_SIZE,
  FAST_CATALOG_DEBOUNCE_MS,
  LIVE_CATALOG_DEBOUNCE_MS,
  catalogDebounceMs,
  catalogRowsForQuery,
  loadCatalogCollection,
  mapWithConcurrency,
  reconcileCollectionHydration,
} from './collectionCatalogLoading.js';

function rows(from, to) {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => ({
    entry_id: from + index,
    name: `Card ${from + index}`,
  }));
}

function response(data, { status = 200, total = data.length, complete = true, cache = 'fresh', snapshot = 'local:1:0' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      'X-Total-Count': String(total),
      'X-Catalog-Complete': complete ? '1' : '0',
      'X-Catalog-Cache': cache,
      'X-Catalog-Snapshot': snapshot,
    }),
    json: async () => data,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function requestDetails(url) {
  const parsed = new URL(url, 'http://bindarr.test');
  return {
    query: parsed.searchParams.get('q'),
    page: Number(parsed.searchParams.get('page')),
    limit: Number(parsed.searchParams.get('limit')),
    snapshot: parsed.searchParams.get('snapshot'),
  };
}

test('bounded mapper preserves order and never exceeds requested concurrency', async () => {
  let active = 0;
  let maximum = 0;
  const gates = Array.from({ length: 5 }, () => deferred());
  const mapping = mapWithConcurrency([10, 20, 30, 40, 50], 2, async (value, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gates[index].promise;
    active -= 1;
    return value + 1;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  gates[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  gates[0].resolve();
  gates[2].resolve();
  gates[3].resolve();
  gates[4].resolve();
  assert.deepEqual(await mapping, [11, 21, 31, 41, 51]);
  assert.equal(maximum, 2);
});

test('first catalog page paints before background pages resolve, then commits in page order', async () => {
  const later = deferred();
  const painted = deferred();
  const calls = [];
  const controller = new AbortController();
  let firstState;
  let settled = false;

  const request = async (url, init) => {
    const details = requestDetails(url);
    calls.push({ ...details, signal: init.signal });
    if (details.limit === CATALOG_INITIAL_PAGE_SIZE) {
      return response(rows(1, 96), { total: 2105 });
    }
    return later.promise.then(() => response(
      details.page === 1 ? rows(1, 2000) : rows(2001, 2105),
      { total: 2105 },
    ));
  };

  const loading = loadCatalogCollection({
    query: 'otag:draw',
    signal: controller.signal,
    request,
    onFirstPage: state => {
      firstState = state;
      painted.resolve();
    },
  }).finally(() => { settled = true; });

  await painted.promise;
  assert.equal(settled, false, 'full hydration must still be pending when page 1 paints');
  assert.equal(firstState.rows.length, 96);
  assert.equal(firstState.incomplete, true, 'page 1 is explicitly partial while hydration runs');
  assert.equal(firstState.total, 2105);
  assert.deepEqual(calls.map(({ page, limit }) => ({ page, limit })), [
    { page: 1, limit: 96 },
    { page: 1, limit: 2000 },
    { page: 2, limit: 2000 },
  ]);
  assert.ok(calls.every(call => call.signal === controller.signal), 'every page receives the generation signal');

  later.resolve();
  const complete = await loading;
  assert.equal(complete.rows.length, 2105, 'short final page is retained');
  assert.equal(complete.incomplete, false);
  assert.deepEqual(complete.rows.map(row => row.entry_id), rows(1, 2105).map(row => row.entry_id));
});

test('superseded catalog generation aborts and cannot commit out-of-order background results', async () => {
  const oldBackground = deferred();
  const oldController = new AbortController();
  const newController = new AbortController();
  let currentQuery = 'otag:old';
  const commits = [];

  const request = async (url) => {
    const { query, page, limit } = requestDetails(url);
    if (query === 'otag:new') return response([{ entry_id: 900, name: 'New' }], { total: 1 });
    if (limit === CATALOG_INITIAL_PAGE_SIZE) return response(rows(1, 96), { total: 2001 });
    return oldBackground.promise.then(() => response(
      page === 1 ? rows(1, 2000) : rows(2001, 2001),
      { total: 2001 },
    ));
  };

  const oldLoad = loadCatalogCollection({
    query: 'otag:old',
    signal: oldController.signal,
    isCurrent: () => currentQuery === 'otag:old',
    request,
    onFirstPage: state => commits.push({ query: 'otag:old', count: state.rows.length }),
    onIncomplete: state => commits.push({ query: 'otag:old-error', count: state.rows.length }),
  }).then(state => commits.push({ query: 'otag:old-complete', count: state.rows.length }));

  while (!commits.length) await new Promise(resolve => setImmediate(resolve));
  currentQuery = 'otag:new';
  oldController.abort();
  const next = await loadCatalogCollection({
    query: 'otag:new',
    signal: newController.signal,
    isCurrent: () => currentQuery === 'otag:new',
    request,
  });
  commits.push({ query: 'otag:new', count: next.rows.length });
  oldBackground.resolve();
  await assert.rejects(oldLoad, error => error?.name === 'AbortError');

  assert.deepEqual(commits, [
    { query: 'otag:old', count: 96 },
    { query: 'otag:new', count: 1 },
  ]);
  assert.equal(catalogRowsForQuery({ queryKey: 'otag:old', rows: rows(1, 96) }, 'otag:new'), null,
    'rows cached for another query are never displayable as the new query');
});

test('failed background page retains first page as an explicit incomplete result', async () => {
  const controller = new AbortController();
  let incompleteState;
  const request = async (url) => {
    const { page, limit } = requestDetails(url);
    if (limit === CATALOG_INITIAL_PAGE_SIZE) return response(rows(1, 96), { total: 2100 });
    if (page === 2) return response({ error: 'still unavailable' }, { status: 503, total: 2100 });
    return response(rows(1, 2000), { total: 2100 });
  };

  await assert.rejects(
    loadCatalogCollection({
      query: 'otag:failure',
      signal: controller.signal,
      request,
      onIncomplete: state => { incompleteState = state; },
    }),
    error => error?.stage === 'background' && error?.status === 503,
  );
  assert.equal(incompleteState.rows.length, 96);
  assert.equal(incompleteState.incomplete, true);
  assert.equal(incompleteState.error.stage, 'background');
});

test('snapshot drift restarts once and never combines rows from different generations', async () => {
  const controller = new AbortController();
  let firstRequests = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const paintedSnapshots = [];
  const request = async (url) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    try {
    const { page, limit, snapshot } = requestDetails(url);
    if (limit === CATALOG_INITIAL_PAGE_SIZE) {
      firstRequests += 1;
      const current = firstRequests === 1 ? 'local:1:10' : 'local:2:11';
      return response(rows(firstRequests === 1 ? 1 : 3001, firstRequests === 1 ? 96 : 3096), {
        total: 2105,
        snapshot: current,
      });
    }
    if (snapshot === 'local:1:10') {
      // Keep one sibling alive after the other reports drift. The retry must
      // wait for it rather than creating a third concurrent request.
      if (page === 1) await new Promise(resolve => setTimeout(resolve, 1));
      if (page === 2) await new Promise(resolve => setTimeout(resolve, 20));
      return response({ error: 'CATALOG_SNAPSHOT_CHANGED' }, {
        status: 409,
        total: 2105,
        snapshot: 'local:2:11',
      });
    }
    return response(
      page === 1 ? rows(3001, 5000) : rows(5001, 5105),
      { total: 2105, snapshot: 'local:2:11' },
    );
    } finally {
      activeRequests -= 1;
    }
  };

  const result = await loadCatalogCollection({
    query: 'otag:changing',
    signal: controller.signal,
    request,
    onFirstPage: state => paintedSnapshots.push(state.rows[0].entry_id),
  });

  assert.deepEqual(paintedSnapshots, [1, 3001], 'a fresh first page replaces the stale generation');
  assert.equal(result.rows.length, 2105);
  assert.equal(result.incomplete, false);
  assert.equal(result.rows[0].entry_id, 3001);
  assert.equal(maxActiveRequests, 2, 'snapshot restart waits for active sibling requests');
  assert.ok(!result.rows.some(row => row.entry_id < 3001), 'no row from the stale snapshot survives');
});

test('ordinary collection hydration aborts for catalog mode and restarts once when local data is needed', () => {
  let state = { key: null, status: 'idle' };
  let decision = reconcileCollectionHydration('off', 'trigger-1|all', state);
  assert.equal(decision.action, 'start');
  state = { ...decision.state, status: 'partial' };

  decision = reconcileCollectionHydration('catalog', 'trigger-1|all', state);
  assert.equal(decision.action, 'abort');
  assert.equal(decision.state.status, 'aborted');
  state = decision.state;

  decision = reconcileCollectionHydration('catalog', 'trigger-1|all', state);
  assert.equal(decision.action, 'none', 'catalog rerenders do not duplicate abort/start chains');

  decision = reconcileCollectionHydration('local', 'trigger-1|all', state);
  assert.equal(decision.action, 'start', 'an aborted hydration restarts on return to local mode');
  state = { ...decision.state, status: 'complete' };

  decision = reconcileCollectionHydration('error', 'trigger-1|all', state);
  assert.equal(decision.action, 'none', 'a complete same-key collection is not downloaded twice');
  decision = reconcileCollectionHydration('off', 'trigger-2|all', state);
  assert.equal(decision.action, 'start', 'a data refresh key still starts a fresh hydration');
});

test('otag plus safe local operators uses the short debounce; extras-implying operators stay conservative', () => {
  assert.equal(catalogDebounceMs(['otag']), FAST_CATALOG_DEBOUNCE_MS);
  assert.equal(catalogDebounceMs(['otag', 'rarity']), FAST_CATALOG_DEBOUNCE_MS);
  assert.equal(catalogDebounceMs(['is', 'otag']), LIVE_CATALOG_DEBOUNCE_MS);
  assert.equal(catalogDebounceMs(['type', 'otag']), LIVE_CATALOG_DEBOUNCE_MS);
  assert.equal(catalogDebounceMs(['set', 'otag']), LIVE_CATALOG_DEBOUNCE_MS);
  assert.equal(catalogDebounceMs(['artist']), LIVE_CATALOG_DEBOUNCE_MS);
  assert.equal(catalogDebounceMs(['otag', 'availability']), LIVE_CATALOG_DEBOUNCE_MS);
  assert.equal(CATALOG_BACKGROUND_PAGE_SIZE, 2000);
});
