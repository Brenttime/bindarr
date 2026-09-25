import assert from 'node:assert';
import { colorWeights } from './landWeights.js';
const z = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
// Brent's case: 14 black pips on 6 cards vs 10 red pips on 10 cards.
const pips = { ...z, B: 14, R: 10 }, cards = { ...z, B: 6, R: 10 };
assert.deepStrictEqual(colorWeights(pips, cards, 'pips'), { ...z, B: 58, R: 42 });
assert.deepStrictEqual(colorWeights(pips, cards, 'cards'), { ...z, B: 38, R: 63 });
assert.deepStrictEqual(colorWeights(pips, cards, 'blend'), { ...z, B: 48, R: 52 }, 'blend lands between');
assert.deepStrictEqual(colorWeights(pips, z, 'blend'), colorWeights(pips, z, 'pips'), 'no card counts: pips only');
assert.strictEqual(colorWeights({ ...z, B: 1 }, { ...z, B: 1 }, 'cards').W, 0, 'no pips, no weight');
console.log('landWeights ok');
