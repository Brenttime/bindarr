// On-device card reading for Scan Cards, off the main thread.
//
// Runs shared/clientScan/pipeline.mjs, the same module the Node replay harness
// (backend/scripts/client-scan-replay.mjs) validates against saved phone
// frames. Models and the title/printing index are fetched once from
// /scan-assets/ (content-hashed names, served immutable) and kept in the Cache
// API, so a returning phone starts reading without touching the network.
//
// Same ORT entry point and settings as detectWorker, for the reasons spelled
// out there: CPU wasm EP only (no jsep/webgpu binaries), one thread (no
// COOP/COEP on an arbitrary self-hosted proxy).
import * as ort from 'onnxruntime-web/wasm';
import { createReader } from '../../../shared/clientScan/pipeline.mjs';
import { buildCharset, loadIndex } from '../../../shared/clientScan/text.mjs';

ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;

const BASE = '/scan-assets/';
const CACHE = 'scrybox-scan-assets';
let readerPromise = null;

async function cachedBytes(cache, url) {
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    res = await fetch(url);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('text/html')) throw new Error(`${url} not served (${res.status})`);
    if (cache) await cache.put(url, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function gunzip(bytes) {
  // Served as a .gz file (not Content-Encoding), so decompress here.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function load() {
  const t0 = performance.now();
  const manifest = await (await fetch(`${BASE}manifest.json`, { cache: 'no-cache' })).json();
  const urls = [manifest.index, manifest.rec, manifest.dict].map(n => BASE + n);
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE).catch(() => null) : null;
  if (cache) {
    // Drop assets a newer manifest no longer names.
    for (const req of await cache.keys()) {
      if (!urls.includes(new URL(req.url).pathname)) cache.delete(req);
    }
  }
  const [indexGz, recBytes, dictBytes, cornBytes] = await Promise.all([
    cachedBytes(cache, urls[0]), cachedBytes(cache, urls[1]), cachedBytes(cache, urls[2]),
    cachedBytes(null, '/models/cornelius.onnx'),      // HTTP-cached by detectWorker's route
  ]);
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [rec, cornelius] = await Promise.all([
    ort.InferenceSession.create(recBytes, opts),
    ort.InferenceSession.create(cornBytes, opts),
  ]);
  const index = loadIndex(JSON.parse(await gunzip(indexGz)));
  const chars = buildCharset(new TextDecoder().decode(dictBytes));
  const reader = createReader({ ort, cornelius, rec, chars, index });
  return { reader, loadMs: Math.round(performance.now() - t0) };
}

self.onmessage = async (e) => {
  const { type, id } = e.data;
  if (type === 'load') {
    readerPromise ||= load();
    try {
      const { loadMs } = await readerPromise;
      self.postMessage({ id, ready: true, loadMs });
    } catch (err) {
      readerPromise = null;
      self.postMessage({ id, ready: false, error: err?.message || String(err) });
    }
    return;
  }
  if (type === 'read') {
    const { frame, w, h, small, requireStill } = e.data;
    try {
      const { reader } = await readerPromise;
      const out = await reader.read(
        { data: new Uint8ClampedArray(frame), width: w, height: h },
        new Uint8ClampedArray(small), { smallChannels: 4, requireStill });
      self.postMessage({ id, out, frame, small }, [frame, small]);
    } catch (err) {
      self.postMessage({ id, error: err?.message || String(err), frame, small }, [frame, small]);
    }
  }
};
