// Runnable smoke test for setStackQuantity — the card popup's quantity field is
// absolute ("how many copies I own"), so editing it has to add AND remove rows.
// No framework — plain node + assert. Run: `node test/stackquantity.test.js`.
const assert = require('assert');
const { setStackQuantity } = require('../src/utils/collectionHelpers');

const USER = 7;
const base = { user_id: USER, card_id: 'c-A', quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English', purchase_price: 2, is_trade: 0, favorite: 0, list_type: 'collection', game: 'pokemon' };

// Fake db covering the three statements setStackQuantity issues.
function makeFakeDb(rows) {
  let nextId = 100;
  return {
    rows,
    async get(sql, params) {
      const [id, userId] = params;
      return rows.find(r => r.id === id && r.user_id === userId) || null;
    },
    async all(sql, params) {
      const [userId, cardId, condition, printing, language, listType, excludeId] = params;
      return rows
        .filter(r => r.user_id === userId && r.card_id === cardId && r.condition === condition
          && r.printing === printing && r.language === language && r.list_type === listType && r.id !== excludeId)
        // newest first — the trim order the helper asks for
        .sort((a, b) => b.id - a.id);
    },
    async run(sql, params) {
      if (/^\s*INSERT INTO collection/.test(sql)) {
        const [card_id, user_id, condition, printing, language, purchase_price,
          is_trade, favorite, list_type, game] = params;
        rows.push({ id: ++nextId, card_id, user_id, quantity: 1, condition, printing, language, purchase_price, is_trade, favorite, list_type, game });
      } else if (/^\s*DELETE FROM collection/.test(sql)) {
        rows.splice(rows.findIndex(r => r.id === params[0]), 1);
      } else if (/SET quantity = quantity - \?/.test(sql)) {
        rows.find(r => r.id === params[1]).quantity -= params[0];
      } else if (/^\s*UPDATE collection SET quantity = \?/.test(sql)) {
        rows.find(r => r.id === params[1]).quantity = params[0];
      }
    },
  };
}

const copies = (db) => db.rows.filter(r => r.card_id === 'c-A').reduce((n, r) => n + r.quantity, 0);

async function main() {
  // The reported bug: two copies, asked for one, ended up with more.
  let db = makeFakeDb([{ ...base, id: 1 }, { ...base, id: 2 }]);
  assert.strictEqual(await setStackQuantity(db, USER, 1, 1), -1, 'two copies down to one drops a copy');
  assert.strictEqual(copies(db), 1, 'exactly one copy left');
  assert.strictEqual(db.rows[0].id, 1, 'the edited row survives; the newest sibling went first');

  // Saving the same number again is a no-op, not another duplicate.
  assert.strictEqual(await setStackQuantity(db, USER, 1, 1), 0, 're-saving changes nothing');
  assert.strictEqual(copies(db), 1, 'still one copy');

  // Growing adds single-card rows mirroring the edited row.
  assert.strictEqual(await setStackQuantity(db, USER, 1, 3), 2, 'one copy up to three adds two');
  const all = db.rows.filter(r => r.card_id === 'c-A');
  assert.strictEqual(all.length, 3, 'three single-card rows');
  assert.ok(all.every(r => r.quantity === 1 && r.user_id === USER && r.printing === 'Normal'), 'copies are single rows of the same printing');

  // A different printing is not part of the stack and must not be trimmed.
  db = makeFakeDb([{ ...base, id: 1 }, { ...base, id: 2 }, { ...base, id: 3, printing: 'Holofoil' }]);
  await setStackQuantity(db, USER, 1, 1);
  assert.strictEqual(db.rows.length, 2, 'only the identical copy was removed');
  assert.ok(db.rows.some(r => r.printing === 'Holofoil'), 'the holo copy is untouched');

  // A legacy stacked row (quantity > 1) reconciles on its own quantity column.
  db = makeFakeDb([{ ...base, id: 1, quantity: 4 }]);
  assert.strictEqual(await setStackQuantity(db, USER, 1, 2), -2, 'a stacked row shrinks in place');
  assert.strictEqual(db.rows.length, 1, 'no rows deleted');
  assert.strictEqual(db.rows[0].quantity, 2, 'quantity reduced to the target');

  console.log('stackquantity.test.js passed');
}

main().catch(err => { console.error(err); process.exit(1); });
