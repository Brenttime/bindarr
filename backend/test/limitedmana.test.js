// Limited Lands analyzer: decklist parsing and pip counting.
// Run: node test/limitedmana.test.js
const assert = require('assert');
const { parseDecklist, costPips, analyzeCards } = require('../src/utils/limitedMana');

const list = parseDecklist(`Deck
2 Doom Blade (M10) 88
1x Scoured Barrens
Lightning Bolt
2 Doom Blade
8 Swamp

Sideboard
3 Negate`);
assert.deepStrictEqual(list, [
  { name: 'Doom Blade', quantity: 4 },
  { name: 'Scoured Barrens', quantity: 1 },
  { name: 'Lightning Bolt', quantity: 1 },
  { name: 'Swamp', quantity: 8 },
], 'merges duplicates, strips set codes, stops at sideboard');
assert.deepStrictEqual(parseDecklist('1 A\nSIDEBOARD:\n1 B').map(e => e.name), ['A']);

assert.deepStrictEqual(costPips('{1}{B}{B}'), { W: 0, U: 0, B: 2, R: 0, G: 0, C: 0 });
assert.deepStrictEqual(costPips('{W/U}{2/R}{G/P}{C}{X}'), { W: 0.5, U: 0.5, B: 0, R: 1, G: 1, C: 1 });

const a = analyzeCards([
  { quantity: 4, card: { name: 'Doom Blade', type_line: 'Instant', mana_cost: '{1}{B}' } },
  { quantity: 1, card: { name: 'Scoured Barrens', type_line: 'Land', produced_mana: ['W', 'B'], oracle_text: 'Scoured Barrens enters tapped.\nWhen it enters, you gain 1 life.' } },
  { quantity: 1, card: { name: 'Hengegate Pathway // Mistgate Pathway', card_faces: [{ type_line: 'Land', oracle_text: '{T}: Add {W}.' }, { type_line: 'Land' }], produced_mana: ['W', 'U'] } },
  { quantity: 2, card: { name: 'Bala Ged Recovery // Bala Ged Sanctuary', card_faces: [{ type_line: 'Sorcery', mana_cost: '{2}{G}' }, { type_line: 'Land' }] } },
  { quantity: 8, card: { name: 'Swamp', type_line: 'Basic Land — Swamp', produced_mana: ['B'] } },
]);
assert.deepStrictEqual(a.pips, { W: 0, U: 0, B: 4, R: 0, G: 2, C: 0 });
assert.strictEqual(a.basics.B, 8);
assert.deepStrictEqual(a.colorCards, { W: 0, U: 0, B: 4, R: 0, G: 2, C: 0 }, 'cards per color, every copy');
assert.strictEqual(a.spells, 6);
assert.strictEqual(a.landCount, 10);
assert.deepStrictEqual(a.lands[0], { name: 'Scoured Barrens', quantity: 1, produces: ['W', 'B'], tapped: true, conditional: false });
assert.strictEqual(a.lands[1].tapped, false);

console.log('limitedmana.test.js passed');
