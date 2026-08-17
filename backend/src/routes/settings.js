const express = require('express');
const axios = require('axios');
const db = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// --- Version + update check ---

// backend/package.json is what the release workflow bumps, so it is the running
// build's version. The repo-root package.json is not bumped and would lie.
const APP_VERSION = require('../../package.json').version;
const RELEASES_API = 'https://api.github.com/repos/thenotoriousJeremy/bindarr/releases/latest';
const RELEASES_PAGE = 'https://github.com/thenotoriousJeremy/bindarr/releases';
// GitHub allows 60 unauthenticated calls/hour per IP, shared by every user of
// this instance. Cache hard: a new release is not urgent to the minute.
const UPDATE_CACHE_MS = 1000 * 60 * 60 * 6;
let updateCache = { at: 0, data: null };

// "1.4.9" < "1.4.10" — string compare gets this wrong, so compare numerically
// part by part. Anything non-numeric (a "-beta" suffix) is ignored.
function isNewer(candidate, current) {
  const parts = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  if (updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  const resp = await axios.get(RELEASES_API, {
    timeout: 8000,
    headers: { 'User-Agent': 'Bindarr', Accept: 'application/vnd.github+json' }
  });
  const latest = String(resp.data.tag_name || '').replace(/^v/i, '');
  const data = {
    latest,
    update_available: !!latest && isNewer(latest, APP_VERSION),
    release_url: resp.data.html_url || RELEASES_PAGE,
    published_at: resp.data.published_at || null
  };
  updateCache = { at: Date.now(), data };
  return data;
}

// Current version always answers offline; the update check is best-effort and
// reports its own failure rather than pretending the app is up to date.
router.get('/version', authenticateToken, async (req, res) => {
  const base = { version: APP_VERSION, releases_url: RELEASES_PAGE };
  if (req.query.check !== '1') return res.json(base);
  try {
    res.json({ ...base, ...(await checkForUpdate()) });
  } catch (error) {
    console.warn('Update check failed:', error.message);
    res.json({ ...base, check_failed: true });
  }
});

async function getEffectiveSettings() {
  const row = await db.get(`
    SELECT public_base_url, allow_member_set_builds, pokemon_provider,
           scan_exclude_tokens, scan_exclude_art_cards, scan_exclude_jumpstart, scan_exclude_promos,
           scan_exclude_digital
    FROM app_settings WHERE id = 1
  `);
  const public_base_url = (row && row.public_base_url) || process.env.PUBLIC_BASE_URL || '';
  const allow_member_set_builds = !!(row && row.allow_member_set_builds);
  const pokemon_provider = (row && row.pokemon_provider) || 'pokemontcg';
  const scan_exclude_tokens = !!(row && row.scan_exclude_tokens);
  const scan_exclude_art_cards = !!(row && row.scan_exclude_art_cards);
  const scan_exclude_jumpstart = !!(row && row.scan_exclude_jumpstart);
  const scan_exclude_promos = !!(row && row.scan_exclude_promos);
  // Defaults ON, so a missing row (or a read before the migration lands) must
  // read as excluded rather than as included — see the column comment in db.js.
  const scan_exclude_digital = row ? !!row.scan_exclude_digital : true;
  return {
    public_base_url,
    allow_member_set_builds,
    pokemon_provider,
    scan_exclude_tokens,
    scan_exclude_art_cards,
    scan_exclude_jumpstart,
    scan_exclude_promos,
    scan_exclude_digital,
  };
}

// Any logged-in user can read effective settings (needed to render share links)
router.get('/', authenticateToken, async (req, res) => {
  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// Only admins can override settings
router.put('/', authenticateToken, requireAdmin, async (req, res) => {
  const {
    public_base_url,
    allow_member_set_builds,
    pokemon_provider,
    scan_exclude_tokens,
    scan_exclude_art_cards,
    scan_exclude_jumpstart,
    scan_exclude_promos,
    scan_exclude_digital,
  } = req.body;

  if (allow_member_set_builds !== undefined) {
    await db.run(`UPDATE app_settings SET allow_member_set_builds = ? WHERE id = 1`, [allow_member_set_builds ? 1 : 0]);
  }
  if (pokemon_provider !== undefined) {
    await db.run(`UPDATE app_settings SET pokemon_provider = ? WHERE id = 1`, [pokemon_provider === 'tcgdex' ? 'tcgdex' : 'pokemontcg']);
  }
  if (scan_exclude_tokens !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_tokens = ? WHERE id = 1`, [scan_exclude_tokens ? 1 : 0]);
  }
  if (scan_exclude_art_cards !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_art_cards = ? WHERE id = 1`, [scan_exclude_art_cards ? 1 : 0]);
  }
  if (scan_exclude_jumpstart !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_jumpstart = ? WHERE id = 1`, [scan_exclude_jumpstart ? 1 : 0]);
  }
  if (scan_exclude_promos !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_promos = ? WHERE id = 1`, [scan_exclude_promos ? 1 : 0]);
  }
  if (scan_exclude_digital !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_digital = ? WHERE id = 1`, [scan_exclude_digital ? 1 : 0]);
  }

  if (public_base_url !== undefined) {
    const trimmed = public_base_url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'Public base URL must start with http:// or https://' });
    }
    const cleaned = trimmed.replace(/\/+$/, '');
    await db.run(`UPDATE app_settings SET public_base_url = ? WHERE id = 1`, [cleaned]);
  }

  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
// Exported for tests.
module.exports.isNewer = isNewer;
