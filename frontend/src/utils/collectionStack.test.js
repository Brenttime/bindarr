import assert from 'node:assert';
import { stackKey, stackCollection } from './collectionStack.js';

const row = (over) => ({ card_id: 'card-1', printing: 'Normal', condition: 'Near Mint', quantity: 1, ...over });

// (a) A foil and a non-foil copy share one card_id and must never fold into a
// single stacked row, and neither copy may lose its quantity.
const foilSplit = stackCollection([
  row({ entry_id: 1, quantity: 2 }),
  row({ entry_id: 2, printing: 'Holofoil', quantity: 1 }),
]);
assert.equal(foilSplit.length, 2, 'a foil must not stack with its non-foil twin');
assert.deepStrictEqual(
  foilSplit.map(({ entry_id, printing, quantity }) => ({ entry_id, printing, quantity })),
  [
    { entry_id: 1, printing: 'Normal', quantity: 2 },
    { entry_id: 2, printing: 'Holofoil', quantity: 1 },
  ],
  'each finish keeps its own row and its own count'
);
// Printing is not an opt-in: no option can merge them back together.
assert.notStrictEqual(
  stackKey(row({ printing: 'Normal' })),
  stackKey(row({ printing: 'Holofoil' })),
  'printing is always part of the stack key'
);
assert.equal(stackKey(row({ printing: 'Holofoil' })), stackKey(row({ printing: 'Holofoil' }), { byCondition: false }));

// (b) Same card_id, same printing: still one stacked row with summed quantity.
const samePrinting = stackCollection([
  row({ entry_id: 1, quantity: 2 }),
  row({ entry_id: 2, quantity: 3 }),
  row({ entry_id: 3, printing: 'Holofoil', quantity: 4 }),
]);
assert.deepStrictEqual(
  samePrinting.map(({ printing, quantity }) => ({ printing, quantity })),
  [{ printing: 'Normal', quantity: 5 }, { printing: 'Holofoil', quantity: 4 }],
  'copies of one finish stack and their quantities add up'
);

// (c) The condition split stays opt-in exactly as it behaved before.
const byConditionRows = [
  row({ entry_id: 1, quantity: 1 }),
  row({ entry_id: 2, condition: 'Played', quantity: 2 }),
];
assert.equal(stackCollection(byConditionRows).length, 1, 'condition is ignored while the toggle is off');
assert.equal(stackCollection(byConditionRows, { byCondition: false })[0].quantity, 3);
const splitByCondition = stackCollection(byConditionRows, { byCondition: true });
assert.deepStrictEqual(
  splitByCondition.map(({ condition, quantity }) => ({ condition, quantity })),
  [{ condition: 'Near Mint', quantity: 1 }, { condition: 'Played', quantity: 2 }],
  'the Split by Condition toggle still separates rows when ticked'
);

// (d) A NULL/absent printing is the ordinary copy, so it stacks with an
// explicit 'Normal' row instead of orphaning itself into a separate group.
const nullPrinting = stackCollection([
  row({ entry_id: 1, printing: null, quantity: 1 }),
  row({ entry_id: 2, printing: 'Normal', quantity: 2 }),
  row({ entry_id: 3, quantity: 3 }),
]);
assert.equal(nullPrinting.length, 1, 'NULL and missing printings read as Normal');
assert.equal(nullPrinting[0].quantity, 6, 'all three copies fold into the non-foil stack');

// (e) The first row of a group is the representative row -- it supplies the
// artwork, set, price and entry_id the rendered row uses.
const representatives = stackCollection([
  row({ entry_id: 10, name: 'First Copy', quantity: 1 }),
  row({ entry_id: 11, name: 'Second Copy', quantity: 2 }),
]);
assert.equal(representatives.length, 1);
assert.equal(representatives[0].entry_id, 10, 'the first row encountered represents the group');
assert.equal(representatives[0].name, 'First Copy');
assert.equal(representatives[0].quantity, 3);
// The representative is a copy, so stacking must not mutate the fetched rows.
assert.equal(byConditionRows[0].quantity, 1, 'source rows are never mutated by stacking');

// A degenerate NULL quantity still counts as the single copy the schema default
// implies, rather of poisoning the stacked total with NaN.
assert.equal(
  stackCollection([row({ entry_id: 1, quantity: null }), row({ entry_id: 2, quantity: 2 })])[0].quantity,
  3,
  'a NULL quantity counts as one copy'
);

// Different cards never fold together, and group order follows first appearance.
const many = stackCollection([
  row({ card_id: 'a', entry_id: 1 }),
  row({ card_id: 'b', entry_id: 2 }),
  row({ card_id: 'a', entry_id: 3 }),
]);
assert.deepStrictEqual(many.map(card => card.entry_id), [1, 2], 'group order follows first appearance');
assert.deepStrictEqual(many.map(card => card.quantity), [2, 1], 'only same-card copies fold together');
assert.equal(stackCollection([]).length, 0);

console.log('PASS: collectionStack.test.js');
