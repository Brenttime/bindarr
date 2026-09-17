// Node-side harness for the pure logic in src/utils/marketRelay.js.
//
// The relay's credential path is: the popup writes localStorage[key]; the
// Bindarr tab's 500ms poll reads, validates, and resolves/rejects. The
// VALIDATION side must be pinned down - a payload from the other source, a
// stale error payload, or garbage must never resolve as a credential.
//
// The browser half (window.open, document.cookie, the javascript: relay bodies)
// can only be exercised in a real browser - that is the e2e pass, not a
// shortcut. This file proves the state machine end to end (it drives real
// 500ms poll timers, so it takes a few seconds). Run: node test/marketrelay.test.mjs
import assert from 'node:assert';
import { startMarketRelay, RELAY_KEY } from '../src/utils/marketRelay.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis; // module reads window.open only via openFn here

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const opener = () => ({ closed: false });
function ok(source) {
  return source === 'manapool'
    ? JSON.stringify({ source: 'manapool', token: 'tok_'.padEnd(30, 'x'), email: ' me@ex.com ' })
    : JSON.stringify({ source: 'tcgplayer', cookies: 'a=1; b=2' });
}

// --- accepted: payload resolves with the right fields, key consumed ------------
{
  store.clear();
  const p = startMarketRelay('manapool', {}, opener);
  await settle();
  store.set(RELAY_KEY, ok('manapool'));
  const payload = await p;
  assert.strictEqual(payload.source, 'manapool');
  assert.ok(payload.token.length >= 24, 'token passed through');
  assert.strictEqual(payload.email, ' me@ex.com ', 'payload fields pass through untouched (trimming is the caller’s job)');
  assert.strictEqual(store.has(RELAY_KEY), false, 'relay key consumed on delivery');
}

// --- rejection paths: the promise REJECTS with the right code, key consumed ----
const rejects = [
  ['source mismatch', 'manapool', () => ok('tcgplayer'), /RELAY_SOURCE_MISMATCH/],
  ['relay error: no token', 'manapool', () => JSON.stringify({ source: 'manapool', error: 'no-token-found' }), /TOKEN_NOT_FOUND/],
  ['relay error: no cookies', 'tcgplayer', () => JSON.stringify({ source: 'tcgplayer', error: 'no-cookies' }), /TCG_NO_COOKIES/],
  ['garbage payload', 'manapool', () => '{not json', /RELAY_GARBAGE/],
];
for (const [name, source, raw, rx] of rejects) {
  store.clear();
  const p = startMarketRelay(source, {}, opener);
  await settle();
  store.set(RELAY_KEY, raw());
  await assert.rejects(p, rx, name);
  assert.strictEqual(store.has(RELAY_KEY), false, );
}

// --- popup closed before anything arrives -> POPUP_CLOSED, not a hang ----------
{
  store.clear();
  const p = startMarketRelay('manapool', {}, () => ({ closed: true }));
  await assert.rejects(p, /POPUP_CLOSED/);
}

// --- unknown source / blocked popup: reject without ever opening ---------------
{
  let opened = 0;
  await assert.rejects(startMarketRelay('ebay', {}, () => { opened++; return { closed: false }; }), /unknown marketplace/);
  assert.strictEqual(opened, 0);
  await assert.rejects(startMarketRelay('manapool', {}, () => null), /POPUP_BLOCKED/);
}

// --- cancel handle fails the pending relay and stops the poll ------------------
{
  store.clear();
  let cancel = null;
  const p = startMarketRelay('manapool', { onStatus: (fn) => { cancel = fn; } }, opener);
  await settle();
  assert.strictEqual(typeof cancel, 'function', 'cancel handle provided');
  cancel();
  await assert.rejects(p, /USER_CANCELLED/);
  // a payload arriving AFTER cancellation proves the poll really stopped
  store.set(RELAY_KEY, ok('manapool'));
  await settle(700); // > one poll tick
  assert.strictEqual(store.has(RELAY_KEY), true, 'poll stopped: post-cancel payload left alone');
  store.clear();
}

console.log('marketrelay.test.mjs: all assertions passed');
