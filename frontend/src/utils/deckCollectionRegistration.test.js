import assert from 'node:assert/strict';
import { canRegisterDeckInCollection, deckRegistrationCardCount } from './deckCollectionRegistration.js';

const readyDeck = {
  checked_out: 0,
  cards: [
    { id: 'a', quantity: 2 },
    { id: 'b', quantity: 1 },
  ],
};

assert.equal(canRegisterDeckInCollection(readyDeck), true);
assert.equal(deckRegistrationCardCount(readyDeck), 3);
assert.equal(canRegisterDeckInCollection({ ...readyDeck, checked_out: 1 }), false,
  'registration action hides as soon as the deck is checked out');
assert.equal(canRegisterDeckInCollection({ ...readyDeck, cards: [] }), false,
  'an empty deck cannot be registered');
assert.equal(canRegisterDeckInCollection(null), false);
assert.equal(deckRegistrationCardCount({ cards: [{ quantity: -2 }, { quantity: '3' }] }), 3);

console.log('PASS: deckCollectionRegistration.test.js');
