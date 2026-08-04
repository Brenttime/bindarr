const express = require('express');
const db = require('../db');
const languages = require('../utils/languages');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { game, lang } = req.query;
    // Non-English Pokémon sets are a different list entirely — Japan gets sets the
    // West never sees — and they are not in the `sets` table, which is keyed by id
    // alone while the same id exists in several languages. Ask TCGdex instead.
    if (game === 'pokemon' && !languages.isEnglish(lang)) {
      try {
        return res.json(await require('../tcgdexApi').listSets(lang));
      } catch (err) {
        console.error(`Failed to fetch ${lang} Pokémon sets from TCGdex:`, err.message);
        return res.json([]); // set autocomplete is a convenience; searching still works
      }
    }
    const where = game ? `WHERE game = ?` : '';
    const params = game ? [game] : [];
    const sets = await db.all(`
      SELECT id, name, series, printed_total, total, release_date, ptcgo_code, symbol_url, logo_url, game
      FROM sets
      ${where}
      ORDER BY release_date ASC
    `, params);
    res.json(sets);
  } catch (error) {
    console.error('Error fetching sets:', error);
    res.status(500).json({ error: 'Failed to retrieve sets' });
  }
});

module.exports = router;
