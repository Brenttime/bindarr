// Search WOTC preconstructed decks by name and import one as a deck.
//
//   GET /api/precons?q=...          — ranked search over the (cached) index
//   POST /api/precons/import        — fetch the card list, resolve every
//                                     printing through Scryfall, create the deck
const express = require('express');
const db = require('../db');
const { bulkFetchByIdentifier } = require('../scryfallApi');
const {
  getPreconIndex, getPreconCardList, rankPrecons, importPreconCardsIntoDeck,
} = require('../utils/preconData');

const router = express.Router();

// Product types that carry a playable commander, and what a precon of that
// type starts out as. Everything else is a 60-card deck.
const COMMANDER_TYPES = new Set(['Commander Deck', 'MTGO Commander Deck', 'Commander Deck', 'Oathbreaker Deck']);

const defaultShape = (type) => (COMMANDER_TYPES.has(type)
  ? { format: 'Commander / EDH', category: 'Competitive', accentColor: '#8b5cf6', targetSize: 100 }
  : { format: 'Standard', category: 'Casual', accentColor: '#eab308', targetSize: 60 });

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const index = await getPreconIndex();
    const matches = rankPrecons(index.decks, q).slice(0, 50)
      .map(({ _score, _at, ...d }) => d);
    res.json({
      results: matches,
      // Only true when the live download failed and the last synced mirror is
      // being served — a 24-hour-old-but-fresh mirror is not stale.
      stale: index.source === 'stale',
      mtgjsonDate: index.mtgjsonDate || '',
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: `Precon search failed: ${err.message}` });
  }
});

router.post('/import', async (req, res) => {
  const { fileName, name, format, category, accentColor, targetSize, includeCommander = true } = req.body || {};
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'fileName is required' });
  }
  try {
    const list = await getPreconCardList(fileName);
    const shape = defaultShape(list.type);
    const rows = list.cards
      .filter((c) => (includeCommander && c.section === 'commander') ? true : c.section === 'mainboard')
      .map((c) => ({ set_id: c.setCode, number: c.number, quantity: c.count }));

    const result = await importPreconCardsIntoDeck({
      name: String(name || list.name || 'Preconstructed Deck'),
      description: list.code ? `Preconstructed: ${list.name} (${list.code})` : `Preconstructed: ${list.name}`,
      format: format || shape.format,
      category: category || shape.category,
      accentColor: accentColor || shape.accentColor,
      targetSize: Number.isFinite(Number(targetSize)) ? Number(targetSize) : shape.targetSize,
      userId: req.user.id,
      rows,
      cardById: bulkFetchByIdentifier,
      decksRun: db.run,
      cardsRun: db.run,
    });

    res.status(201).json({
      message: `Precon imported: ${result.cards} card types in the deck`,
      id: result.deckId,
      cards: result.cards,
      notFound: result.notFound,
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: `Precon import failed: ${err.message}`, notFound: err.notFound || 0 });
  }
});

module.exports = router;
