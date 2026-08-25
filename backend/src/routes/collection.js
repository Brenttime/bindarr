const express = require('express');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const cvScan = require('../cvScan');
const languages = require('../utils/languages');
const cardApi = require('../utils/cardApi');
const { searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { parseSetList } = require('../utils/setQuery');
const { checkedOutAllocation, setStackQuantity } = require('../utils/collectionHelpers');
const { validateDeckAddition } = require('../utils/deckRules');
const { splitPrice } = require('../utils/splitPrice');
const { buildCardListText } = require('../../../shared/cardListText.js');

const router = express.Router();

// The one shared definition of a legal collection.printing value — the add,
// bulk-add and bulk-set routes all write the column, so they must agree with
// the CHECK constraint in db.js. Anything outside this list is rejected before
// it can be stored.
const PRINTING_VALUES = ['Normal', 'Holofoil'];

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
async function attachOwnedQty(cards, userId) {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = 'collection' AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));
  for (const c of cards) c.owned_qty = owned.get(c.id) || 0;
}

// 1. Search cards (Scryfall + database cache).

router.get('/search', searchLimiter, async (req, res) => {
  const { name, number, set, scope = 'database', lang, prints } = req.query;
  // 1-based page over `limit`-sized pages. 250 is a sane cap on how much one
  // Scryfall search will page through per request.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(req.query.limit, 10) || 60));
  try {
    const { cards, total } = await scryfallApi.searchCards({
      name, number, set, scope, userId: req.user.id, lang,
      allPrints: prints === '1', page, limit,
    });
    await attachOwnedQty(cards, req.user.id);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(cards);
  } catch (error) {
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 1b. Identify a scanned card image by visual-feature match.
// Which sets the scanner can actually answer for, and how completely.
//
// Not admin-only: this is what the set filter needs to stop offering sets that
// match nothing. Read-only counts, no build controls.
router.get('/scan-sets', async (req, res) => {
  const { lang } = req.query;
  try {
    // `builtLangs` rides along so the scanner's language picker knows which
    // languages a local catalog actually exists for.
    res.json({
      ...await require('../catalog').setCounts('mtg', languages.toName(lang)),
      builtLangs: cvScan.builtLangs('mtg'),
    });
  } catch (e) {
    console.error('scan-sets failed:', e.message);
    res.status(500).json({ error: 'Could not read catalog set counts' });
  }
});

router.post('/scan-match', searchLimiter, async (req, res) => {
  try {
    const { image, set = '', lang, cropped = false } = req.body || {};
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });

    const langName = languages.toName(lang);

    // Set scoping is a FILTER over the catalog, not a different pipeline. The ORB
    // path needed a per-set index built before it could scope a scan (that was the
    // client's "preparing set" wait); a cosine sweep just skips rows that do not
    // belong. A scoped scan is the same scan over fewer candidates — cheaper and
    // more accurate, with nothing to build.
    //
    // Language is not a gate either. A card's artwork is the same in every
    // language, so the English catalog answers "which card is this" for a Spanish
    // or Japanese photo; when a catalog exists in the scanned language cvScan uses
    // it instead. Measured 100% right-card on Spanish/Japanese/French/Italian MTG
    // off the English catalog.
    if (!cvScan.isBuilt('mtg', langName)) {
      // There is no second matcher to fall back to. Say what is missing and what
      // fixes it, rather than an empty candidate list that reads to the user as
      // "your card could not be identified".
      return res.status(503).json({
        lang: langName, candidates: [], verified: false, notBuilt: true,
        error: 'No scan catalog is built for this language yet. An admin can build one from Settings → Scan catalogs.',
      });
    }

    const result = await cvScan.match(buf, 'mtg', 8, { sets: parseSetList(set), lang: langName, cropped: !!cropped });

    result.candidates = await Promise.all(result.candidates.map(async (cand) => {
      // getCardById fetches and caches a printing this install has never seen,
      // so a match the cache has no row for still resolves.
      if (cand.cardId) {
        const card = await scryfallApi.getCardById(cand.cardId).catch(() => null);
        if (!card) return cand;
        // The catalog that answered is whichever one exists, and for most
        // installs that is the English one — the artwork is identical across
        // languages, so an English catalog identifies a Japanese card perfectly
        // well and then hands back the ENGLISH printing. Re-express it in the
        // scanned language here (cvScan.load defers to the route for exactly
        // this), or the picker shows English names and art, and the copy gets
        // filed as the English printing.
        //
        // Same set and collector number, different Scryfall id: the localized
        // card IS a different printing row, which is the one the collection
        // should reference.
        const localized = await scryfallApi
          .getPrintingInLang(card.set_id, card.number, langName)
          .catch(() => null);
        const use = localized || card;
        return { ...cand, name: use.name, set: use.set_id, number: use.number, card: use };
      }
      return cand;
    }));
    return res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// Text card list of what the user owns — the shape ManaBox / TCGplayer
// buylist tools paste: "qty Name" (plain) or "qty Name (SET) num" (detailed).
// The frontend bulk bar formats the same rows itself, so this endpoint exists
// for scripts and API-key users who want the identical text without pulling
// the whole /api/collection payload.
router.get('/collection/cardlist', async (req, res) => {
  try {
    const style = req.query.style === 'detailed' ? 'detailed' : 'plain';
    const rows = await db.all(
      `SELECT c.quantity, cc.name, cc.set_id, cc.number
       FROM collection c
       JOIN card_cache cc ON c.card_id = cc.id
       WHERE c.user_id = ? AND c.list_type = 'collection'
       ORDER BY c.added_at DESC`,
      [req.user.id]
    );
    res.type('text/plain').send(buildCardListText(rows, style));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to build card list' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        cc.name,
        -- The localized name for a non-English printing, so every view that
        -- renders a collection card can show it as the card actually reads.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_currency,
        cc.price_source,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        cc.tcgplayer_product_id
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const alloc = await checkedOutAllocation(req.user.id);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, localization,
// insertion, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
class AddCardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function addCardToCollection(user, body) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    list_type = 'collection',
    is_trade = 0,
    stackable = false
  } = body;
  const req = { user, body };

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }
  if (!PRINTING_VALUES.includes(printing)) {
    throw new AddCardError(400, `Invalid printing: ${printing}`);
  }

  {
    // A card matched by a set-scoped scan was cached from a set brief:
    // name, number and art only. Fill it in before it enters the collection, or it
    // is stored with no price, no marketplace link and a defaulted rarity — which
    // is what it then shows in the inspector forever.
    await cardApi.hydrate(card_id);

    let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      card = await cardApi.getCardById(card_id);
      if (!card) {
        throw new AddCardError(404, `Card ID ${card_id} not found.`);
      }
    }

    // File the copy against the printing it actually IS. The card was picked in
    // whatever language the search ran in, but `language` is set separately — Quick
    // Add's dropdown, a scan the English catalog answered — so a Japanese copy
    // routinely arrived pointing at the English row, and then showed the English
    // name, art and price in every view. Null (never printed in that language)
    // keeps the row that was picked.
    let cardId = card_id;
    const localized = await cardApi.printingInLanguage(card, language);
    if (localized) {
      card = localized;
      cardId = localized.id;
    }

    let lastInsertedId = null;
    const count = Math.max(1, parseInt(quantity, 10) || 1);
    // Stacking is quantity-on-one-row, which is meaningful only for
    // interchangeable copies.
    const stack = !!stackable;

    if (stack) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          is_trade, list_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        cardId, req.user.id, count, condition, printing, language, purchase_price || 0,
        is_trade ? 1 : 0, list_type
      ]);
      lastInsertedId = result.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const result = await db.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, language, purchase_price,
            is_trade, list_type
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
        `, [
          cardId, req.user.id, condition, printing, language, purchase_price || 0,
          is_trade ? 1 : 0, list_type
        ]);
        lastInsertedId = result.lastID;
      }
    }

    await recordPrice(cardId, card.price_trend);

    return {
      message: 'Card added to collection',
      id: lastInsertedId
    };
  }
}

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  try {
    res.status(200).json(await addCardToCollection(req.user, req.body));
  } catch (error) {
    if (error instanceof AddCardError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
router.post('/collection/bulk-add', async (req, res) => {
  const { card_ids = [], ...shared } = req.body;
  if (!Array.isArray(card_ids) || card_ids.length === 0) {
    return res.status(400).json({ error: 'card_ids is required' });
  }
  if (card_ids.length > BULK_ADD_MAX) {
    return res.status(400).json({ error: `Cannot add more than ${BULK_ADD_MAX} cards at once.` });
  }
  // Sequential on purpose: preserve input order and avoid overlapping cache
  // hydration/insertion work for duplicate cards in the same request.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError)) console.error(error);
      failed.push({ card_id, error: error instanceof AddCardError ? error.message : 'Failed to add card' });
    }
  }
  const qty = Math.max(1, parseInt(shared.quantity, 10) || 1);
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty > 1 ? ` (x${qty} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, language, purchase_price,
    list_type, is_trade, favorite, notes
  } = req.body;

  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const updates = [];
    const params = [];

    // Absolute, not additive: see the reconcile below. Deliberately NOT part of
    // the UPDATE — setStackQuantity owns the quantity column so the two can
    // never disagree about how many copies the row stands for.
    const requestedQty = quantity !== undefined ? Math.max(1, parseInt(quantity, 10) || 1) : null;
    if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) {
      // Reject before the DB: the CHECK constraint would reject it too, but only
      // after this request is already half through its writes.
      if (!PRINTING_VALUES.includes(printing)) {
        return res.status(400).json({ error: `Invalid printing: ${printing}` });
      }
      updates.push('printing = ?'); params.push(printing);
    }
    if (language !== undefined) { updates.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
    if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }

    if (updates.length > 0) {
      params.push(id, req.user.id);
      await db.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    // Quantity is absolute — it is how many copies the user says they own, and
    // in the stacked collection view the number in the form is the total across
    // the identical rows, not this row alone. So reconcile the whole stack to
    // it, up or down. It used to only ever insert (quantity - 1) extra rows,
    // which made lowering the number a no-op and made every save duplicate the
    // entry instead of editing it.
    if (requestedQty !== null) {
      await setStackQuantity(db, req.user.id, id, requestedQty);
    }

    res.json({ message: 'Collection entry updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'purchase_split', 'add_to_deck'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const BULK_PRINTINGS = PRINTING_VALUES;
router.post('/collection/bulk', async (req, res) => {
  const { entry_ids = [], action, value } = req.body;
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const ids = entry_ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid entry_ids' });
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      const rows = await db.all(
        `SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (${placeholders}) AND user_id = ? GROUP BY card_id`,
        [...ids, req.user.id]
      );

      let added = 0;
      const rejected = [];
      for (const row of rows) {
        const existing = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, row.card_id]);
        const current = existing ? existing.quantity : 0;
        const newQty = current + row.total_qty;
        // Enforce deck rules (owned cap + max 4 per name) so this path can't
        // bypass the limits the deck builder enforces.
        const check = await validateDeckAddition({ deckId, userId: req.user.id, cardId: row.card_id, newQty });
        if (!check.ok) { rejected.push(check.error); continue; }
        await db.run(
          `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
          [deckId, row.card_id, newQty]
        );
        added += row.total_qty;
      }
      const msg = rejected.length
        ? (added ? `Added ${added} card(s). ${rejected[0]}` : rejected[0])
        : `Added ${added} card(s) to deck`;
      return res.json({ message: msg, affected: added, rejected: rejected.length });
    }

    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'trade' || action === 'untrade') {
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!['collection', 'wishlist'].includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      const allowed = action === 'condition' ? BULK_CONDITIONS : BULK_PRINTINGS;
      if (!allowed.includes(value)) return res.status(400).json({ error: `Invalid ${action}` });
      // Column name is action, drawn from the BULK_ACTIONS whitelist (not user
      // input), so it is safe to interpolate.
      const result = await db.run(`UPDATE collection SET ${action} = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Set ${action} on ${result.changes} card(s)`, affected: result.changes });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!(total >= 0)) return res.status(400).json({ error: 'total must be a non-negative number' });
      const rows = await db.all(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      for (let i = 0; i < rows.length; i++) {
        await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [shares[i], rows[i].id, req.user.id]);
      }
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

module.exports = router;
