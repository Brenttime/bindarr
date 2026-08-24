const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseThirdPartyCSV } = require('../utils/csvMappers');
const { generateExportCSV } = require('../utils/csvExporters');
const { resolveCardPrice } = require('../utils/priceHelpers');

// Export endpoint
router.get('/export', async (req, res) => {
  const { format = 'csv', ecosystem = 'internal' } = req.query;
  const targetFormat = (ecosystem || format || 'internal').toLowerCase();

  try {
    const query = `
      SELECT 
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.added_at,
        cc.id as card_id,
        cc.name as name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id as set_code,
        cc.set_name,
        cc.number as collector_number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.user_id = ?
    `;
    const raw = await db.all(query, [req.user.id]);
    // market_price used to be cc.price_trend flat, which exported the wrong number
    // for every foil — the same case resolveCardPrice exists to get right. An
    // export that disagrees with the dashboard is worse than no export: it is a
    // spreadsheet someone will trust.
    // price_trend is destructured OUT along with the per-printing columns: the CSV
    // strategies read `item.price_trend || item.market_price`, so leaving it in
    // would win over the resolved number and export the raw price anyway.
    const rows = raw.map(({ price_trend, price_normal, price_holofoil, ...keep }) => ({
      ...keep,
      market_price: resolveCardPrice({ price_trend, price_normal, price_holofoil, ...keep }),
    }));

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=bindarr_collection_${targetFormat}.json`);
      return res.json(rows);
    }

    const csvContent = generateExportCSV(rows, targetFormat);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=bindarr_collection_${targetFormat}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// Import endpoint
router.post('/import', async (req, res) => {
  const { format = 'internal', data } = req.body;
  if (!data) {
    return res.status(400).json({ error: 'No data provided' });
  }

  try {
    let rawItems = [];

    if (format.toLowerCase() === 'json') {
      rawItems = typeof data === 'string' ? JSON.parse(data) : data;
    } else {
      let lines = [];
      if (typeof data === 'string') {
        lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      }
      if (lines.length <= 1) {
        return res.status(400).json({ error: 'CSV file is empty or missing headers' });
      }

      const parseCSVLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      };

      const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
      const parsedRows = [];

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]).map(v => v.replace(/^"|"$/g, ''));
        if (values.length < headers.length) continue;

        const rowObj = {};
        headers.forEach((h, idx) => {
          rowObj[h] = values[idx];
        });
        parsedRows.push(rowObj);
      }

      rawItems = parseThirdPartyCSV(parsedRows, format);
    }

    if (!Array.isArray(rawItems)) {
      return res.status(400).json({ error: 'Invalid data payload' });
    }

    // This install is MTG-only now, but an export made BEFORE the Pokemon
    // removal still carries Pokemon cards (game = 'pokemon') and Pokemon-era
    // finishes (Reverse Holofoil / 1st Edition / Promo). Without this guard such
    // a file re-imports exactly what the migration just deleted — the collection
    // INSERT would even fail the new CHECK constraint, but only mid-transaction.
    // Reject the offending rows up front with a clear message instead.
    const allowedPrintings = ['Normal', 'Holofoil'];
    const rejected = [];
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      const game = String(item.game ?? '').toLowerCase();
      if (game && game !== 'mtg') {
        rejected.push({ index: i, reason: `game '${item.game}' is not supported (this install is MTG-only)` });
        continue;
      }
      if (item.printing !== undefined && item.printing !== '' &&
          !allowedPrintings.includes(item.printing)) {
        rejected.push({ index: i, reason: `printing '${item.printing}' is not supported` });
      }
    }
    if (rejected.length > 0) {
      return res.status(400).json({
        error: `Imported ${rawItems.length - rejected.length} of ${rawItems.length}; ${rejected.length} rejected.`,
        rejected
      });
    }

    let importedCount = 0;

    await db.withTransaction(async () => {
      for (const item of rawItems) {
        let cardId = item.card_id || item.id;
        if (!cardId && item.set_code && item.collector_number) {
          cardId = `${item.set_code.toLowerCase()}-${item.collector_number}`;
        }
        if (!cardId && item.name) {
          cardId = item.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        }

        if (!cardId) continue;

        let cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [cardId]);
        if (!cached) {
          await db.run(
            `INSERT OR IGNORE INTO card_cache 
             (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              cardId,
              item.name || 'Imported Card',
              item.supertype || 'Card',
              '[]',
              JSON.stringify(item.types || []),
              item.rarity || 'Common',
              item.set_code || item.set_id || '',
              item.set_name || item.set_code || 'Imported Set',
              item.collector_number || item.number || '',
              item.image_url || '',
              item.market_price || item.purchase_price || 0
            ]
          );
        }

        await db.run(
          `INSERT INTO collection 
           (card_id, user_id, quantity, condition, printing, language, purchase_price, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            cardId,
            req.user.id,
            item.quantity || 1,
            item.condition || 'Near Mint',
            item.printing || 'Normal',
            item.language || 'English',
            item.purchase_price || 0
          ]
        );
        importedCount++;
      }
    });

    return res.json({ success: true, count: importedCount, message: `Successfully imported ${importedCount} items.` });
  } catch (error) {
    return res.status(500).json({ error: 'Import failed', message: error.message });
  }
});

module.exports = router;
