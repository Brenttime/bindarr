// Moxfield sync endpoints. Authenticated like everything else under /api;
// the intervals are instance-wide settings, so they ride the settings router
// (see routes/settings.js) rather than living here.
const express = require('express');
const db = require('../db');
const moxfieldSync = require('../moxfieldSync');
const moxfieldApi = require('../moxfieldApi');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// Status: authors this user tracks + per-deck freshness + current intervals.
// Also the source of truth for "is anything being synced right now".
router.get('/', async (req, res) => {
  try {
    const { authors } = await moxfieldSync.getStatus(req.user.id);
    const settings = await db.get(
      `SELECT moxfield_decklist_interval_min, moxfield_content_interval_min FROM app_settings WHERE id = 1`
    );
    res.json({
      authors,
      intervals: {
        decklist_min: settings ? settings.moxfield_decklist_interval_min : 60,
        content_min: settings ? settings.moxfield_content_interval_min : 1
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load Moxfield sync status' });
  }
});

// Add an author to track. Runs the first decklist sync inline so the decks
// appear the moment the call returns (a 30-deck author takes ~30s).
router.post('/authors', async (req, res) => {
  try {
    const report = await moxfieldSync.addAuthor(req.user.id, req.body.username);
    res.status(201).json(report);
  } catch (error) {
    if (error instanceof moxfieldApi.MoxfieldError || /Moxfield has no user/.test(error.message)) {
      return res.status(404).json({ error: error.message });
    }
    if (/Moxfield username is required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add Moxfield author', detail: error.message });
  }
});

// Stop tracking an author (removes its mirrored decks).
router.delete('/authors/:id', async (req, res) => {
  try {
    const report = await moxfieldSync.removeAuthor(req.user.id, parseInt(req.params.id, 10));
    res.json(report);
  } catch (error) {
    if (error && error.code === 'ALLOCATION_CONFLICT') return res.status(409).json({ error: error.message });
    if (/not found/i.test(error.message)) return res.status(404).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to remove Moxfield author' });
  }
});

// Force the slow job now (refresh the deck list for this author).
router.post('/authors/:id/sync-decklist', async (req, res) => {
  try {
    const report = await moxfieldSync.syncDecklist(parseInt(req.params.id, 10), { user: req.user });
    res.json(report);
  } catch (error) {
    if (/not found/i.test(error.message)) return res.status(404).json({ error: error.message });
    if (error instanceof moxfieldApi.MoxfieldError) {
      return res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Decklist sync failed', detail: error.message });
  }
});

// Force the fast job now (check this author's decks for content changes).
router.post('/authors/:id/sync-contents', async (req, res) => {
  try {
    const report = await moxfieldSync.runContentSync(parseInt(req.params.id, 10), { user: req.user });
    res.json(report);
  } catch (error) {
    if (/not found/i.test(error.message)) return res.status(404).json({ error: error.message });
    if (error instanceof moxfieldApi.MoxfieldError) {
      return res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Content sync failed', detail: error.message });
  }
});

// Force one specific deck to re-pull, regardless of its stamp (for the "this
// looks wrong, re-sync it" moment).
router.post('/decks/:publicId/sync', async (req, res) => {
  try {
    const report = await moxfieldSync.pullDeckContentByPublicId(req.user.id, req.params.publicId);
    res.json(report);
  } catch (error) {
    if (error && error.code === 'ALLOCATION_CONFLICT') return res.status(409).json({ error: error.message });
    if (/not found|not tracked/i.test(error.message)) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof moxfieldApi.MoxfieldError) {
      return res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Deck sync failed', detail: error.message });
  }
});

// Flip one deck's import switch: {enabled: boolean}. Disabling removes the
// local mirror and stops content pulls; re-enabling pulls it again.
router.put('/decks/:publicId', async (req, res) => {
  const enabled = req.body.enabled === true;
  try {
    const report = await moxfieldSync.setDeckEnabled(req.user.id, req.params.publicId, enabled);
    res.json(report);
  } catch (error) {
    if (error && error.code === 'ALLOCATION_CONFLICT') return res.status(409).json({ error: error.message });
    if (/not found/i.test(error.message)) return res.status(404).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to update Moxfield deck', detail: error.message });
  }
});

module.exports = router;
