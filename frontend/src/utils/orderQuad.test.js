import assert from 'node:assert/strict';
import { orderQuad } from '../../../shared/imgproc.mjs';

const tl = { x: 0.2, y: 0.1 };
const tr = { x: 0.8, y: 0.2 };
const br = { x: 0.7, y: 0.9 };
const bl = { x: 0.1, y: 0.8 };
const expected = [tl, tr, br, bl];

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map(rest => [value, ...rest]));
}

for (const input of permutations(expected)) {
  assert.deepEqual(orderQuad(input), expected, `permutation ${JSON.stringify(input)} normalizes to TL,TR,BR,BL`);
}
assert.equal(orderQuad(null), null);
assert.deepEqual(orderQuad([tl, tr, br]), [tl, tr, br]);

console.log('PASS: orderQuad.test.js');
