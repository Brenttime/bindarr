// Pure helpers for FastScanner (unit-tested in fastScan.test.js).

// Frame upload ceiling. Measured on the cardscan fixtures: 1920px matches as
// well as 2560px (the sidecar warps each card from the full frame it
// receives) with smaller uploads and faster detection.
export const FRAME_MAX = 1920;

// Map frame coordinates onto an element showing it with object-fit.
export function fitContain(frame, W, H, mode = 'contain') {
  const s = mode === 'cover'
    ? Math.max(W / frame.width, H / frame.height)
    : Math.min(W / frame.width, H / frame.height);
  return { s, ox: (W - frame.width * s) / 2, oy: (H - frame.height * s) / 2 };
}

// Candidate outline in element coordinates (quad when known, else box).
export function quadPath(cand, { s, ox, oy }) {
  const pts = cand.quad?.length === 4
    ? cand.quad
    : (() => { const [x, y, w, h] = cand.box; return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; })();
  return pts.map(([x, y]) => [ox + x * s, oy + y * s]);
}

// Pure: should this on-device outcome go to the server instead? Unit-tested.
//   - pipeline error / worker failure: yes.
//   - a still, in-frame card the client read but could not prove: yes, the
//     server's wider sweeps and multi-card detection may.
//   - shutter press with no usable card: yes (maybe several cards, which the
//     single-card detector does not handle).
//   - auto pass with no card, or a moving/clipped/blurred one: no — that is
//     the stillness gate doing its job; the next pass retries.
export function needsServer(out, { autoPass }) {
  if (!out || out.error) return true;
  const cand = out.candidates?.[0];
  const res = out.results?.[0];
  if (res) return !res.ok;
  if (!cand || !cand.eligible) return !autoPass;
  return true;
}

// Small-card rescue. Measured on saved scans: a card whose short side is
// under ~350 px in the uploaded frame almost never reads (title or collector
// line), and upscaling that frame rescues nothing — the detail is not there.
// The camera's NATIVE frame usually has 1.3-2x more pixels than the 1920
// upload, so a crop around the small card, taken from the native video,
// carries real extra detail. zoomPlan picks those crops; cards still too small
// even natively get a "move closer" hint instead of a silent failure.
export const SMALL_CARD_PX = 350;     // below this (upload px) reads fail
export const ZOOM_TARGET_PX = 620;    // crop is scaled so the card is ~this
export const ZOOM_MIN_GAIN = 1.25;    // native must add at least this much
export const ZOOM_MARGIN = 0.3;

export function zoomPlan({ candidates = [], results = [], frame, sw, sh, max = 3 }) {
  const byNum = new Map(results.map(r => [r.number ?? r.scene_number, r]));
  const k = frame?.width ? sw / frame.width : 1;      // upload px -> native px
  const crops = [];
  const tooSmall = [];
  for (const c of candidates) {
    if (!c.eligible || !c.box) continue;
    const r = byNum.get(c.number);
    if (r?.ok) continue;
    const [x, y, w, h] = c.box;
    const short = Math.min(w, h);
    if (short >= SMALL_CARD_PX) continue;
    const nativeShort = short * k;
    if (k < ZOOM_MIN_GAIN || nativeShort < SMALL_CARD_PX * 0.8) { tooSmall.push(c.number); continue; }
    if (crops.length >= max) continue;
    const mx = w * ZOOM_MARGIN, my = h * ZOOM_MARGIN;
    const x0 = Math.max(0, (x - mx) * k), y0 = Math.max(0, (y - my) * k);
    const x1 = Math.min(sw, (x + w + mx) * k), y1 = Math.min(sh, (y + h + my) * k);
    const scale = Math.min(1, ZOOM_TARGET_PX / nativeShort);   // never upscale
    crops.push({ number: c.number, sx: Math.round(x0), sy: Math.round(y0), sw: Math.round(x1 - x0), sh: Math.round(y1 - y0), scale });
  }
  return { crops, tooSmall };
}
