import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, allocate } from './landCalc.js';
import { MANA_TYPES, allocateMana } from './landMana.js';

const ids = ['W', 'U', 'B', 'R', 'G', 'C'];
const record = (values = {}) => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...values });
const row = (quantity, produces, flags = {}) => ({ quantity, produces, ...flags });
const sum = object => Object.values(object).reduce((a, b) => a + b, 0);
function* vectors(length, maximum) {
  if (!length) { yield []; return; }
  for (let value = 0; value <= maximum; value++) {
    for (const rest of vectors(length - 1, maximum)) yield [value, ...rest];
  }
}
function* splits(total, length) {
  if (length === 1) { yield [total]; return; }
  for (let value = 0; value <= total; value++) {
    for (const rest of splits(total - value, length - 1)) yield [value, ...rest];
  }
}
let seed = 0x179245;
const random = maximum => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % maximum;
};

test('six immutable mana metadata entries extend the existing five colors', () => {
  assert.deepEqual(MANA_TYPES, [...COLORS, { id: 'C', name: 'Colorless', land: 'Wastes' }]);
  assert.ok(Object.isFrozen(MANA_TYPES));
  assert.ok(MANA_TYPES.every(Object.isFrozen));
});

test('17 slots, equal W/U, two duals and one C land', () => {
  const result = allocateMana(17, { W: 1, U: 1 }, [row(2, ['W', 'U']), row(1, ['C'])]);
  assert.equal(result.existingCount, 3);
  assert.equal(result.remainingBasics, 14);
  assert.deepEqual(result.basics, record({ W: 7, U: 7 }));
  assert.deepEqual(result.sources, record({ W: 9, U: 9, C: 1 }));
  assert.deepEqual(result.targets, record({ W: 9, U: 9 }));
  assert.deepEqual(result.shares, record({ W: 0.5, U: 0.5 }));
});

test('asymmetric fixing adjusts balance instead of splitting leftovers', () => {
  const result = allocateMana(10, { W: 1, U: 1 }, [row(4, ['W'])]);
  assert.deepEqual(result.basics, record({ W: 1, U: 5 }));
  assert.notDeepEqual(result.basics, record({ ...allocate(6, { W: 1, U: 1 }).lands }));
  assert.deepEqual(result.sources, record({ W: 5, U: 5 }));
  const blue = allocateMana(10, { U: 1 }, [row(4, ['W'])]);
  assert.deepEqual(blue.basics, record({ U: 6 }));
  assert.deepEqual(blue.targets, record({ U: 6 }));
  assert.deepEqual(blue.sources, record({ W: 4, U: 6 }));
});

test('C demand allocates Wastes; a C-only slot is not colored fixing', () => {
  assert.deepEqual(allocateMana(5, { C: 3 }).basics, record({ C: 5 }));
  const fixed = [row(1, ['C'])];
  assert.deepEqual(allocateMana(5, { W: 1 }, fixed).basics, record({ W: 4 }));
  assert.deepEqual(allocateMana(5, { W: 1, C: 1 }, fixed).basics, record({ W: 3, C: 1 }));
});

test('any-color land has five potential sources but occupies one physical slot and no C', () => {
  const result = allocateMana(1, { W: 1 }, [row(1, ids.slice(0, 5))]);
  assert.equal(result.existingCount, 1);
  assert.equal(result.remainingBasics, 0);
  assert.deepEqual(result.existingSources, record({ W: 1, U: 1, B: 1, R: 1, G: 1 }));
  assert.equal(sum(result.existingSources), 5);
});

test('tapped sources get balance credit, conditional sources only separate potential counts', () => {
  const result = allocateMana(8, { W: 1, U: 1 }, [
    row(2, ['W'], { tapped: true }), row(1, ['U']),
    row(2, ['U', 'C'], { conditional: true, tapped: true }),
  ]);
  assert.deepEqual(result.basics, record({ W: 1, U: 2 }));
  assert.deepEqual(result.existingSources, record({ W: 2, U: 1 }));
  assert.deepEqual(result.sources, record({ W: 3, U: 3 }));
  assert.deepEqual(result.untappedSources, record({ W: 1, U: 3 }));
  assert.deepEqual(result.conditionalSources, record({ U: 2, C: 2 }));
  const conditional = allocateMana(4, { W: 1, U: 1 }, [row(2, ['W'], { conditional: true })]);
  assert.deepEqual(conditional.basics, record({ W: 1, U: 1 }));
  assert.deepEqual(conditional.untappedSources, conditional.basics);
});

test('all fixed and no pips preserves sources without fabricating basics or targets', () => {
  const result = allocateMana(3, {}, [row(2, ['W', 'U']), row(1, [], { conditional: true })]);
  assert.equal(result.hasPips, false);
  assert.equal(result.remainingBasics, 0);
  assert.deepEqual(result.sources, record({ W: 2, U: 2 }));
  for (const key of ['basics', 'shares', 'targets']) assert.deepEqual(result[key], record());
  assert.deepEqual(allocateMana(3, { C: 1 }, [row(3, ['W'])]).basics, record());
});

test('no pips leaves unallocated slots visible for needs-input UI, including total zero', () => {
  const result = allocateMana(17, {}, [row(2, ['C'])]);
  assert.equal(result.remainingBasics, 15);
  assert.equal(result.hasPips, false);
  assert.equal(result.totalPips, 0);
  assert.deepEqual(result.basics, record());
  assert.deepEqual(result.sources, record({ C: 2 }));
  assert.deepEqual(allocateMana(0, {}).sources, record());
  assert.deepEqual(allocateMana(0, { W: 1, C: 1 }).shares, record({ W: 0.5, C: 0.5 }));
});

test('missing pip keys and empty source arrays are valid; inputs remain untouched', () => {
  const pips = Object.freeze(Object.assign(Object.create(null), { U: 2 }));
  const existing = Object.freeze([Object.freeze(row(2, Object.freeze([])))]);
  assert.deepEqual(allocateMana(5, pips, existing).basics, record({ U: 3 }));
  assert.equal(existing[0].quantity, 2);
  assert.equal(pips.U, 2);
});

test('malformed totals and pip records are rejected without coercion', () => {
  for (const total of [-1, 41, 0.1, NaN, Infinity]) assert.throws(() => allocateMana(total, {}), RangeError);
  for (const total of ['17', null, undefined, true, 1n]) assert.throws(() => allocateMana(total, {}), TypeError);
  for (const pips of [null, undefined, [], new Date(), 'W', 3, Object.create({ W: 1 })]) {
    assert.throws(() => allocateMana(5, pips), TypeError);
  }
  for (const value of [-1, 1000, 0.5, NaN, Infinity]) assert.throws(() => allocateMana(5, { W: value }), RangeError);
  for (const value of ['2', null, undefined, true, 1n]) assert.throws(() => allocateMana(5, { C: value }), TypeError);
  for (const pips of [{ X: 1 }, { white: 1 }, { [Symbol('W')]: 1 }]) assert.throws(() => allocateMana(5, pips), RangeError);
});

test('malformed land entries, missing sources, duplicates and overflows are RangeErrors', () => {
  const invalidRows = [null, [], new Date(), {}, row(0, []), row(41, []), row(1.5, []), row('1', []),
    row(NaN, []), { quantity: 1 }, row(1, null), row(1, 'W'), row(1, ['X']), row(1, ['w']),
    row(1, ['W', 'W']), row(1, [undefined]), row(1, new Array(1)),
    row(1, ['W'], { tapped: 1 }), row(1, ['W'], { conditional: null }),
    row(1, ['W'], { tapped: undefined }), row(1, [], { unknown: true }), Object.create({ quantity: 1, produces: [] })];
  for (const entry of invalidRows) assert.throws(() => allocateMana(40, {}, [entry]), RangeError);
  for (const existing of [null, {}, 'W', new Array(1), Array.from({ length: 41 }, () => row(1, [])), [row(3, []), row(3, [])]]) {
    assert.throws(() => allocateMana(5, {}, existing), RangeError);
  }
  assert.throws(() => allocateMana(0, {}, [row(1, [])]), RangeError);
  assert.equal(allocateMana(40, {}, Array.from({ length: 40 }, () => row(1, []))).existingCount, 40);
});

test('integer marginal tie order: higher pip weight, then WUBRGC', () => {
  assert.deepEqual(allocateMana(2, { W: 1, U: 3 }).basics, record({ U: 2 }));
  assert.deepEqual(allocateMana(1, { W: 1, U: 1, C: 1 }).basics, record({ W: 1 }));
  assert.deepEqual(allocateMana(1, { G: 1, C: 1 }).basics, record({ G: 1 }));
});

test('exhaustive small cases attain brute-force minimum squared source error', () => {
  let checked = 0;
  for (const weights of vectors(3, 2)) {
    if (!sum(weights)) continue;
    const pips = Object.fromEntries(['W', 'U', 'C'].map((id, i) => [id, weights[i]]));
    const active = ['W', 'U', 'C'].filter(id => pips[id] > 0);
    for (const sourceMask of vectors(3, 1)) {
      const existing = [row(1, ['W', 'U', 'C'].filter((_, i) => sourceMask[i]))];
      for (let remaining = 0; remaining <= 5; remaining++) {
        const result = allocateMana(remaining + 1, pips, existing);
        const budget = remaining + active.reduce((n, id) => n + result.existingSources[id], 0);
        const score = basic => active.reduce((n, id) => n + ((result.existingSources[id] + (basic[id] || 0)) * result.totalPips - budget * pips[id]) ** 2, 0);
        let optimum = Infinity;
        for (const split of splits(remaining, active.length)) {
          optimum = Math.min(optimum, score(Object.fromEntries(active.map((id, i) => [id, split[i]]))));
        }
        assert.equal(score(result.basics), optimum, JSON.stringify({ pips, existing, remaining }));
        checked++;
      }
    }
  }
  assert.equal(checked, 1248);
});

test('randomized physical budget, conditional and per-source conservation', () => {
  for (let trial = 0; trial < 3000; trial++) {
    const total = random(41);
    const pips = Object.fromEntries(ids.map(id => [id, random(1000)]));
    if (trial % 10 === 0) for (const id of ids) pips[id] = 0;
    const existing = [];
    let capacity = total;
    for (let index = 0, count = random(8); index < count && capacity; index++) {
      const quantity = random(capacity) + 1;
      existing.push(row(quantity, ids.filter(() => random(3) === 0), { tapped: random(2) === 0, conditional: random(3) === 0 }));
      capacity -= quantity;
    }
    const snapshot = JSON.stringify({ pips, existing });
    const result = allocateMana(total, pips, existing);
    assert.equal(result.existingCount + result.remainingBasics, total);
    assert.equal(sum(result.basics), result.hasPips ? capacity : 0);
    assert.equal(result.totalPips, sum(pips));
    for (const id of ids) {
      const count = predicate => existing.filter(r => r.produces.includes(id) && predicate(r)).reduce((n, r) => n + r.quantity, 0);
      assert.equal(result.existingSources[id], count(r => !r.conditional));
      assert.equal(result.sources[id], result.basics[id] + result.existingSources[id]);
      assert.equal(result.untappedSources[id], result.basics[id] + count(r => !r.conditional && !r.tapped));
      assert.equal(result.conditionalSources[id], count(r => r.conditional));
      assert.ok(Number.isInteger(result.basics[id]) && result.basics[id] >= 0);
      if (!pips[id]) assert.equal(result.basics[id], 0);
    }
    assert.equal(JSON.stringify({ pips, existing }), snapshot);
  }
});

test('no-existing allocation exactly matches legacy Hamilton including all small ties', () => {
  for (const weights of vectors(5, 3)) {
    const pips = Object.fromEntries(COLORS.map(({ id }, i) => [id, weights[i]]));
    for (let total = 0; total <= 40; total++) {
      const legacy = allocate(total, pips);
      const result = allocateMana(total, pips);
      assert.deepEqual(result.basics, record(legacy.lands));
      assert.deepEqual(result.shares, record(legacy.shares));
      assert.equal(result.hasPips, legacy.hasPips);
    }
  }
  for (let trial = 0; trial < 1000; trial++) {
    const pips = Object.fromEntries(COLORS.map(({ id }) => [id, random(1000)]));
    const total = random(41);
    assert.deepEqual(allocateMana(total, pips).basics, record(allocate(total, pips).lands));
  }
});
