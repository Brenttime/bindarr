/*
 * Measure how well a built global index actually identifies cards.
 *
 * This exists because the global scan has a recall bottleneck that is invisible
 * from the outside: `RECALL_K = 250` candidates out of ~110k printings is a 0.2%
 * window, and if the shortlist misses the true card then ORB never gets a chance
 * and the answer is simply wrong. Without a measurement, every change to the
 * recall backend, to preprocessing, or to RECALL_K is a guess.
 *
 * What it reports, over a random sample of indexed cards:
 *   recall@1 / @5 / @K  — did the recall stage put the right card in its shortlist?
 *   verified top-1      — did the full pipeline (recall + ORB verify) answer with
 *                         the right card?
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
 * Knobs that exist to answer a specific question rather than to be tuned:
 *   --recall-k    how many candidates reach ORB. The rank profile below says how
 *                 deep it actually needs to be.
 *   --degrade-w   how many pixels wide the card survives at, in --noisy mode.
 *                 Measured 250px -> 76.0% exact, 420px -> 91.0%, 800px -> 90.0%:
 *                 steep below ~420 and flat above it.
 *
 * Usage:
 *   node scripts/eval-global-index.mjs --game mtg --sample 200
 *   node scripts/eval-global-index.mjs --game pokemon --sample 100 --noisy
 *   node scripts/eval-global-index.mjs --game mtg --sample 100 --compare  (both modes)
 *
 * Baseline, MTG / 100 cards / noisy / seed 20260812, hash recall alone:
 * exact printing 90.0%, right card 97.0%. The BoVW+hash pipeline this replaced
 * scored 91.0% / 98.0% on the identical sample, and BoVW alone 84.0% / 93.0% —
 * which is why BoVW is gone. Before that, CLIP recall scored 63.0% / 89.0%.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { makeHttp, gatherMtg, gatherPokemon } from './cardSources.js';

const require = createRequire(import.meta.url);
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
// --degrade-w sets how many pixels wide the card survives at. It is the one knob
// that answers "does capture resolution matter": a real capture puts a ~250px
// card inside a 407px frame, where this harness's default 420 IS the card.
async function degrade(buf, rnd) {
  const angle = (rnd() - 0.5) * 4;                 // ±2°, like a card not quite square
  const brightness = 0.9 + rnd() * 0.25;           // dimmer or brighter room
  return sharp(buf)
    .rotate(angle, { background: { r: 20, g: 20, b: 20 } })
    .resize({ width: parseInt(arg('--degrade-w', '420'), 10) })
    .modulate({ brightness })
    .jpeg({ quality: 72 })                         // camera JPEG artefacts
    .toBuffer();
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

async function run({ game, lang, sample, seed, noisy, topK, scanMatch, recallOf, cards, byKey }) {
  const rnd = mulberry32(seed);
  const http = makeHttp();
  const recallK = parseInt(arg('--recall-k', '250'), 10);

  // `v1` is exact-printing correctness; `vn1` ignores set/number. The gap between
  // them is printings of the SAME artwork — ktk/84 answered as plst/KTK-84 — which
  // scores as a failure but is not one a user would call wrong, and often is not
  // decidable from the art at all. Tracking only the strict number makes a recall
  // backend look far worse than it is.
  const stats = { n: 0, r1: 0, r5: 0, rk: 0, v1: 0, vn1: 0, skipped: 0, ms: 0 };
  // Where in the shortlist the true card actually landed. recall@K alone cannot
  // answer "how deep does K need to be" — a 250-deep list whose hits all sit in
  // the first 40 is 210 wasted ORB verifications per scan.
  const ranks = [];
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
      // The recall stage on its own, so a recall miss is distinguishable from a
      // verify miss — they need completely different fixes.
      const recall = await recallOf(img, recallK);
      const at = recall.findIndex(same);
      if (at === 0) stats.r1++;
      if (at >= 0 && at < 5) stats.r5++;
      if (at >= 0) { stats.rk++; ranks.push(at); }

      // Then the full pipeline, including card detection and ORB verification.
      // Positional args matter here: match(image, game, topK, setCode, opts). An
      // earlier version passed (img, game, null, topK, opts), which made topK null,
      // so `candidates.slice(0, null)` came back empty and verified top-1 read 0.0%
      // on every run ever made with this script.
      const res = await scanMatch.match(img, game, topK, '', { lang, recallK });
      const got = res.candidates?.[0];
      if (same(got)) stats.v1++;
      if (got && got.name === want[0]) stats.vn1++;
      if (!same(got)) misses.push({ want: `${want[0]} [${want[1]}/${want[2]}]`, got: got ? `${got.name} [${got.set}/${got.number}]` : 'nothing', recallAt: at, nameOnly: !!got && got.name === want[0] });
    } catch (e) {
      misses.push({ want: `${want[0]} [${want[1]}/${want[2]}]`, got: `error: ${e.message}`, recallAt: -1 });
    }
    stats.ms += Date.now() - t0;
    stats.n++;
    if (stats.n % 25 === 0) console.log(`  ${stats.n}/${sample}...`);
  }
  return { stats, misses, ranks };
}

// The recall stage on its own, as a function of (image, k). It is given the same
// preprocessing the real scan applies rather than the raw photo — the crop is
// what the hash is taken of, so measuring it any other way measures a pipeline
// that does not exist.
function recallStage({ game, lang, scanMatch, setIndex }) {
  return async (img, k) => {
    const buf = await scanMatch.preprocessCard(img);
    const qHash = await setIndex.dhash(buf);
    return scanMatch._hashRecallForTest(scanMatch._loadOrbDbForTest(game, lang), qHash, k);
  };
}

async function main() {
  const game = arg('--game', 'mtg');
  if (game !== 'mtg' && game !== 'pokemon') { console.error('Use --game mtg|pokemon'); process.exit(1); }
  const lang = arg('--lang', 'en');
  const sample = parseInt(arg('--sample', '100'), 10);
  const seed = parseInt(arg('--seed', '20260812'), 10);
  const topK = parseInt(arg('--top-k', '8'), 10);

  // These are CJS and read INDEX_DATA_DIR at require time.
  const { default: scanMatch } = await import('../src/scanMatch.js');
  const { default: setIndex } = await import('../src/setIndex.js');
  const { default: gpaths } = await import('../src/utils/globalIndexPaths.js');

  // Sample from the ORB rollup: it is the index that names the printing, it holds
  // every printing rather than one per artwork, and its meta is also what recall
  // sweeps now that the hash columns are the whole recall stage.
  const orbMeta = gpaths.orb(game, lang).meta;
  if (!fs.existsSync(orbMeta)) {
    console.error(`No ORB rollup for ${game} (${lang}) at ${orbMeta}. Build it first.`);
    process.exit(1);
  }
  const cards = JSON.parse(fs.readFileSync(orbMeta)).cards;
  if (!cards.length || cards[0].length < 7) {
    console.error(`The ${game} (${lang}) rollup carries no perceptual-hash columns, so it has no recall stage. Refresh it.`);
    process.exit(1);
  }
  console.log(`Index: ${cards.length} printings`);

  // The index stores only [name, set, number]; the image URLs come back from the
  // same source the build used. Scryfall's unique_artwork holds one printing per
  // artwork, so reprints sampled from the ORB rollup have no URL here and are
  // skipped — which means this harness never exercises the rollup's coverage of
  // those reprints, only of the printings Scryfall picked as canonical.
  console.log('Resolving card image URLs...');
  const list = game === 'pokemon' ? await gatherPokemon(makeHttp(), 100, 0) : await gatherMtg(makeHttp());
  const byKey = new Map(list.map(c => [`${c.set}|${c.number}|${c.name}`, c]));

  const modes = hasFlag('--compare') ? [false, true] : [hasFlag('--noisy')];
  const recallOf = recallStage({ game, lang, scanMatch, setIndex });
  const results = [];
  for (const noisy of modes) {
    console.log(`\n--- ${noisy ? 'NOISY (camera-like)' : 'CLEAN (reference image)'} · sample ${sample} · seed ${seed} ---`);
    const { stats, misses, ranks } = await run({ game, lang, sample, seed, noisy, topK, scanMatch, recallOf, cards, byKey });
    results.push({ noisy, stats });

    console.log(`  evaluated ${stats.n} cards (${stats.skipped} skipped: no image URL)`);
    console.log(`  recall@1        ${pct(stats.r1, stats.n)}`);
    console.log(`  recall@5        ${pct(stats.r5, stats.n)}`);
    console.log(`  recall@K        ${pct(stats.rk, stats.n)}   <- above this, ORB never sees the right card`);
    console.log(`  verified top-1  ${pct(stats.v1, stats.n)}   <- exact printing`);
    console.log(`  right card      ${pct(stats.vn1, stats.n)}   <- name correct, printing may differ`);
    console.log(`  mean latency    ${stats.n ? Math.round(stats.ms / stats.n) : 0} ms/scan`);

    // Cumulative recall at each cut-off, so RECALL_K can be chosen from data
    // rather than guessed: the smallest cut whose recall matches recall@K is the
    // depth that costs nothing to keep, and everything past it is wasted verify.
    if (ranks.length) {
      const cuts = [1, 5, 10, 20, 40, 60, 100, 150, 250].filter(c => c <= parseInt(arg('--recall-k', '250'), 10));
      console.log(`  rank profile    ${cuts.map(c => `@${c}:${pct(ranks.filter(r => r < c).length, stats.n)}`).join('  ')}`);
    }

    if (!noisy && stats.n && stats.r1 / stats.n < 0.98) {
      console.warn('  WARNING: clean reference images should rank first almost always.');
      console.warn('  A low clean recall@1 means the build and the query disagree about preprocessing.');
    }
    if (misses.length) {
      console.log(`  first misses:`);
      for (const m of misses.slice(0, 8)) {
        console.log(`    want ${m.want} -> got ${m.got}${m.nameOnly ? ' [same card, other printing]' : ''} (recall rank ${m.recallAt < 0 ? 'not in shortlist' : m.recallAt})`);
      }
    }
  }

  if (results.length === 2) {
    const [clean, noisyR] = results;
    const drop = (a, b) => `${((a / clean.stats.n - b / noisyR.stats.n) * 100).toFixed(1)} pts`;
    console.log('\n--- clean vs noisy ---');
    console.log(`  recall@K drop       ${drop(clean.stats.rk, noisyR.stats.rk)}`);
    console.log(`  verified top-1 drop ${drop(clean.stats.v1, noisyR.stats.v1)}`);
  }
}

// Exit explicitly. opencv-wasm and the scan worker pool keep handles (and the
// event loop) alive after main() resolves, so the process lingered holding the
// global index files open — which on Windows makes the next rollup swap fail
// with EPERM, long after the run appeared to finish.
main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e.stack || e.message); process.exit(1); });
