// How in-focus a frame is: variance of the Laplacian, sampled coarsely.
//
// This is the measurement the scanner was missing. Blur is what separated a
// working capture session from a failing one — same camera, same framing, same
// card — and no amount of recall tuning rescues a smeared frame. With a number
// for it, auto-capture can wait for a sharp frame instead of taking whichever one
// the timer landed on.
//
// Every third pixel is plenty: this only ever ranks frames of the SAME scene
// against each other. It is not an absolute focus metric and should not be
// compared across scenes or resolutions.
//
// Lives in its own module because both the worker and the main thread use it, and
// a worker entry cannot export helpers to its host.
export function sharpness(rgba, w, h) {
  let sum = 0, sumSq = 0, n = 0;
  const luma = (p) => {
    const i = p * 4;
    return rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  };
  for (let y = 3; y < h - 3; y += 3) {
    for (let x = 3; x < w - 3; x += 3) {
      const p = y * w + x;
      const lap = 4 * luma(p) - luma(p - 1) - luma(p + 1) - luma(p - w) - luma(p + w);
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
