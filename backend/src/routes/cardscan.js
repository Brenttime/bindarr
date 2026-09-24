// Fast OCR card scanner (the `cardscan` sidecar, github.com/Brenttime/cardscan).
//
// The browser owns the camera and freezes one frame; the sidecar finds every
// card in it (/detect) and reads title + collector footer for the native crops
// (/scan). Identity is proven by text against Scryfall's full printing index,
// so a result is an exact printing or nothing — no nearest-neighbour guesses.
// This router only proxies and then maps Scryfall ids onto card_cache rows so
// the client can file them through the normal POST /api/collection.
//
//   GET  /api/cardscan/status   sidecar health (the UI hides itself if down)
//   POST /api/cardscan/detect   image/jpeg overview -> candidate quads
//   POST /api/cardscan/scan     { cards:[{number,image,box,quad}] } -> results
const express = require('express');
const axios = require('axios');
const scryfallApi = require('../scryfallApi');

const router = express.Router();
const BASE = (process.env.CARDSCAN_URL || 'http://cardscan:8321').replace(/\/$/, '');
// The sidecar serialises OCR behind one lock; a scene batch is ~0.5-2 s.
const TIMEOUT_MS = 20000;
const http = axios.create({ baseURL: BASE, timeout: TIMEOUT_MS, validateStatus: () => true, maxBodyLength: 40e6, maxContentLength: 40e6 });

function upstreamError(res, e) {
  const down = e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN');
  res.status(down ? 503 : 502).json({ ok: false, unavailable: !!down, error: down ? 'Scanner service is not running' : 'Scanner service error' });
}

router.get('/status', async (req, res) => {
  try {
    const r = await http.get('/api/health', { timeout: 2500 });
    res.status(r.status === 200 ? 200 : 503).json({ ok: r.status === 200, ...(typeof r.data === 'object' ? r.data : {}) });
  } catch (e) { upstreamError(res, e); }
});

router.post('/detect', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '15mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ ok: false, error: 'Missing image' });
  try {
    const r = await http.post('/api/detect-cards', req.body, { headers: { 'Content-Type': 'image/jpeg', 'X-Scan-Source': 'browser-camera' } });
    res.status(r.status).json(r.data);
  } catch (e) { upstreamError(res, e); }
});

// Only the fields the client renders; the sidecar result carries OCR debug too.
async function hydrate(result) {
  const out = {
    number: result.scene_number, ok: !!result.ok, error: result.ok ? undefined : result.error,
    title: result.title || result.identified?.name || null,
    via: result.footer_ocr?.resolved_by || result.identified?.via || null,
  };
  const sid = result.ok && result.card?.id;
  if (sid) {
    const card = await scryfallApi.getCardById(`mtg-${sid}`).catch(() => null);
    if (card) out.card = card;
    else { out.ok = false; out.error = 'printing not in the card database yet'; }
  }
  return out;
}

// One round trip: the full frame goes up, the sidecar detects, warps and reads
// from the same decoded pixels. Cards it has already identified on the table
// come back from its identity cache without OCR.
router.post('/frame', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '15mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ ok: false, error: 'Missing image' });
  try {
    const t0 = Date.now();
    const r = await http.post('/api/scan-frame', req.body, { headers: { 'Content-Type': 'image/jpeg' } });
    if (r.status !== 200 || !r.data?.ok) return res.status(r.status === 200 ? 422 : r.status).json(r.data);
    const results = await Promise.all((r.data.results || []).map(async (x) => ({ ...(await hydrate(x)), cached: !!x.cached })));
    res.json({
      ok: true, frame: r.data.frame,
      candidates: (r.data.candidates || []).map(c => ({ number: c.number, box: c.box, quad: c.quad, eligible: c.eligible, status: c.status })),
      results, timings: { ...r.data.timings, proxy_ms: Date.now() - t0 },
    });
  } catch (e) { upstreamError(res, e); }
});

router.post('/scan', async (req, res) => {
  const cards = req.body?.cards;
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 8) return res.status(400).json({ ok: false, error: 'Expected 1-8 cards' });
  try {
    const r = await http.post('/api/scan-scene', { cards }, { headers: { 'X-Scene-Protocol': '3' } });
    if (r.status !== 200 || !r.data?.ok) return res.status(r.status === 200 ? 422 : r.status).json(r.data);
    const results = await Promise.all((r.data.results || []).map(hydrate));
    res.json({ ok: true, results, timings: r.data.timings });
    http.post('/api/scene-complete', {}).catch(() => {});
  } catch (e) { upstreamError(res, e); }
});

module.exports = router;
