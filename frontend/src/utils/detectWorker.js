// Card detection, off the main thread.
//
// Detection is ~80ms on a desktop and ~300ms on a phone. Run inline that is a
// third of a second per frame where the page cannot render, handle a tap or
// animate — which is exactly what "the camera freezes the rest of the app" was.
// It also means the garbage this produces is collected on a thread that is not
// trying to paint, so a long-running preview stops degrading.
//
// The pixel buffer is TRANSFERRED rather than copied in both directions: a
// 256x360 RGBA frame is ~370KB, and copying that several times a second is the
// kind of waste that is invisible until it is not.
import { createDetector } from '../../../shared/cardDetectPure.mjs';
import { sharpness } from './sharpness.js';

const detector = createDetector();

self.onmessage = (e) => {
  const { buf, w, h, seq } = e.data;
  const rgba = new Uint8ClampedArray(buf);
  let result;
  try {
    const card = detector.detectCard(rgba, w, h);
    result = card
      ? {
        seq,
        detected: true,
        quad: card.quad.map((p) => ({ x: p.x / w, y: p.y / h })),
        pick: card.pick,
        // Computed here, where the pixels already are — sending them back for
        // the main thread to score would undo the point of the transfer.
        sharp: sharpness(rgba, w, h),
      }
      : { seq, detected: false };
  } catch (err) {
    result = { seq, detected: false, error: err?.message || 'detect failed' };
  }
  // Hand the buffer back so the caller can reuse it instead of allocating a new
  // one per frame.
  self.postMessage({ ...result, buf: rgba.buffer }, [rgba.buffer]);
};
