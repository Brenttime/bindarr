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
