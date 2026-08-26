import assert from 'node:assert/strict';
import { deckMinimumValueHint, deckMinimumValueText, deckUnpricedCountText } from './deckMinimumValue.js';

const t = (key, vars = {}) => `${key}:${vars.count ?? ''}`;

assert.equal(deckMinimumValueText({ minimum_value: 12.345, minimum_value_currency: 'USD', unpriced_cards: 0 }), '$12.35');
assert.equal(deckMinimumValueText({ minimum_value: 12.3, minimum_value_currency: 'USD', unpriced_cards: 2 }), '$12.30+');
assert.equal(deckMinimumValueText({ minimum_value: null, unpriced_cards: 0 }), '$0.00');
assert.equal(deckMinimumValueHint({ unpriced_cards: 0 }, t), 'deck.minimumValueComplete:');
assert.equal(deckMinimumValueHint({ unpriced_cards: 1 }, t), 'deck.minimumValueIncompleteOne:');
assert.equal(deckMinimumValueHint({ unpriced_cards: 3 }, t), 'deck.minimumValueIncomplete:3');
assert.equal(deckUnpricedCountText({ unpriced_cards: 3 }, t), 'deck.unpricedCount:3');
assert.equal(deckUnpricedCountText({ unpriced_cards: 0 }, t), '');

console.log('PASS: deckMinimumValue.test.js');
