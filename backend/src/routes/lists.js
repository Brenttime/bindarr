const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const { parseCardRow } = require('../utils/priceHelpers');
const { buildCardListText } = require('../../../shared/cardListText.js');
const { sqlCardKey } = require('../utils/cardIdentity');
const { getListMinimumValues, getCheapestPrintings, emptyDeckMinimumValue, currentPrintingPrice, deckCurrentPrintValues } = require('../utils/deckPricing');

const router = express.Router();

async function unresolvedListCardCount(listId) {
  const row = await db.get(`
    SELECT COUNT(*) AS count
    FROM list_cards lc
    LEFT JOIN card_cache cc ON cc.id = lc.card_id
    WHERE lc.list_id = ? AND lc.quantity > 0 AND cc.id IS NULL
  `, [listId]);
  return Number(row && row.count) || 0;
}

// Card lists: wishlists, buylists, missing-card lists — cards tracked but not
// necessarily owned (the ManaBox "lists" concept). Separate entity from decks
// on purpose: no format, no 4-copy rule, no checkout, no ownership ceiling on
// quantities.

// One user's lists with card counts.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT
         l.id, l.name, l.description, l.accent_color, l.created_at,
         COUNT(DISTINCT CASE
           WHEN lc.quantity > 0 THEN CASE
             WHEN list_cc.id IS NULL THEN 'missing:' || lc.card_id
             ELSE ${sqlCardKey('list_cc')}
           END
         END) AS total_card_types,
         COALESCE(SUM(CASE WHEN lc.quantity > 0 THEN lc.quantity ELSE 0 END), 0) AS total_cards,
         COUNT(DISTINCT CASE WHEN lc.quantity > 0 AND list_cc.id IS NULL THEN lc.card_id END) AS unresolved_card_types
       FROM card_lists l
       LEFT JOIN list_cards lc ON l.id = lc.list_id
       LEFT JOIN card_cache list_cc ON list_cc.id = lc.card_id
       WHERE l.user_id = ?
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    const values = await getListMinimumValues(db, rows.map(row => row.id));
    res.json(rows.map(row => ({
      ...row,
      ...(values.get(Number(row.id)) || emptyDeckMinimumValue()),
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve lists' });
  }
});

// Create a list, optionally seeding it from pasted list text in the ManaBox/
// MTGA shape ("4 Lightning Bolt" / "4 Lightning Bolt (JUD) 124"). Names are
// resolved against the local cache — the cards are ones this install already
// knows (collection, decks, scans). Uncached names are reported back so the
// client can say exactly what it could not place.
router.post('/', async (req, res) => {
  const { name, description = '', accent_color = '#10b981', list_text = '' } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'List name is required' });
  }
  const accent = typeof accent_color === 'string' && accent_color.startsWith('#') ? accent_color : '#10b981';

  try {
    const result = await db.run(
      `INSERT INTO card_lists (name, description, accent_color, user_id) VALUES (?, ?, ?, ?)`,
      [String(name).trim(), description || '', accent, req.user.id]
    );
    const listId = result.lastID;

    let matched = 0;
    const unmatched = [];
    if (typeof list_text === 'string' && list_text.trim()) {
      for (const raw of list_text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        // MTGA / ManaBox line: QTY Name [ (SET) NUMBER ]. The set reference is
        // stripped before the cache lookup — card names never carry parens with
        // a set code inside — and recorded so unmatched cards are reportable.
        const m = line.match(/^(\d+)\s+(.+)$/i);
        if (!m) continue;
        const qty = Math.max(1, parseInt(m[1], 10) || 1);
        let cardName = m[2].trim();
        let setRef = '';
        const ref = cardName.match(/\s*\(([A-Za-z0-9]{2,13})\)\s*(\d+(?:\/\/\d+)?)?\s*$/i);
        if (ref) {
          setRef = ref[0].trim();
          cardName = cardName.slice(0, cardName.length - ref[0].length).trim();
        }
        if (!cardName) continue;
        const card = await db.get(
          `SELECT id FROM card_cache WHERE LOWER(name) = LOWER(?) LIMIT 1`,
          [cardName]
        );
        if (!card) {
          unmatched.push(setRef ? `${cardName} (${setRef})` : cardName);
          continue;
        }
        await db.run(
          `INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(list_id, card_id) DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
          [listId, card.id, qty]
        );
        matched++;
      }
    }

    res.status(201).json({ message: 'List created', id: listId, matched, unmatched });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create list' });
  }
});

// One list with its cards, plus how many copies the user owns of each — the
// "still missing X of Y" numbers that make a buylist/missing list useful.
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const list = await db.get(`SELECT * FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }
    if (await unresolvedListCardCount(id)) {
      return res.status(422).json({
        error: 'This list contains cards whose details are unavailable. Remove or re-import them before continuing.'
      });
    }
    const cards = await db.all(
      `WITH requested AS (
         SELECT
           ${sqlCardKey('list_cc')} AS card_key,
           MIN(lc.card_id) AS representative_id,
           SUM(lc.quantity) AS quantity
         FROM list_cards lc
         JOIN card_cache list_cc ON list_cc.id = lc.card_id
         WHERE lc.list_id = ? AND lc.quantity > 0
         GROUP BY ${sqlCardKey('list_cc')}
       ),
       owned AS (
         SELECT
           ${sqlCardKey('owned_cc')} AS card_key,
           SUM(collection_row.quantity) AS quantity
         FROM collection collection_row
         JOIN card_cache owned_cc ON owned_cc.id = collection_row.card_id
         WHERE collection_row.user_id = ? AND collection_row.quantity > 0
         GROUP BY ${sqlCardKey('owned_cc')}
       )
       SELECT
         requested.quantity,
         cc.id, cc.name, cc.printed_name,
         cc.supertype, cc.subtypes, cc.types,
         cc.rarity, cc.set_id, cc.set_name, cc.number,
         cc.image_url, cc.price_trend,
         COALESCE(owned.quantity, 0) AS owned_qty
       FROM requested
       JOIN card_cache cc ON cc.id = requested.representative_id
       LEFT JOIN owned ON owned.card_key = requested.card_key
       ORDER BY cc.name ASC`,
      [id, req.user.id]
    );
    const values = await getListMinimumValues(db, [Number(id)]);
    // Current-printings total, row-level like the deck detail: each
    // list_cards row pays its own printing's USD price (unpriced copies
    // counted aside for the "+"), next to the cheapest-printings floor.
    const currentRows = await db.all(`
      SELECT lc.quantity,
             cc.price_normal, cc.price_holofoil, cc.price_etched, cc.price_trend, cc.price_currency
      FROM list_cards lc
      JOIN card_cache cc ON cc.id = lc.card_id
      WHERE lc.list_id = ? AND lc.quantity > 0
    `, [id]);
    const currentValues = deckCurrentPrintValues(currentRows.map(row => ({
      quantity: row.quantity,
      current_price: currentPrintingPrice(row),
    })));
    res.json({
      ...list,
      ...(values.get(Number(id)) || emptyDeckMinimumValue()),
      ...currentValues,
      cards: cards.map(parseCardRow),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve list details' });
  }
});

// The list as text — the same two shapes the collection cardlist export uses,
// built by the shared formatter so a list paste and a collection paste are
// byte-identical patterns ("qty Name" / "qty Name (SET) num").
router.get('/:id/cardlist', async (req, res) => {
  const { id } = req.params;
  const style = req.query.style === 'detailed' ? 'detailed' : 'plain';
  try {
    const list = await db.get(`SELECT id FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) {
      return res.status(404).json({ error: 'List not found' });
    }
    if (await unresolvedListCardCount(id)) {
      return res.status(422).json({
        error: 'This list contains cards whose details are unavailable. Remove or re-import them before exporting.'
      });
    }
    const rows = await db.all(
      `WITH requested AS (
         SELECT
           ${sqlCardKey('list_cc')} AS card_key,
           MIN(lc.card_id) AS representative_id,
           SUM(lc.quantity) AS quantity
         FROM list_cards lc
         JOIN card_cache list_cc ON list_cc.id = lc.card_id
         WHERE lc.list_id = ? AND lc.quantity > 0
         GROUP BY ${sqlCardKey('list_cc')}
       )
       SELECT requested.quantity, cc.name, cc.set_id, cc.number
       FROM requested
       JOIN card_cache cc ON cc.id = requested.representative_id
       ORDER BY cc.name ASC`,
      [id]
    );
    res.type('text/plain').send(buildCardListText(rows, style));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to build card list' });
  }
});

// Cheapest-printing rewrite: point every logical card in the list at its cheapest
// known USD printing. Rows for other printings of the same game card are folded
// into the target row (quantities summed) so the swap misses nothing. Cards with
// no priced printing are left exactly as they are, which makes a rerun after a
// price refresh pick up the stragglers. Runs in one transaction: the fold is
// two statements per card (carry the total, sweep the sibling rows) and must
// not interleave with a concurrent card edit.
router.put('/:id/cheapest-printings', async (req, res) => {
  const { id } = req.params;
  try {
    const list = await db.get(`SELECT id FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) {
      return res.status(404).json({ error: 'List not found or unauthorized' });
    }

    // Cheapest target per logical card, computed the same way the deck/list
    // minimum value is — every cached USD printing, not just those already in
    // the list — so the rewrite and the shown floor can never disagree.
    const cardKeys = (await db.all(`
      SELECT DISTINCT ${sqlCardKey('lc_cc')} AS card_key
      FROM list_cards lc
      JOIN card_cache lc_cc ON lc_cc.id = lc.card_id
      WHERE lc.list_id = ? AND lc.quantity > 0
    `, [id])).map(row => row.card_key).filter(Boolean);
    const cheapest = await getCheapestPrintings(db, cardKeys);

    // Total wanted quantity per logical card: the fold target carries the full
    // demand after siblings are swept, whatever row it started on.
    const demands = await db.all(`
      SELECT ${sqlCardKey('lc_cc')} AS card_key, SUM(lc.quantity) AS quantity
      FROM list_cards lc
      JOIN card_cache lc_cc ON lc_cc.id = lc.card_id
      WHERE lc.list_id = ? AND lc.quantity > 0
      GROUP BY card_key
    `, [id]);

    let moved = 0;
    await db.withTransaction(async () => {
      for (const demand of demands) {
        const target = cheapest.get(demand.card_key);
        if (!target) continue; // no priced printing on record: leave it alone

        // Already the sole row and already cheapest? Nothing to do — this keeps
        // reruns honest after a price refresh, when only some cards move.
        const misaligned = await db.get(`
          SELECT 1 AS hit FROM list_cards mc
          LEFT JOIN card_cache mc_cc ON mc_cc.id = mc.card_id
          WHERE mc.list_id = ? AND mc.quantity > 0
            AND ${sqlCardKey('mc_cc')} = ? AND mc.card_id != ?
          LIMIT 1
        `, [id, demand.card_key, target.card_id]);
        if (!misaligned) continue;

        await db.run(
          `INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(list_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
          [id, target.card_id, demand.quantity]
        );
        await db.run(`
          DELETE FROM list_cards
          WHERE list_id = ? AND card_id != ?
            AND card_id IN (
              SELECT sibling.id FROM card_cache sibling
              WHERE ${sqlCardKey('sibling')} = ?
            )
        `, [id, target.card_id, demand.card_key]);
        moved += 1;
      }
    });

    res.json({ message: 'Cards moved to their cheapest printings', moved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to move cards to cheapest printings' });
  }
});

// Rename / describe / recolor a list.
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, accent_color } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'List name is required' });
  }
  const accent = accent_color != null && accent_color.startsWith('#') ? accent_color : null;
  try {
    const result = await db.run(
      `UPDATE card_lists SET name = ?, description = ?, accent_color = ?
       WHERE id = ? AND user_id = ?`,
      [
        String(name).trim(),
        description != null ? description : '',
        accent,
        id,
        req.user.id
      ]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'List not found or unauthorized' });
    }
    res.json({ message: 'List updated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update list' });
  }
});

// Delete a list and its cards (list_cards cascade covers the second half).
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const list = await db.get(`SELECT id FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) {
      return res.status(404).json({ error: 'List not found or unauthorized' });
    }
    await db.run(`DELETE FROM card_lists WHERE id = ?`, [id]);
    res.json({ message: 'List deleted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

// Set a card's wanted quantity in the list (add or replace). No deck-style
// validation: lists have no ownership ceiling and no max-4.
router.post('/:id/cards', async (req, res) => {
  const { id } = req.params;
  const { card_id, quantity = 1 } = req.body;
  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  try {
    const list = await db.get(`SELECT id FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) {
      return res.status(404).json({ error: 'List not found or unauthorized' });
    }

    // Ensure the card exists in the cache — same dispatch the deck add uses,
    // because only the provider that minted the id can resolve it.
    let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      console.log(`Card ${card_id} not in cache. Fetching...`);
      const apiCard = await cardApi.getCardById(card_id);
      if (!apiCard) {
        return res.status(404).json({ error: `Card ${card_id} not found on any card provider.` });
      }
    }

    const equivalent = await db.get(`
      SELECT lc.card_id
      FROM list_cards lc
      JOIN card_cache existing_cc ON existing_cc.id = lc.card_id
      JOIN card_cache target_cc ON target_cc.id = ?
      WHERE lc.list_id = ?
        AND ${sqlCardKey('existing_cc')} = ${sqlCardKey('target_cc')}
      ORDER BY (lc.card_id = ?) DESC, lc.card_id
      LIMIT 1
    `, [card_id, id, card_id]);
    const effectiveCardId = equivalent ? equivalent.card_id : card_id;

    if (equivalent) {
      await db.run(`
        UPDATE list_cards
        SET quantity = CASE WHEN card_id = ? THEN ? ELSE 0 END
        WHERE list_id = ?
          AND card_id IN (
            SELECT existing_cc.id
            FROM card_cache existing_cc
            JOIN card_cache target_cc ON target_cc.id = ?
            WHERE ${sqlCardKey('existing_cc')} = ${sqlCardKey('target_cc')}
          )
      `, [effectiveCardId, qty, id, effectiveCardId]);
      await db.run(`DELETE FROM list_cards WHERE list_id = ? AND quantity <= 0`, [id]);
    } else {
      await db.run(
        `INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)`,
        [id, effectiveCardId, qty]
      );
    }
    res.json({ message: 'Card added to list' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add card to list' });
  }
});

// Bulk add, INCREMENTING quantities (the scanner sends a whole scan here; the
// single-card route above sets a quantity instead). Printing-equivalent rows
// merge the same way the single-card route does.
router.post('/:id/cards/bulk', async (req, res) => {
  const { id } = req.params;
  const entries = Array.isArray(req.body?.cards) ? req.body.cards : [];
  if (!entries.length || entries.length > 250) return res.status(400).json({ error: 'cards must be 1-250 entries' });
  try {
    const list = await db.get(`SELECT id FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) return res.status(404).json({ error: 'List not found or unauthorized' });
    let added = 0;
    const failed = [];
    for (const entry of entries) {
      const cardId = entry?.card_id;
      const qty = Math.max(1, parseInt(entry?.quantity, 10) || 1);
      if (!cardId) continue;
      try {
        let card = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [cardId]);
        if (!card && !(await cardApi.getCardById(cardId))) { failed.push(cardId); continue; }
        const equivalent = await db.get(`
          SELECT lc.card_id FROM list_cards lc
          JOIN card_cache existing_cc ON existing_cc.id = lc.card_id
          JOIN card_cache target_cc ON target_cc.id = ?
          WHERE lc.list_id = ? AND ${sqlCardKey('existing_cc')} = ${sqlCardKey('target_cc')}
          ORDER BY (lc.card_id = ?) DESC, lc.card_id LIMIT 1
        `, [cardId, id, cardId]);
        if (equivalent) {
          await db.run(`UPDATE list_cards SET quantity = quantity + ? WHERE list_id = ? AND card_id = ?`, [qty, id, equivalent.card_id]);
        } else {
          await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)`, [id, cardId, qty]);
        }
        added += qty;
      } catch (e) { console.error('list bulk add', cardId, e.message); failed.push(cardId); }
    }
    res.status(failed.length && !added ? 500 : 200).json({ added, failed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add cards to list' });
  }
});

// Remove a card from the list.
router.delete('/:id/cards/:card_id', async (req, res) => {
  const { id, card_id } = req.params;
  try {
    const list = await db.get(`SELECT id FROM card_lists WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!list) {
      return res.status(404).json({ error: 'List not found or unauthorized' });
    }
    await db.run(`
      DELETE FROM list_cards
      WHERE list_id = ?
        AND (
          card_id = ?
          OR card_id IN (
            SELECT existing_cc.id
            FROM card_cache existing_cc
            JOIN card_cache target_cc ON target_cc.id = ?
            WHERE ${sqlCardKey('existing_cc')} = ${sqlCardKey('target_cc')}
          )
        )
    `, [id, card_id, card_id]);
    res.json({ message: 'Card removed from list' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card from list' });
  }
});

module.exports = router;
