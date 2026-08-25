// Shared helpers for the collection route. Kept in one neutral module so the
// split route files never have to import each other.
const db = require('../db');

// How many copies of each collection entry are physically pulled for a
// checked-out deck. Sums required quantity per card across all of the user's
// checked-out decks, then allocates greedily onto their owned entries (newest
// first), so the collection view can grey out the same copies the checkout
// checklist told them to grab.
async function checkedOutAllocation(userId) {
  const required = await db.all(`
    SELECT dc.card_id, SUM(dc.quantity) AS req
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id = ? AND d.checked_out = 1
    GROUP BY dc.card_id
  `, [userId]);
  const alloc = new Map();
  for (const { card_id, req } of required) {
    let need = req;
    const entries = await db.all(`
      SELECT id AS entry_id, quantity FROM collection
      WHERE user_id = ? AND list_type = 'collection' AND card_id = ?
      ORDER BY added_at DESC
    `, [userId, card_id]);
    for (const e of entries) {
      if (need <= 0) break;
      const take = Math.min(e.quantity, need);
      need -= take;
      alloc.set(e.entry_id, take);
    }
  }
  return alloc;
}

// The rows the collection view stacks together with this one: same card, same
// printing details, same list. Ordered newest-first so the newest copies are the
// trim candidates. The edited row itself is excluded: it is never the row
// deleted.
async function stackSiblings(dbClient, userId, row, entryId) {
  return dbClient.all(`
    SELECT id, quantity FROM collection
    WHERE user_id = ? AND card_id = ? AND condition = ? AND printing = ?
      AND language = ? AND list_type = ? AND id != ?
    ORDER BY id DESC
  `, [userId, row.card_id, row.condition, row.printing, row.language, row.list_type, entryId]);
}

// Make the number of copies this stack represents equal `target`, keeping the
// edited row. The quantity field in the card popup is absolute — "how many of
// these I own" — and the stacked collection view sums the identical rows into
// that one number, so the edit has to reconcile the whole group both ways.
// Growing inserts single-card rows mirroring the edited row's attributes;
// shrinking removes the trim candidates first and only then reduces the edited
// row's own quantity. Returns the net change in copies.
async function setStackQuantity(database, userId, entryId, target) {
  const dbClient = database || db;
  const row = await dbClient.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
  if (!row) return 0;
  const siblings = await stackSiblings(dbClient, userId, row, entryId);

  const start = (row.quantity || 1) + siblings.reduce((n, s) => n + (s.quantity || 1), 0);
  let current = start;

  for (let i = 0; current < target; i++, current++) {
    await dbClient.run(`
      INSERT INTO collection (
        card_id, user_id, quantity, condition, printing, language, purchase_price,
        is_trade, favorite, list_type
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.card_id, userId, row.condition, row.printing, row.language, row.purchase_price,
      row.is_trade, row.favorite, row.list_type
    ]);
  }

  for (const s of siblings) {
    if (current <= target) break;
    const have = s.quantity || 1;
    const drop = Math.min(have, current - target);
    current -= drop;
    if (drop >= have) {
      await dbClient.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [s.id, userId]);
    } else {
      await dbClient.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [drop, s.id, userId]);
    }
  }

  if (current > target) {
    await dbClient.run(`UPDATE collection SET quantity = ? WHERE id = ? AND user_id = ?`, [target, entryId, userId]);
    current = target;
  }

  return current - start;
}

// One card = one row. Split any legacy stacked entry (quantity > 1) into that
// many single-card rows so each copy is its own row (the pre-storage schema
// kept one row per physical card). Idempotent: once run there are no
// quantity>1 rows, so a re-run is a no-op.
async function splitStackedEntries(database) {
  const dbClient = database || db;
  const stacked = await dbClient.all(`SELECT * FROM collection WHERE quantity > 1`);
  if (stacked.length === 0) return 0;
  let created = 0;
  for (const e of stacked) {
    const copies = e.quantity;
    await dbClient.run(`UPDATE collection SET quantity = 1 WHERE id = ?`, [e.id]);
    for (let i = 1; i < copies; i++) {
      await dbClient.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          is_trade, favorite, list_type
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `, [
        e.card_id, e.user_id, e.condition, e.printing, e.language, e.purchase_price,
        e.is_trade, e.favorite, e.list_type
      ]);
      created++;
    }
  }
  return created;
}

module.exports = {
  checkedOutAllocation,
  setStackQuantity,
  splitStackedEntries,
};
