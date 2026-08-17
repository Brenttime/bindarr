const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const tcgApi = require('../tcgApi');
const scryfallApi = require('../scryfallApi');
const setIndex = require('../setIndex');
const globalIndex = require('../globalIndex');
const { parseCardRow } = require('../utils/priceHelpers');
const languages = require('../utils/languages');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { BACKUP_DIR, listBackups, createBackup } = require('../backup');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

router.post('/seed-cards', async (req, res) => {
  try {
    let binder = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Binder' LIMIT 1`, [req.user.id]);
    if (!binder) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, ?, ?)
      `, ['Binder Seed Box', 'Binder', 'custom', req.user.id]);
      await db.createCompartments(result.lastID, 12, 9);
      binder = { id: result.lastID };
    }

    let box = await db.get(`SELECT id FROM locations WHERE user_id = ? AND type = 'Box' LIMIT 1`, [req.user.id]);
    if (!box) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, ?, ?, ?)
      `, ['Box Seed Box', 'Box', 'custom', req.user.id]);
      await db.createCompartments(result.lastID, 4, 40);
      box = { id: result.lastID };
    }

    const SEED_SETS = ['base1', 'sv1', 'swsh1'];
    const MOCK_POOL = [];
    for (const setId of SEED_SETS) {
      try {
        MOCK_POOL.push(...await tcgApi.getCardsBySet(setId, req.user.tcg_api_key));
        await new Promise(r => setTimeout(r, 500)); // Be gentle on the rate limits
      } catch (err) {
        console.error(`Seed: skipping Pokémon set ${setId}:`, err.message);
      }
    }
    const MTG_SEED_SETS = ['lea', 'mh3'];
    for (const setCode of MTG_SEED_SETS) {
      try {
        MOCK_POOL.push(...await scryfallApi.getCardsBySet(setCode));
        await new Promise(r => setTimeout(r, 500)); // Scryfall strictly requires 50-100ms between requests
      } catch (err) {
        console.error(`Seed: skipping MTG set ${setCode}:`, err.message);
      }
    }
    if (MOCK_POOL.length === 0) {
      // Fallback: If APIs are completely down/rate-limited, try to use whatever is already in the cache
      const cached = await db.all(`SELECT * FROM card_cache LIMIT 500`);
      if (cached.length > 0) {
        console.log(`Seed: APIs failed, falling back to ${cached.length} locally cached cards.`);
        for (const r of cached) {
          MOCK_POOL.push(parseCardRow(r));
        }
      } else {
        return res.status(502).json({ error: 'Could not fetch seed card data from the card APIs, and local cache is empty. Try again shortly.' });
      }
    }

    const seedSetIds = [...new Set(MOCK_POOL.map(c => c.set_id))];
    const seedSetPlaceholders = seedSetIds.map(() => '?').join(',');
    await db.run(
      `DELETE FROM collection WHERE user_id = ? AND card_id IN (
         SELECT id FROM card_cache WHERE set_id IN (${seedSetPlaceholders})
       )`,
      [req.user.id, ...seedSetIds]
    );

    const conditions = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played'];
    const languages = ['English', 'English', 'English', 'Japanese'];

    const printsForCard = (card) => {
      const options = [];
      if (card.price_normal > 0) options.push('Normal');
      if (card.price_holofoil > 0) options.push('Holofoil');
      if (card.price_reverse_holofoil > 0) options.push('Reverse Holofoil');
      return options.length > 0 ? options : ['Normal'];
    };

    let addedCount = 0;

    const randomEntry = (maxPrice) => {
      const card = MOCK_POOL[Math.floor(Math.random() * MOCK_POOL.length)];
      const prints = printsForCard(card);
      return {
        card,
        print: prints[Math.floor(Math.random() * prints.length)],
        condition: conditions[Math.floor(Math.random() * conditions.length)],
        language: languages[Math.floor(Math.random() * languages.length)],
        qty: Math.floor(Math.random() * 2) + 1,
        purchasePrice: parseFloat((Math.random() * maxPrice).toFixed(2))
      };
    };

    const fillLocation = async (locationId, maxPrice, fillRatio) => {
      const compartments = await db.all(
        `SELECT id, capacity FROM compartments WHERE location_id = ? ORDER BY idx`,
        [locationId]
      );
      for (const comp of compartments) {
        const slots = Math.max(1, Math.round(comp.capacity * fillRatio));
        for (let s = 0; s < slots; s++) {
          const e = randomEntry(maxPrice);
          await db.run(`
            INSERT INTO collection (card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [e.card.id, e.qty, e.condition, e.print, e.language, e.purchasePrice, locationId, comp.id, s * 1000, req.user.id]);
          addedCount += e.qty;
        }
      }
    };

    await fillLocation(binder.id, 10, 0.7);
    await fillLocation(box.id, 5, 0.6);

    let unsortedAdded = 0;
    for (let i = 0; i < 40; i++) {
      const e = randomEntry(5);
      await db.run(`
        INSERT INTO collection (card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id, position, user_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
      `, [e.card.id, e.qty, e.condition, e.print, e.language, e.purchasePrice, req.user.id]);
      addedCount += e.qty;
      unsortedAdded++;
    }

    res.json({ message: `Successfully seeded a large test collection: ${addedCount} cards for admin user (${unsortedAdded} left unsorted to try Assistant Mode on).` });
  } catch (error) {
    console.error('SEEDING ERROR:', error);
    res.status(500).json({ error: 'Failed to seed test cards' });
  }
});

// Get all users with their statistics
router.get('/users', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT id, username, role, share_enabled, created_at
      FROM users
      ORDER BY username ASC
    `);

    // Fetch stats for each user
    const usersWithStats = [];
    for (const u of users) {
      const stats = await db.get(`
        SELECT COUNT(c.id) as unique_cards, SUM(c.quantity) as total_cards,
          SUM(c.quantity * CASE
            WHEN c.printing = 'Holofoil' AND cc.price_holofoil IS NOT NULL AND cc.price_holofoil > 0 THEN cc.price_holofoil
            WHEN c.printing = 'Reverse Holofoil' AND cc.price_reverse_holofoil IS NOT NULL AND cc.price_reverse_holofoil > 0 THEN cc.price_reverse_holofoil
            WHEN c.printing = 'Normal' AND cc.price_normal IS NOT NULL AND cc.price_normal > 0 THEN cc.price_normal
            ELSE cc.price_trend
          END) as total_value
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.user_id = ?
      `, [u.id]);

      usersWithStats.push({
        ...u,
        total_cards: stats.total_cards || 0,
        unique_cards: stats.unique_cards || 0,
        total_value: parseFloat((stats.total_value || 0).toFixed(2))
      });
    }

    res.json(usersWithStats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve users list' });
  }
});

// Create a new user from Admin Panel
router.post('/users', async (req, res) => {
  const { username, password, role = 'member' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (role !== 'member' && role !== 'admin') {
    return res.status(400).json({ error: 'Invalid role specification' });
  }

  try {
    const existingUser = await db.get(`SELECT id FROM users WHERE username = ?`, [cleanUsername]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    const passwordHash = db.hashPassword(password);
    const shareToken = crypto.randomBytes(16).toString('hex');

    await db.run(`
      INSERT INTO users (username, password_hash, role, share_token, share_enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [cleanUsername, passwordHash, role, shareToken, 0]);

    res.status(201).json({ message: `User "${cleanUsername}" created successfully.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update a user (Change password or Role) from Admin Panel
router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { password, role } = req.body;

  try {
    const targetUser = await db.get(`SELECT id, username, role FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (password !== undefined) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const newHash = db.hashPassword(password);
      await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, id]);
    }

    if (role !== undefined) {
      if (role !== 'member' && role !== 'admin') {
        return res.status(400).json({ error: 'Invalid role' });
      }
      // Block admin demoting themselves
      if (parseInt(id, 10) === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote yourself from Administrator role.' });
      }
      await db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, id]);
    }

    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user from Admin Panel
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;

  if (parseInt(id, 10) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own Administrator account.' });
  }

  try {
    const targetUser = await db.get(`SELECT id, username FROM users WHERE id = ?`, [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM collection WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM locations WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM users WHERE id = ?`, [id]);

    res.json({ message: `User "${targetUser.username}" and all their card collections/locations have been permanently deleted.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});



// --- Set-index build management ---

const isGame = (g) => g === 'mtg' || g === 'pokemon';

// List persisted builds plus any in-flight/recent build progress.
router.get('/set-indexes', (req, res) => {
  res.json({ builds: setIndex.listBuilds(), progress: setIndex.getProgress() });
});

// Preview a set's printing count so the UI can warn about size before building.
// `lang` defaults to English, so every existing caller keeps its behaviour.
router.get('/set-indexes/preview', async (req, res) => {
  const { game, set, lang } = req.query;
  if (!isGame(game) || !set) return res.status(400).json({ error: 'game (mtg|pokemon) and set are required' });
  try {
    const cardCount = await setIndex.previewSet(game, set, lang);
    if (!cardCount) return res.status(404).json({ error: `No ${languages.toName(lang)} cards found for ${game} set "${set}"` });
    res.json({ game, set, lang: languages.toCode(lang), cardCount, estBytes: cardCount * 20 * 1024 });
  } catch (error) {
    res.status(502).json({ error: `Set lookup failed: ${error.message}` });
  }
});

// Start (or restart) a full-set build. Runs in the background; poll GET for progress.
router.post('/set-indexes', (req, res) => {
  const { game, set, lang, excludeChildCodes } = req.body;
  if (!isGame(game) || !set) return res.status(400).json({ error: 'game (mtg|pokemon) and set are required' });
  setIndex.startBuild(game, set, lang, { excludeChildCodes: Array.isArray(excludeChildCodes) ? excludeChildCodes : [] });
  res.status(202).json({ message: `Build started for ${game} ${set} (${languages.toCode(lang)})` });
});

// Remove a build's files. The language is a query param, not another path
// segment, so the existing DELETE URLs keep working unchanged.
router.delete('/set-indexes/:game/:set', (req, res) => {
  const { game, set } = req.params;
  if (!isGame(game)) return res.status(400).json({ error: 'invalid game' });
  setIndex.deleteBuild(game, set, req.query.lang);
  res.json({ message: `Removed ${game} ${set} index` });
});

// Browse sets for the set-index builder modal — returns all known sets with
// symbol/logo images for the chosen game, newest releases first.
router.get('/sets-browse', async (req, res) => {
  const { game, lang } = req.query;
  if (!isGame(game)) return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
  try {
    // Non-English Pokémon sets are a different list (and not in the `sets` table).
    if (game === 'pokemon' && !languages.isEnglish(lang)) {
      const sets = await require('../tcgdexApi').listSets(lang);
      return res.json([...sets].reverse()); // newest first, like the query below
    }
    // Some older rows may have NULL game (defaults to 'pokemon').
    const sets = await db.all(
      `SELECT id, name, series, printed_total, release_date, symbol_url, logo_url
       FROM sets WHERE game = ?1 OR (game IS NULL AND ?2 = 'pokemon')
       ORDER BY release_date DESC`,
      [game, game]
    );
    res.json(sets);
  } catch (error) {
    console.error('Error browsing sets:', error);
    res.status(500).json({ error: 'Failed to retrieve sets' });
  }
});

// --- Scan indexes (unified) ---

// THE getter for the scan-index UI: for one game+language, every buildable set
// with its index state, plus the whole-game rollup status and any in-flight build.
//
// One call rather than three (browse sets / list built indexes / check the global
// tables), because the three were what made two separate panels look like two
// separate features — the rollups are built FROM these set indexes.
router.get('/scan-indexes', async (req, res) => {
  const { game, lang } = req.query;
  if (!isGame(game)) return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
  const code = languages.toCode(lang);
  try {
    const data = await globalIndex.listSetIndexes(game, code);
    res.json({ ...data, progress: globalIndex.getProgress() });
  } catch (error) {
    res.status(502).json({ error: `Set list unavailable: ${error.message}` });
  }
});

// Build indexes for one game+language.
//
//   sets:   array of set codes to index, or omitted/null for the whole catalogue.
//   rollup: also build the whole-game tables (what code-free scanning needs).
//   filter: opaque description of how `sets` was chosen, recorded in the index so
//           a partial index can explain what it does not cover.
//   resume: continue an interrupted build instead of starting over.
router.post('/scan-indexes/build', (req, res) => {
  const { game, lang, sets, rollup, filter, resume } = req.body || {};
  if (!isGame(game)) return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
  if (sets !== undefined && sets !== null && !Array.isArray(sets)) {
    return res.status(400).json({ error: 'sets must be an array of set codes, or omitted for all' });
  }
  const code = languages.toCode(lang);
  const started = resume
    ? globalIndex.resumeBuild(game, code)
    : globalIndex.startBuild(game, code, {
      rollup: rollup !== false,
      only: Array.isArray(sets) && sets.length ? sets : null,
      filter: filter || null,
    });
  if (!started) return res.status(409).json({ error: `A ${game} (${code}) build is already running` });
  const scope = Array.isArray(sets) && sets.length ? `${sets.length} set(s)` : 'every set';
  const what = rollup === false ? 'Set indexing' : 'Index build';
  res.status(202).json({ message: `${what} ${resume ? 'resumed' : 'started'} for ${game} (${code}) — ${scope}` });
});

// --- Global scan index build management ---

// On-disk status of the whole-game CLIP+ORB indexes plus any in-flight build.
//
// `langs` is a comma-separated list (default English) so the panel only lists the
// languages the user actually collects — each one is a separate multi-hour build,
// and offering all eleven at once would be an invitation to start a week of work.
router.get('/global-indexes', (req, res) => {
  const langs = String(req.query.langs || 'en').split(',').map(s => s.trim()).filter(Boolean);
  const codes = langs.length ? langs.map(languages.toCode) : ['en'];
  res.json({
    games: globalIndex.listGlobals(codes),
    progress: globalIndex.getProgress(),
  });
});

// Start (or restart) an index build for one game+language. Background; poll GET
// for progress. Heavy: every set fetched and every card image encoded, hours.
//
//   rollup: true  (default) index every set AND build the whole-game tables, so
//                 scanning without a set code works.
//   rollup: false index every set and stop.
//
// Both are the same walk. `rollup: false` replaced a client-side loop that fired
// one request per set with no queue — ~460 concurrent set builds for MTG.
// `resume: true` continues from whatever a previous interrupted attempt left.
router.post('/global-indexes', (req, res) => {
  const { game, lang, resume, rollup } = req.body;
  if (!isGame(game)) return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
  const code = languages.toCode(lang);
  const started = resume
    ? globalIndex.resumeBuild(game, code)
    : globalIndex.startBuild(game, code, { rollup: rollup !== false });
  if (!started) return res.status(409).json({ error: `A ${game} (${code}) build is already running` });
  const what = rollup === false ? 'Set indexing' : 'Global build';
  res.status(202).json({ message: `${what} ${resume ? 'resumed' : 'started'} for ${game} (${code})` });
});

// How many of a game+language's sets are indexed. Hits the provider for the set
// list, so it is a separate call from the cheap status above rather than folded
// into it — the panel asks for it per row on demand.
router.get('/global-indexes/coverage', async (req, res) => {
  const { game, lang } = req.query;
  if (!isGame(game)) return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
  try {
    res.json(await globalIndex.coverage(game, languages.toCode(lang)));
  } catch (error) {
    res.status(502).json({ error: `Coverage unavailable: ${error.message}` });
  }
});

// Check a game+language's card source and encoder before committing to a build.
// Answers "will this even work" in seconds rather than an hour in — issue #29 was
// a broken card source discovered the slow way.
router.get('/global-indexes/preflight', async (req, res) => {
  const { game, lang } = req.query;
  if (!isGame(game)) return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
  const code = languages.toCode(lang);
  try {
    res.json({ game, lang: code, ok: true, ...(await globalIndex.preflight(game, code)) });
  } catch (e) {
    res.status(502).json({ game, lang: code, ok: false, error: e.message });
  }
});

// Stop an in-flight global build. The live index is untouched and the staged
// files are kept, so the build can be resumed rather than restarted.
router.delete('/global-indexes/:game', (req, res) => {
  const { game } = req.params;
  if (!isGame(game)) return res.status(400).json({ error: 'invalid game' });
  const code = languages.toCode(req.query.lang);
  const stopped = globalIndex.stopBuild(game, code);
  res.json({ message: stopped ? `Stopped ${game} (${code}) build` : `No ${game} (${code}) build running` });
});

// --- Database backup --- (see ../backup.js)

router.get('/backups', (req, res) => {
  res.json({ dir: BACKUP_DIR, backups: listBackups() });
});

router.post('/backups', async (req, res) => {
  try {
    const meta = await createBackup();
    res.status(201).json(meta);
  } catch (error) {
    console.error('BACKUP ERROR:', error);
    res.status(500).json({ error: 'Backup failed', message: error.message });
  }
});

router.get('/backups/:file/download', (req, res) => {
  const name = path.basename(req.params.file); // strip any path traversal
  const full = path.join(BACKUP_DIR, name);
  if (!name.endsWith('.bak') || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  res.download(full);
});

module.exports = router;
