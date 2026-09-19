import assert from 'node:assert';
import { buildDeckExport, parseDeckLine, missingEntries } from './deckText.js';

const cards = [
  { quantity: 4, name: 'Lightning Bolt', set_id: '2x2', number: '117' },
  { quantity: 2, name: 'Counterspell', set_id: 'svi', number: '17' },
  { quantity: 6, name: 'Plains', set_id: 'mh3', number: '257' },
];

const mtga = buildDeckExport(cards, 'mtga');
assert.ok(mtga.startsWith('Deck\n'), 'mtga header');
assert.ok(mtga.includes('4 Lightning Bolt (2X2) 117'), 'mtga card line');

assert.strictEqual(buildDeckExport(cards, 'plain').split('\n')[0], '4 Lightning Bolt', 'plain line');

assert.deepStrictEqual(parseDeckLine('4 Lightning Bolt (2X2) 117'), { qty: 4, name: 'Lightning Bolt' });
assert.deepStrictEqual(parseDeckLine('2 Counterspell (SVI) #17'), { qty: 2, name: 'Counterspell' });
assert.deepStrictEqual(parseDeckLine('4 Lightning Bolt'), { qty: 4, name: 'Lightning Bolt' });
assert.deepStrictEqual(parseDeckLine('1 Jhoira of the Ghitu'), { qty: 1, name: 'Jhoira of the Ghitu' }, 'multi-word name kept');
assert.strictEqual(parseDeckLine('not a card line'), null);

console.log('deckText self-check passed');

// buylist: only shortfall vs owned, TCGplayer mass-entry lines
const bl = buildDeckExport([
  { quantity: 4, name: 'Lightning Bolt', owned_qty: 1 },
  { quantity: 2, name: 'Counterspell', owned_qty: 2 },
  { quantity: 3, name: 'Izzet Cerberus', owned_qty: 0 },
], 'buylist');
assert.strictEqual(bl, '3 Lightning Bolt\n3 Izzet Cerberus', 'buylist shortfall lines');

console.log('deckText buylist check passed');

// missing-panel agreement: panel rows and the buylist serialise from one deficit.
const rows = missingEntries([
  { name: 'Delta Sentinel', quantity: 4, owned_qty: 1, set_name: 'M11', collector_number: '12a' },
  { name: 'Delta Sentinel', quantity: 2, owned_qty: 0, set_name: 'M11', collector_number: '12a' },
  { name: 'Plains', quantity: 9, owned_qty: 0, subtypes: ['Basic', 'Land'] },
  { name: 'Llanachar Bulette', quantity: 1, owned_qty: 0 },
]);
assert.strictEqual(rows.length, 2, 'basics exempt, duplicates merged');
assert.strictEqual(rows[0].need, 6);
assert.strictEqual(rows[0].have, 1);
assert.strictEqual(buildDeckExport(rows.map((r) => ({ quantity: r.need, owned_qty: r.have, name: r.name })), 'buylist'), '5 Delta Sentinel\n1 Llanachar Bulette');
console.log('deckText missing-panel agreement passed');
