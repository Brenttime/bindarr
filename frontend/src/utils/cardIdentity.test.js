import assert from 'node:assert/strict';
import {
  adjustOwnedQuantityByName,
  cardKey,
  findSameCard,
  quantityByCardName,
  sameCard,
} from './cardIdentity.js';

const printings = [
  { id: 'lea-bolt', name: ' Lightning Bolt ', quantity: 1, owned_qty: 3 },
  { id: 'm10-bolt', name: 'LIGHTNING BOLT', quantity: 2, owned_qty: 3 },
  { id: 'lea-lotus', name: 'Black Lotus', quantity: 1, owned_qty: 1 },
];

assert.equal(cardKey(printings[0]), 'lightning bolt');
assert.equal(sameCard(printings[0], printings[1]), true);
assert.equal(sameCard(printings[0], printings[2]), false);
assert.equal(findSameCard(printings, { name: 'lightning bolt' }).id, 'lea-bolt');
assert.equal(quantityByCardName(printings, 'Lightning Bolt'), 3);
assert.equal(
  sameCard(
    { name: 'Fire // Ice' },
    { name: ' fire // ice ' }
  ),
  true,
  'split-card canonical names remain one logical identity'
);
assert.equal(
  sameCard(
    { name: 'Invasion of Zendikar // Awakened Skyclave' },
    { name: 'invasion of zendikar // awakened skyclave' }
  ),
  true,
  'modal/transformed canonical names remain one logical identity'
);
assert.deepEqual(
  adjustOwnedQuantityByName(printings, 'lightning bolt', 1).map(card => card.owned_qty),
  [4, 4, 1],
  'optimistic ownership changes apply to every displayed printing of one game card'
);

console.log('PASS: cardIdentity.test.js');
