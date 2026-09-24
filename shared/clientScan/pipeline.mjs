// The in-browser card reader, end to end, for one camera frame:
//
//   cornelius corners -> portrait quad -> edge / blur / stillness gates
//   -> title strips -> recognizer -> fuzzy title -> unique printing?
//   -> staged footer strips (modern 0.90/0.92, retro copyright line,
//      then the lower and upper modern sweeps) -> exactly one printing, or fail.
//
// Environment-free: the caller injects onnxruntime (web in the worker, node in
// the replay harness), both sessions, the charset and the index, so the code
// that is validated offline is byte-for-byte the code that runs on the phone.
//
// Strip geometry, confidence floors and stage order are the cardscan sidecar's
// (_batch_scene_titles, _batch_scene_printings, _retro_footer_pass). One card
// per frame: cornelius predicts a single card. Multi-card scenes are the
// server's job; the caller falls back to it for anything this returns as
// unresolved.
import {
  REC_H, portraitQuad, padQuad, cardToFrame, sampleStrip, artSignature, cosine, titleSharpness,
} from './imaging.mjs';
import {
  ctcDecode, findCardByOcr, normName, uniqueTitlePrinting, uniqueOcrPrinting,
  footerNumbers, footerCodes, resolveFooter, retroNumber, strongNumbers, looksLikeCopyright,
} from './text.mjs';

export const CORN_SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const CORNER_GATE = 0.02;           // cornelius "sharpness" head: below = no card
const EDGE_FRAC = 0.01;             // server: touches frame edge within 1%
const TITLE_SHARP_FLOOR = 12;       // Laplacian variance of the sampled title band
const STILL_DRIFT = 0.012;          // mean corner move / frame diagonal
const REC_BATCH = 6;                // RapidOCR rec_batch_num
const TITLE_CONF = 0.60, FOOTER_CONF = 0.45, RETRO_CONF = 0.60;

const TITLE_FIRST = [[0.030, 0.82, 0.025, 0.100], [0.040, 0.80, 0.055, 0.120]];
const TITLE_TIGHT = [[0.045, 0.80, 0.045, 0.140], [0.050, 0.80, 0.090, 0.170], [0.010, 0.95, 0.000, 0.090]];
const FOOTER_STAGES = [[0.90, 0.92], 'retro', [0.88, 0.94, 0.86], [0.76, 0.78, 0.80, 0.82, 0.84]];
const RETRO_ROWS = [0.855, 0.845];

// Cornelius input: the frame squashed to 384x384 (fit: fill, like the server's
// cvScan), ImageNet-normalised, NCHW.
export function corneliusTensor(ort, rgb, channels = 3) {
  const plane = CORN_SIZE * CORN_SIZE;
  const t = new Float32Array(3 * plane);
  for (let i = 0, j = 0; i < plane; i++, j += channels) {
    t[i] = (rgb[j] / 255 - MEAN[0]) / STD[0];
    t[plane + i] = (rgb[j + 1] / 255 - MEAN[1]) / STD[1];
    t[2 * plane + i] = (rgb[j + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', t, [1, 3, CORN_SIZE, CORN_SIZE]);
}

// RapidOCR TextRecognizer: sort by aspect, batches of 6, each padded (zeros,
// i.e. mid-grey after normalisation) to the batch's widest ratio, min 320/48.
async function recognize(env, strips) {
  const out = new Array(strips.length);
  if (!strips.length) return out;
  const order = strips.map((s, i) => i).sort((a, b) => strips[a].w / strips[a].h - strips[b].w / strips[b].h);
  for (let b = 0; b < order.length; b += REC_BATCH) {
    const idx = order.slice(b, b + REC_BATCH);
    let maxRatio = 320 / REC_H;
    for (const i of idx) maxRatio = Math.max(maxRatio, strips[i].w / strips[i].h);
    const W = Math.trunc(REC_H * maxRatio);
    const plane = REC_H * W;
    const data = new Float32Array(idx.length * 3 * plane);
    idx.forEach((si, n) => {
      const s = strips[si];
      const rw = Math.min(W, s.w);
      // RapidOCR feeds BGR (the sidecar converts RGB->BGR before text_rec).
      for (let y = 0; y < REC_H; y++) {
        for (let x = 0; x < rw; x++) {
          const p = (y * s.w + x) * 3, o = n * 3 * plane + y * W + x;
          data[o] = s.data[p + 2] / 127.5 - 1;
          data[o + plane] = s.data[p + 1] / 127.5 - 1;
          data[o + 2 * plane] = s.data[p] / 127.5 - 1;
        }
      }
    });
    const res = await env.rec.run({ [env.rec.inputNames[0]]: new env.ort.Tensor('float32', data, [idx.length, 3, REC_H, W]) });
    const pred = res[env.rec.outputNames[0]];
    const [, steps, classes] = pred.dims;
    idx.forEach((si, n) => { out[si] = ctcDecode(pred.data, steps, classes, env.chars, n); });
    env.stats.recCalls++; env.stats.recStrips += idx.length;
  }
  return out;
}

export function createReader(env) {
  // env: { ort, cornelius, rec, chars, index }
  env.stats = { recCalls: 0, recStrips: 0 };
  let lastQuad = null;
  const cache = [];     // [{sig, result}] identity cache, like the sidecar's

  async function detect(small, channels, frameW, frameH) {
    const out = await env.cornelius.run({ image: corneliusTensor(env.ort, small, channels) });
    const c = out.corners.data;
    const conf = out.sharpness ? out.sharpness.data[0] : 1;
    if (!(conf > CORNER_GATE)) return null;
    const pts = [0, 1, 2, 3].map(i => ({ x: c[2 * i] * frameW, y: c[2 * i + 1] * frameH }));
    return portraitQuad(pts);
  }

  // One frame. `frame` = {data: RGBA, width, height}; `small` = 384x384 pixels
  // of the same frame (RGBA or RGB, `smallChannels`). Options:
  //   requireStill: auto mode — only read once the card has stopped moving.
  async function read(frame, small, { smallChannels = 4, requireStill = false } = {}) {
    const t0 = now();
    const { data: rgba, width: w, height: h } = frame;
    const timings = {};
    const quad = await detect(small, smallChannels, w, h);
    timings.detect_ms = Math.round(now() - t0);
    const base = { ok: true, engine: 'client', frame: { width: w, height: h }, candidates: [], results: [], timings };
    if (!quad) { lastQuad = null; return base; }
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const box = [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)),
      Math.round(Math.max(...xs) - Math.min(...xs)), Math.round(Math.max(...ys) - Math.min(...ys))];
    const cand = { number: 1, box, quad: quad.map(p => [p.x, p.y]), eligible: false, status: 'ready' };
    base.candidates.push(cand);

    const ex = Math.max(2, EDGE_FRAC * w), ey = Math.max(2, EDGE_FRAC * h);
    const clipped = xs.some(x => x <= ex || x >= w - ex) || ys.some(y => y <= ey || y >= h - ey);
    const diag = Math.hypot(w, h);
    const drift = lastQuad ? quad.reduce((s, p, i) => s + Math.hypot(p.x - lastQuad[i].x, p.y - lastQuad[i].y), 0) / 4 / diag : Infinity;
    lastQuad = quad;
    const m = cardToFrame(padQuad(quad));
    const sharp = titleSharpness(rgba, w, h, m);
    cand.sharpness = Math.round(sharp * 10) / 10;
    if (clipped) cand.status = 'touches frame edge';
    else if (sharp < TITLE_SHARP_FLOOR) cand.status = 'too blurry';
    else if (requireStill && drift > STILL_DRIFT) cand.status = 'moving';
    cand.eligible = cand.status === 'ready';
    if (!cand.eligible) return base;

    const sig = artSignature(rgba, w, h, m);
    const hit = cache.find(e => cosine(e.sig, sig) >= 0.97);
    if (hit) {
      base.results.push({ ...hit.result, number: 1, cached: true });
      timings.total_ms = Math.round(now() - t0);
      return base;
    }
    const result = await readCard(rgba, w, h, m, timings);
    timings.total_ms = Math.round(now() - t0);
    base.results.push(result);
    if (result.ok) { cache.push({ sig, result }); if (cache.length > 64) cache.shift(); }
    return base;
  }

  async function readCard(rgba, w, h, m, timings) {
    const tA = now();
    const strip = (r) => sampleStrip(rgba, w, h, m, r[0], r[1], r[2], r[3]);
    const cands = [];
    const consider = (reads) => {
      for (const r of reads) {
        if (!r.text || r.conf < TITLE_CONF) continue;
        const found = findCardByOcr(env.index, r.text);
        if (found.name) cands.push({ score: found.score, conf: r.conf, name: found.name, raw: r.text });
      }
    };
    consider(await recognize(env, TITLE_FIRST.map(strip)));
    if (!cands.length || Math.max(...cands.map(c => c.name.length)) < 12) {
      consider(await recognize(env, TITLE_TIGHT.map(strip)));
    }
    timings.title_ms = Math.round(now() - tA);
    const titleReads = cands.map(c => c.raw);
    if (!cands.length) {
      return { number: 1, ok: false, retry: true, error: 'no confident card title', title: null, ocr: titleReads };
    }
    cands.sort((a, b) => b.score - a.score || b.conf - a.conf || (a.name < b.name ? 1 : -1));
    const { name, raw, score } = cands[0];
    const ix = env.index;
    const done = (pi, via, footer) => {
      const p = ix.printings[pi];
      timings.footer_ms = Math.round(now() - tA) - timings.title_ms;
      return { number: 1, ok: true, scryfallId: p[0], set: p[1], num: p[2], title: name, title_score: score, via, footer_ocr: footer };
    };
    let pi = uniqueTitlePrinting(ix, name);
    if (pi != null) return done(pi, 'unique physical printing', []);
    pi = uniqueOcrPrinting(ix, raw, name);
    if (pi != null) return done(pi, 'unique printed title', []);

    const raws = [];
    for (const stage of FOOTER_STAGES) {
      if (stage === 'retro') {
        const reads = await recognize(env, RETRO_ROWS.map(y => strip([0.35, 0.95, y, y + 0.025])));
        const nums = [];
        for (const r of reads) {
          if (!r.text || r.conf < RETRO_CONF) continue;
          const n = looksLikeCopyright(r.text) ? retroNumber(r.text) : null;
          if (n && !nums.includes(n)) nums.push(n);
          raws.push(r.text);
        }
        if (nums.length) {
          pi = resolveFooter(ix, name, [], nums);
          if (pi != null) return done(pi, 'title+collector (retro frame)', raws);
        }
        continue;
      }
      const reads = await recognize(env, stage.map(y => strip([0, 0.22, y, y + 0.025])));
      for (const r of reads) if (r.text && r.conf >= FOOTER_CONF) raws.push(r.text);
      pi = resolveFooter(ix, name, footerCodes(ix, raws), footerNumbers(raws), strongNumbers(raws));
      if (pi != null) return done(pi, 'title+set+collector', raws);
    }
    timings.footer_ms = Math.round(now() - tA) - timings.title_ms;
    return { number: 1, ok: false, retry: true, error: 'exact printing not resolved', title: name, footer_ocr: raws };
  }

  return { read, stats: env.stats, reset() { lastQuad = null; cache.length = 0; } };
}

export { normName };

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
