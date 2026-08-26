import assert from 'node:assert';
import { fetchWithRetry } from './fetchWithRetry.js';

let calls = 0;
let response = await fetchWithRetry('/transient', {}, {
  baseDelayMs: 0,
  fetchImpl: async () => {
    calls += 1;
    return new Response('', { status: calls < 3 ? 503 : 200 });
  },
});
assert.strictEqual(response.status, 200);
assert.strictEqual(calls, 3, 'transient 5xx responses are retried');

calls = 0;
response = await fetchWithRetry('/bad-request', {}, {
  baseDelayMs: 0,
  fetchImpl: async () => {
    calls += 1;
    return new Response('', { status: 400 });
  },
});
assert.strictEqual(response.status, 400);
assert.strictEqual(calls, 1, 'non-transient 4xx responses are not retried');

calls = 0;
response = await fetchWithRetry('/network', {}, {
  baseDelayMs: 0,
  fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('network dropped');
    return new Response('', { status: 200 });
  },
});
assert.strictEqual(response.status, 200);
assert.strictEqual(calls, 2, 'network errors are retried');

const controller = new AbortController();
controller.abort();
await assert.rejects(
  fetchWithRetry('/aborted', { signal: controller.signal }, {
    baseDelayMs: 0,
    fetchImpl: async () => { throw controller.signal.reason; },
  }),
  error => error?.name === 'AbortError'
);

console.log('PASS: fetchWithRetry.test.js');
