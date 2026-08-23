const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const { parseCardRow } = require('../utils/priceHelpers');
const { buildCardListText } = require('../../../shared/cardListText.js');

const router = express.Router();

// Card lists: wishlists, buylists, missing-card lists — cards tracked but not
// necessarily owned (the ManaBox "lists" concept). Separate entity from decks
// on purpose: no format, no 4-copy rule, no checkout, no ownership ceiling on
// quantities.

// One user's lists with card counts.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT
         l.id, l.name, l.description, l.game, l.accent_color, l.created_at,
         COUNT(lc.card_id) AS total_card_types,
         COALESCE(SUM(lc.quantity), 0) AS total_cards
       FROM card_lists l
       LEFT JOIN list_cards lc ON l.id = lc.list_id
       WHERE l.user_id = ?
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
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
  const { name, description = '', game = 'pokemon', accent_color = '#10b981', list_text = '' } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'List name is required' });
  }
  const listGame = ['pokemon', 'mtg'].includes(game) ? game : 'pokemon';
  const accent = typeof accent_color === 'string' && accent_color.startsWith('#') ? accent_color : '#10b981';

  try {
    const result = await db.run(
      `INSERT INTO card_lists (name, description, game, accent_color, user_id) VALUES (?, ?, ?, ?, ?)`,
      [String(name).trim(), description || '', listGame, accent, req.user.id]
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
          `SELECT id FROM card_cache WHERE LOWER(name) = LOWER(?) AND game = ? LIMIT 1`,
          [cardName, listGame]
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
    const cards = await db.all(
      `SELECT
         lc.quantity,
         cc.id, cc.name, cc.printed_name,
         cc.supertype, cc.subtypes, cc.types,
         cc.rarity, cc.set_id, cc.set_name, cc.number,
         cc.image_url, cc.price_trend,
         (SELECT COALESCE(SUM(quantity), 0) FROM collection
          WHERE card_id = cc.id AND user_id = ? AND list_type = 'collection') AS owned_qty
       FROM list_cards lc
       JOIN card_cache cc ON lc.card_id = cc.id
       WHERE lc.list_id = ?
       ORDER BY cc.name ASC`,
      [req.user.id, id]
    );
    res.json({ ...list, cards: cards.map(parseCardRow) });
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
    const rows = await db.all(
      `SELECT lc.quantity, cc.name, cc.set_id, cc.number
       FROM list_cards lc
       JOIN card_cache cc ON lc.card_id = cc.id
       WHERE lc.list_id = ?
       ORDER BY cc.name ASC`,
      [id]
    );
    res.type('text/plain').send(buildCardListText(rows, style));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to build card list' });
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
      const tcgApiKey = req.user.tcg_api_key;
      const apiCard = await cardApi.getCardById(card_id, { tcgApiKey });
      if (!apiCard) {
        return res.status(404).json({ error: `Card ${card_id} not found on any card provider.` });
      }
    }

    await db.run(
      `INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)
       ON CONFLICT(list_id, card_id) DO UPDATE SET quantity = ?`,
      [id, card_id, qty, qty]
    );
    res.json({ message: 'Card added to list' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add card to list' });
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
    await db.run(`DELETE FROM list_cards WHERE list_id = ? AND card_id = ?`, [id, card_id]);
    res.json({ message: 'Card removed from list' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card from list' });
  }
});

module.exports = router;
