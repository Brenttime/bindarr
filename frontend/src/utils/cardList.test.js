import assert from 'node:assert';
import { buildCardListText, cardListLine } from './cardList.js';
// The backend's copy of the same builder — the import guard below is the real
// drift detector: a change to one that is not made to the other fails here.
import { buildCardListText as sharedBuild, cardListLine as sharedLine } from '../../../shared/cardListText.js';

const cards = [
  { quantity: 4, name: 'Lightning Bolt', set_id: 'jud', number: '124' },
  { quantity: 1, name: 'The Legend of Yangchen // Avatar Yangchen', set_id: 'tla', number: '27' },
  { quantity: 2, name: 'Basic Snow Island' }, // no set/number — imported without cache
  { quantity: 1, name: 'Daily Bugle Newspaper', set_code: 'MSC', collector_number: '749' }, // deck-card spelling
];

assert.strictEqual(cardListLine(cards[0], 'plain'), '4 Lightning Bolt');
assert.strictEqual(cardListLine(cards[0], 'detailed'), '4 Lightning Bolt (JUD) 124');
assert.strictEqual(cardListLine(cards[1], 'detailed'), '1 The Legend of Yangchen // Avatar Yangchen (TLA) 27');
assert.strictEqual(cardListLine(cards[2], 'detailed'), '2 Basic Snow Island', 'missing set/number degrades to name');
assert.strictEqual(cardListLine(cards[3], 'detailed'), '1 Daily Bugle Newspaper (MSC) 749');
assert.strictEqual(cardListLine({ quantity: 0, name: 'X' }, 'plain'), '1 X', 'quantity floors at 1');

const plain = buildCardListText(cards, 'plain');
assert.strictEqual(plain.split('\n').length, 4);
assert.ok(plain.startsWith('4 Lightning Bolt\n'), 'plain line one');
assert.ok(!plain.includes('('), 'plain has no set codes');

const detailed = buildCardListText(cards, 'detailed');
assert.ok(detailed.includes('1 Daily Bugle Newspaper (MSC) 749'));
assert.strictEqual(buildCardListText([], 'plain'), '', 'empty list exports nothing');

// The two implementations must stay byte-identical for every style.
for (const style of ['plain', 'detailed']) {
  assert.strictEqual(buildCardListText(cards, style), sharedBuild(cards, style), `shared copy drift (${style})`);
  cards.forEach(c => assert.strictEqual(cardListLine(c, style), sharedLine(c, style)));
}

console.log('cardList self-check passed');
