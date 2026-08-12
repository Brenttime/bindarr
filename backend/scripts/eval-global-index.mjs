/*
 * Measure how well a built global index actually identifies cards.
 *
 * This exists because the global scan has a recall bottleneck that is invisible
 * from the outside: `RECALL_K = 250` candidates out of ~74k cards is a 0.34%
 * window, and if CLIP's shortlist misses the true card then ORB never gets a
 * chance and the answer is simply wrong. Without a measurement, every change to
 * preprocessing, to the model, or to RECALL_K is a guess.
 *
 * What it reports, over a random sample of indexed cards:
 *   recall@1 / @5 / @K  — did the CLIP stage put the right card in its shortlist?
 *   verified top-1      — did the full pipeline (CLIP recall + ORB verify) answer
 *                         with the right card?
 *   timing              — mean ms per scan, so an accuracy gain that costs three
 *                         times the latency is visible as such.
 *
 * Two modes:
 *   --clean   embed the card's own reference image (upper bound; catches a
 *             build/query preprocessing mismatch immediately — a clean image that
 *             does not rank first means the two sides disagree).
 *   --noisy   apply mild camera-like degradation (resize, JPEG, slight rotation,
 *             brightness) before matching. Closer to a real scan and the number
 *             worth tracking across changes.
 *
 * Usage:
 *   node scripts/eval-global-index.mjs --game mtg --sample 200
 *   node scripts/eval-global-index.mjs --game pokemon --sample 100 --noisy
 *   node scripts/eval-global-index.mjs --game mtg --sample 100 --compare  (both modes)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { makeHttp, gatherMtg, gatherPokemon } from './cardSources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const hasFlag = (f) => process.argv.includes(f);

// Deterministic PRNG so two runs sample the same cards and the numbers are
// comparable. Math.random() would make every comparison noise.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mild, camera-like degradation. Deliberately gentle: the point is to measure the
// index, not to prove that a badly mangled image fails to match.
async function degrade(buf, rnd) {
  const angle = (rnd() - 0.5) * 4;                 // ±2°, like a card not quite square
  const brightness = 0.9 + rnd() * 0.25;           // dimmer or brighter room
  return sharp(buf)
    .rotate(angle, { background: { r: 20, g: 20, b: 20 } })
    .resize({ width: 420 })                        // phone capture, then upscaled by the pipeline
    .modulate({ brightness })
    .jpeg({ quality: 72 })                         // camera JPEG artefacts
    .toBuffer();
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

async function run({ game, lang, sample, seed, noisy, topK, scanMatch, embedMatch, cards, byKey }) {
  const rnd = mulberry32(seed);
  const http = makeHttp();
  const recallK = parseInt(arg('--recall-k', '250'), 10);

  const stats = { n: 0, r1: 0, r5: 0, rk: 0, v1: 0, skipped: 0, ms: 0 };
  const picked = new Set();
  const misses = [];

  while (stats.n < sample && picked.size < cards.length) {
    const i = Math.floor(rnd() * cards.length);
    if (picked.has(i)) continue;
    picked.add(i);
    const want = cards[i];                          // [name, set, number]
    const src = byKey.get(`${want[1]}|${want[2]}|${want[0]}`);
    if (!src) { stats.skipped++; continue; }

    let img;
    try {
      img = Buffer.from((await http.get(src.img, { responseType: 'arraybuffer', timeout: 30000 })).data);
      if (noisy) img = await degrade(img, rnd);
    } catch { stats.skipped++; continue; }

    const same = (c) => c && c.name === want[0] && c.set === want[1] && c.number === want[2];
    const t0 = Date.now();
    try {
      // CLIP stage on its own, so a recall miss is distinguishable from a verify
      // miss — they need completely different fixes.
      const recall = await embedMatch.match(img, game, recallK, lang);
      const at = recall.findIndex(same);
      if (at === 0) stats.r1++;
      if (at >= 0 && at < 5) stats.r5++;
      if (at >= 0) stats.rk++;

      // Then the full pipeline, including card detection and ORB verification.
      const res = await scanMatch.match(img, game, null, topK, { lang, recallK });
      if (same(res.candidates?.[0])) stats.v1++;
      else misses.push({ want: `${want[0]} [${want[1]}/${want[2]}]`, got: res.candidates?.[0] ? `${res.candidates[0].name} [${res.candidates[0].set}/${res.candidates[0].number}]` : 'nothing', recallAt: at });
    } catch (e) {
      misses.push({ want: `${want[0]} [${want[1]}/${want[2]}]`, got: `error: ${e.message}`, recallAt: -1 });
    }
    stats.ms += Date.now() - t0;
    stats.n++;
    if (stats.n % 25 === 0) console.log(`  ${stats.n}/${sample}...`);
  }
  return { stats, misses };
}

async function main() {
  const game = arg('--game', 'mtg');
  if (game !== 'mtg' && game !== 'pokemon') { console.error('Use --game mtg|pokemon'); process.exit(1); }
  const lang = arg('--lang', 'en');
  const sample = parseInt(arg('--sample', '100'), 10);
  const seed = parseInt(arg('--seed', '20260812'), 10);
  const topK = parseInt(arg('--top-k', '8'), 10);

  // These are CJS and read INDEX_DATA_DIR at require time.
  const { default: embedMatch } = await import('../src/embedMatch.js');
  const { default: scanMatch } = await import('../src/scanMatch.js');
  const { default: gpaths } = await import('../src/utils/globalIndexPaths.js');

  const { meta: metaPath } = gpaths.embed(game, lang);
  if (!fs.existsSync(metaPath)) {
    console.error(`No global index for ${game} (${lang}) at ${metaPath}. Build it first.`);
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const orbBuilt = fs.existsSync(gpaths.orb(game, lang).meta);
  console.log(`Index: ${meta.cards.length} cards, dim ${meta.dim}, model ${meta.model}`);
  console.log(`       preprocess ${meta.preprocess || '(unstamped)'}, ORB ${orbBuilt ? 'built' : 'MISSING (CLIP-only ranking)'}`);

  // The index stores only [name, set, number]; the image URLs come back from the
  // same source the build used.
  console.log('Resolving card image URLs...');
  const list = game === 'pokemon' ? await gatherPokemon(makeHttp(), 100, 0) : await gatherMtg(makeHttp());
  const byKey = new Map(list.map(c => [`${c.set}|${c.number}|${c.name}`, c]));

  const modes = hasFlag('--compare') ? [false, true] : [hasFlag('--noisy')];
  const results = [];
  for (const noisy of modes) {
    console.log(`\n--- ${noisy ? 'NOISY (camera-like)' : 'CLEAN (reference image)'} · sample ${sample} · seed ${seed} ---`);
    const { stats, misses } = await run({ game, lang, sample, seed, noisy, topK, scanMatch, embedMatch, cards: meta.cards, byKey });
    results.push({ noisy, stats, misses });

    console.log(`  evaluated ${stats.n} cards (${stats.skipped} skipped: no image URL)`);
    console.log(`  CLIP recall@1   ${pct(stats.r1, stats.n)}`);
    console.log(`  CLIP recall@5   ${pct(stats.r5, stats.n)}`);
    console.log(`  CLIP recall@K   ${pct(stats.rk, stats.n)}   <- above this, ORB never sees the right card`);
    console.log(`  verified top-1  ${pct(stats.v1, stats.n)}   <- what a user actually experiences`);
    console.log(`  mean latency    ${stats.n ? Math.round(stats.ms / stats.n) : 0} ms/scan`);

    if (!noisy && stats.n && stats.r1 / stats.n < 0.98) {
      console.warn('  WARNING: clean reference images should rank first almost always.');
      console.warn('  A low clean recall@1 means the build and query preprocessing disagree —');
      console.warn(`  check that the index's preprocess stamp matches src/utils/clipPreprocess.js.`);
    }
    if (misses.length) {
      console.log(`  first misses:`);
      for (const m of misses.slice(0, 8)) {
        console.log(`    want ${m.want} -> got ${m.got} (CLIP rank ${m.recallAt < 0 ? 'not in shortlist' : m.recallAt})`);
      }
    }
  }

  if (results.length === 2) {
    const [clean, noisyR] = results;
    const drop = (a, b) => `${((a / clean.stats.n - b / noisyR.stats.n) * 100).toFixed(1)} pts`;
    console.log('\n--- clean vs noisy ---');
    console.log(`  recall@K drop      ${drop(clean.stats.rk, noisyR.stats.rk)}`);
    console.log(`  verified top-1 drop ${drop(clean.stats.v1, noisyR.stats.v1)}`);
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
