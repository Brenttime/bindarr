// Main-thread side of on-device Scan Cards (see clientScanWorker.js).
//
// One worker, one frame in flight. The frame is grabbed at the SAME ceiling the
// server path uploads (FRAME_MAX), because that is the resolution the pipeline
// was validated at against saved phone frames; the 384x384 copy for cornelius
// is scaled by the canvas (GPU) rather than in JS.
import { FRAME_MAX } from './fastScan';
export { needsServer } from './fastScan';
import { CORN_SIZE } from '../../../shared/clientScan/pipeline.mjs';

let worker = null;
let ready = null;          // Promise<{ok, loadMs, error}>
let nextId = 1;
const waiting = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./clientScanWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const cb = waiting.get(e.data.id);
    if (cb) { waiting.delete(e.data.id); cb(e.data); }
  };
  worker.onerror = (e) => {
    for (const cb of waiting.values()) cb({ error: e?.message || 'scan worker failed' });
    waiting.clear();
  };
  return worker;
}

function call(msg, transfer = []) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    ensureWorker().postMessage({ ...msg, id }, transfer);
  });
}

// Start the one-time download. Resolves {ok:false} rather than throwing: a
// phone that cannot run it simply keeps the server scanner.
export function loadClientScan() {
  if (!ready) {
    const supported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'
      && typeof DecompressionStream !== 'undefined';
    ready = !supported
      ? Promise.resolve({ ok: false, error: 'unsupported browser' })
      : call({ type: 'load' }).then(r => ({ ok: !!r.ready, loadMs: r.loadMs, error: r.error }));
  }
  return ready;
}

let frameCanvas = null, smallCanvas = null;
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// Read one frame on-device. Returns the pipeline's server-shaped output
// ({frame, candidates, results:[{ok, scryfallId, ...}]}), or {error}.
export async function readOnDevice(source, sw, sh, { requireStill = false } = {}) {
  const k = Math.min(1, FRAME_MAX / Math.max(sw, sh));
  const w = Math.round(sw * k), h = Math.round(sh * k);
  if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) frameCanvas = canvas(w, h);
  if (!smallCanvas) smallCanvas = canvas(CORN_SIZE, CORN_SIZE);
  const fc = ctx2d(frameCanvas); fc.drawImage(source, 0, 0, w, h);
  const sc = ctx2d(smallCanvas); sc.drawImage(source, 0, 0, CORN_SIZE, CORN_SIZE);
  const frame = fc.getImageData(0, 0, w, h).data.buffer;
  const small = sc.getImageData(0, 0, CORN_SIZE, CORN_SIZE).data.buffer;
  const r = await call({ type: 'read', frame, small, w, h, requireStill }, [frame, small]);
  return r.error ? { error: r.error } : r.out;
}

// Server fallback wants a JPEG of the same frame the client just looked at.
export function lastFrameJpeg() {
  if (!frameCanvas) return null;
  if (frameCanvas.convertToBlob) return frameCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return new Promise((res, rej) => frameCanvas.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.88));
}

// Turn on-device answers into card_cache rows (prices, image, set) via the
// backend, so the tray and Send flow see exactly what a server scan returns.
const hydrated = new Map();   // scryfallId -> hydrated result (auto passes re-see cards)
export async function hydrateResults(results) {
  results = results.map(x => (x.ok && hydrated.has(x.scryfallId) ? { ...x, ...hydrated.get(x.scryfallId), number: x.number } : x));
  const hits = results.filter(r => r.ok && r.scryfallId && !r.card);
  if (!hits.length) return results;
  const r = await fetch('/api/cardscan/cards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: hits.map(h => ({ number: h.number, scryfallId: h.scryfallId, title: h.title, via: h.via })) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || 'hydrate failed');
  const byNumber = new Map(j.results.map(x => [x.number, x]));
  for (const h of hits) { const x = byNumber.get(h.number); if (x?.ok && x.card) hydrated.set(h.scryfallId, x); }
  return results.map(x => (x.ok && byNumber.has(x.number) ? { ...x, ...byNumber.get(x.number) } : x));
}
