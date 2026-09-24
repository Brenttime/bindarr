import test from 'node:test';
import assert from 'node:assert/strict';
import { fitContain, quadPath, FRAME_MAX } from './fastScan.js';

test('FRAME_MAX is the measured 1920 ceiling', () => { assert.equal(FRAME_MAX, 1920); });

test('fitContain letterboxes and cover crops', () => {
  const f = { width: 1920, height: 1080 };
  const c = fitContain(f, 960, 960);
  assert.equal(c.s, 0.5); assert.equal(c.ox, 0); assert.equal(c.oy, 210);
  const v = fitContain(f, 960, 960, 'cover');
  assert.ok(Math.abs(v.s - 960 / 1080) < 1e-9); assert.ok(v.ox < 0); assert.equal(v.oy, 0);
});

test('quadPath maps quad or box corners', () => {
  const fit = { s: 0.5, ox: 10, oy: 20 };
  assert.deepEqual(quadPath({ box: [0, 0, 100, 200] }, fit), [[10, 20], [60, 20], [60, 120], [10, 120]]);
  assert.deepEqual(quadPath({ quad: [[2, 2], [4, 2], [4, 4], [2, 4]] }, fit)[2], [12, 22]);
});
