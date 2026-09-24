// ManaBox sync planning: the rules the reconcile of 2026-09 established.
const assert = require('assert');
const { parseCsv, parseManaboxExport, identityMismatch, planCollection, planLists } = require('../src/utils/manaboxSync');

const H = 'Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency,Added';
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const csv = [H,
  `Box,binder,"Spara's Headquarters",snc,"Streets of New Capenna",257,normal,rare,2,1,${A},0.5,false,false,near_mint,en,USD,2026-05-02T22:50:03.602Z`,
  `Deck,deck,"Bolt, Lightning",lea,Alpha,161,foil,common,1,2,${B},,false,false,near_mint,en,USD,2025-01-01T10:00:00.000Z`,
  `Wants,list,Wanted Card,dmu,Dominaria United,1,normal,rare,3,3,${C},,false,false,near_mint,en,USD,2026-01-01T00:00:00.000Z`,
].join('\r\n');

// CSV: quoted commas and apostrophes survive.
assert.strictEqual(parseCsv(csv)[1].Name, 'Bolt, Lightning');

const p = parseManaboxExport(csv);
assert.strictEqual(p.errors.length, 0);
assert.strictEqual(p.owned.length, 2, 'lists are not owned');
assert.strictEqual(p.lists.get('Wants').get(`mtg-${C}`).quantity, 3);
const spara = p.owned.find(o => o.card_id === `mtg-${A}`);
assert.deepStrictEqual(spara.dates, ['2026-05-02 22:50:03', '2026-05-02 22:50:03']);
assert.strictEqual(p.owned.find(o => o.card_id === `mtg-${B}`).printing, 'Holofoil');
assert.ok(parseManaboxExport('a,b\n1,2').error, 'non-ManaBox file rejected');

// Identity: set, collector number and name must match the Scryfall ID.
const ok = { set_id: 'snc', number: '257', name: "Spara's Headquarters" };
assert.strictEqual(identityMismatch(spara.expect, ok), null);
assert.match(identityMismatch(spara.expect, { ...ok, set_id: 'sncx' }), /set/);
assert.match(identityMismatch(spara.expect, { ...ok, number: '258' }), /collector number/);
assert.match(identityMismatch(spara.expect, { ...ok, name: 'Other' }), /name/);
assert.strictEqual(identityMismatch({ set: 'x', number: '1', name: 'Front' }, { set_id: 'x', number: '1', name: 'Front // Back' }), null);

const row = (id, card, extra = {}) => ({ id, card_id: `mtg-${card}`, quantity: 1, printing: 'Normal', condition: 'Near Mint', language: 'English', added_at: '2026-08-18 00:00:00', source: 'manabox', ...extra });

// 1. Wrongly imported list card (ManaBox origin, not owned) is removed.
// 2. Hand add of an owned card counts, so it is not re-added.
// 3. Missing owned copy is added with the ManaBox date.
// 4. Hand add of an unowned card is kept.
// 5. ManaBox rows get ManaBox dates.
let plan = planCollection([
  row(1, C),
  row(2, A, { source: null, added_at: '2026-09-20 12:00:00' }),
  row(3, 'dddddddd-dddd-dddd-dddd-dddddddddddd', { source: null }),
  row(4, B, { printing: 'Holofoil' }),
], p.owned);
assert.deepStrictEqual(plan.remove.map(r => r.id), [1]);
assert.strictEqual(plan.add.length, 1);
assert.strictEqual(plan.add[0].card_id, `mtg-${A}`);
assert.strictEqual(plan.add[0].added_at, '2026-05-02 22:50:03');
assert.deepStrictEqual(plan.redate, [[4, '2025-01-01 10:00:00']]);

// Same file again after applying: no-op.
const after = [row(2, A, { source: null, added_at: '2026-09-20 12:00:00' }), row(3, 'dddddddd-dddd-dddd-dddd-dddddddddddd', { source: null }),
  row(4, B, { printing: 'Holofoil', added_at: '2025-01-01 10:00:00' }), row(5, A, { added_at: '2026-05-02 22:50:03' })];
plan = planCollection(after, p.owned);
assert.deepStrictEqual([plan.remove.length, plan.add.length, plan.redate.length], [0, 0, 0]);

// A condition change in ManaBox: the old ManaBox copy goes, the new one comes.
const lp = parseManaboxExport(csv.replace('1,2,' + B + ',,false,false,near_mint', '1,2,' + B + ',,false,false,light_played'));
plan = planCollection(after, lp.owned);
assert.deepStrictEqual(plan.remove.map(r => r.id), [4]);
assert.strictEqual(plan.add[0].condition, 'Lightly Played');

// Lists: create new, update sync-owned, never touch a hand-made list of the same name.
let lp2 = planLists([], p.lists);
assert.strictEqual(lp2.create[0].name, 'Wants');
lp2 = planLists([{ id: 9, name: 'Wants', source: null, cards: new Map() }], p.lists);
assert.deepStrictEqual(lp2.skipped, ['Wants']);
lp2 = planLists([{ id: 9, name: 'Wants', source: 'manabox', cards: new Map([[`mtg-${C}`, 3]]) }], p.lists);
assert.deepStrictEqual([lp2.create.length, lp2.update.length], [0, 0]);
lp2 = planLists([{ id: 9, name: 'Wants', source: 'manabox', cards: new Map([[`mtg-${C}`, 1]]) }], p.lists);
assert.strictEqual(lp2.update[0].id, 9);

console.log('manaboxsync: ok');
