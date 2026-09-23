// Limited land-base helper: turn a pasted 40-card decklist into mana-pip
// counts and existing (non-basic) land sources for the Limited Lands tab.
//
//   POST /api/limited/analyze  { list: "2 Doom Blade\n1 Scoured Barrens\n..." }
//
// Card data comes from Scryfall /cards/collection by name (the same queued,
// rate-limited client the rest of Bindarr uses). Nothing is stored.
const express = require('express');
const { client, scryPostRetried } = require('../scryfallApi');
const { parseDecklist, analyzeCards } = require('../utils/limitedMana');

const router = express.Router();
const BATCH = 75;

router.post('/analyze', async (req, res) => {
  const text = req.body && typeof req.body.list === 'string' ? req.body.list : '';
  if (text.length > 20000) return res.status(413).json({ error: 'Decklist is too long' });
  const entries = parseDecklist(text);
  if (!entries.length) return res.status(400).json({ error: 'No cards found in the list' });
  if (entries.length > 120) return res.status(400).json({ error: 'Too many distinct cards (max 120)' });
  try {
    const found = new Map();
    const notFound = [];
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH);
      const resp = await scryPostRetried('/cards/collection', { identifiers: chunk.map(e => ({ name: e.name })) });
      for (const raw of (resp.data && resp.data.data) || []) {
        found.set(String(raw.name).toLowerCase(), raw);
        // Double-faced cards answer to their front face name too.
        const front = String(raw.name).split(' // ')[0].toLowerCase();
        if (!found.has(front)) found.set(front, raw);
      }
      for (const nf of (resp.data && resp.data.not_found) || []) notFound.push(nf.name);
    }
    const cards = [];
    for (const e of entries) {
      const raw = found.get(e.name.toLowerCase());
      if (raw) cards.push({ quantity: e.quantity, card: raw });
    }
    res.json({ ...analyzeCards(cards), notFound });
  } catch (err) {
    console.error('limited analyze failed', err.message);
    res.status(502).json({ error: 'Card lookup failed. Try again in a moment.' });
  }
});

module.exports = router;
