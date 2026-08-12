// Worker thread: verifies one slice of a set's cards against the query ORB
// features. Loads its own opencv-wasm + set index (cached per worker). The heavy
// per-card knnMatch + homography runs here, off the main event loop and across
// cores. See scanPool.js for the dispatcher.
const { parentPort } = require('worker_threads');
const setIndex = require('./setIndex');

parentPort.on('message', (msg) => {
  // Global (code-free) verification. The main thread has already resolved each
  // candidate to its byte ranges, so the worker needs only the two file paths —
  // not a second copy of the ~110k-entry offset map, which across four workers
  // would cost hundreds of MB for no benefit.
  if (msg.type === 'closeGlobal') {
    try { require('./globalVerify').closeAll(); parentPort.postMessage({ id: msg.id, out: true }); }
    catch (e) { parentPort.postMessage({ id: msg.id, error: e.message || String(e) }); }
    return;
  }
  if (msg.type === 'verifyGlobal') {
    const { id, descPath, kpPath, qDesc, qRows, qKp, slices } = msg;
    try {
      const scored = require('./globalVerify').verifySlices(descPath, kpPath, qDesc, qRows, qKp, slices);
      parentPort.postMessage({ id, out: scored });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'extract') {
    const { id, rgba, width, height } = msg;
    try {
      const out = setIndex.extractCard(rgba, width, height);
      parentPort.postMessage({ id, out });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message || String(e) });
    }
    return;
  }
  const { id, game, set, lang, qDesc, qRows, qKp, indices } = msg;
  try {
    const scored = setIndex.verifySlice(game, set, qDesc, qRows, qKp, indices, lang);
    parentPort.postMessage({ id, scored });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message || String(e) });
  }
});
