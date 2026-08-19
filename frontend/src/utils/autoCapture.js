// When auto-scan takes the picture.
//
// The rule is ONE SCAN PER CARD PRESENTED, not a scan every N milliseconds.
// Interval capture rescanned a card that was simply sitting there while the user
// reached for the next one, and made a card placed just after a tick wait out the
// rest of the beat for nothing.
//
// So this is an edge trigger with an explicit armed/disarmed state:
//
//   armed --(steady, well-framed card)--> CAPTURE --> disarmed
//   disarmed --(frame empties, or a visibly different quad appears)--> armed
//
// Pure on purpose: the component owns the refs and the camera, this owns the
// decision, and the decision is the part worth testing.

// Consecutive empty frames before re-arming. At ~60ms per detection this is
// about a fifth of a second of clear mat — long enough that a hand crossing the
// frame is not mistaken for the card being taken away.
export const REARM_EMPTY_FRAMES = 3;
// How far the quad must move from the captured one to count as a different card.
// Well above the ~0.012 jitter of a card lying still.
export const REARM_DRIFT = 0.09;
// Floor between two captures, against a double fire while the first request is
// still being assembled. NOT a cadence: nothing fires just because it elapses.
export const MIN_RECAPTURE_MS = 600;

// WORST corner movement between two quads, in normalised units — deliberately not
// the mean that cardDetector.meanCornerDrift returns. One corner slipping off the
// card is a different card even when the other three sit still, and the mean
// divides that signal by four. REARM_DRIFT is tuned against this metric; the two
// are not interchangeable, which is why neither is called just "quadDrift" any
// more.
export function worstCornerDrift(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return Infinity;
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  }
  return worst;
}

// Should a disarmed scanner become ready again?
//
// `emptyFrames` counts consecutive no-card readings. `quad` is the current
// detection (null when there is none) and `capturedQuad` the one that was last
// photographed. Comparing against the CAPTURED quad rather than the previous
// frame matters: drift compared frame-to-frame never accumulates while a user
// holds a card still, so a slow hand would re-arm on the same card.
export function shouldRearm({ armed, emptyFrames, quad, capturedQuad }) {
  if (armed) return true;
  if (emptyFrames >= REARM_EMPTY_FRAMES) return true;
  if (!quad) return false;
  if (!capturedQuad) return true;
  return worstCornerDrift(capturedQuad, quad) > REARM_DRIFT;
}

// Should the shutter fire right now?
//
// `reading` is the latest detector result: { none, steady, fill, at }. A missing
// reading is NOT permission — the old code answered "yes" when it had no opinion,
// which was survivable only because the old contour detector always returned
// something. A detector that can say "there is no card" has to be believed.
export function shouldCapture({
  armed, busy, blocked, reading, now, lastCaptureAt,
  minSteady, minFill, staleMs = 1500,
}) {
  if (!armed || busy || blocked) return false;
  if (now - lastCaptureAt < MIN_RECAPTURE_MS) return false;
  if (!reading || reading.none) return false;
  if (now - reading.at > staleMs) return false;      // detection loop has stalled
  return reading.steady >= minSteady && reading.fill >= minFill;
}

// What auto-scan is waiting for, as a label key + severity. Derived from the same
// inputs as shouldCapture so the badge can never claim "Ready" while the trigger
// is declining, which is how a user ends up thinking the scanner is broken.
export function autoStatusKey({ armed, busy, blocked, reading, now, minSteady, minFill, staleMs = 1500 }) {
  if (busy) return 'scanning';
  if (blocked) return 'waiting';
  if (!armed) return 'lift';
  if (!reading || reading.none || now - reading.at > staleMs) return 'nocard';
  if (reading.fill < minFill) return 'closer';
  if (reading.steady < minSteady) return 'hold';
  return 'ready';
}
