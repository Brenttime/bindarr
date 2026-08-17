/*
 * Rebuild the BoVW recall index for one game+language from an ORB rollup that is
 * already on disk. No downloads, no provider calls — the descriptors it quantizes
 * were written by the set walk.
 *
 * This is the operator's escape hatch: the normal path builds recall as part of
 * a global build, but an install whose rollup is fine and whose recall index is
 * missing or stale should not have to walk ~460 sets again to get one.
 *
 * Usage:
 *   node scripts/build-bovw-index.mjs --game mtg
 *   node scripts/build-bovw-index.mjs --game pokemon --lang ja
 *   node scripts/build-bovw-index.mjs --game mtg --k 16 --depth 4
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const game = arg('--game', 'mtg');
const lang = arg('--lang', 'en');
const k = parseInt(arg('--k', '16'), 10);
const depth = parseInt(arg('--depth', '4'), 10);

console.log(`Building BoVW index for ${game} (${lang})... K=${k}, depth=${depth}`);
const started = Date.now();

// CJS, and it reads INDEX_DATA_DIR at require time — so it must come after dotenv.
const { buildBovw } = require('../src/buildBovw.js');

buildBovw({
  game,
  lang,
  k,
  depth,
  onProgress: (i, total) => {
    if (i % 5000 === 0 || i === total) console.log(`  ${i}/${total}...`);
  },
}).then(({ outPath, totalCards, numLeaves }) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nSuccessfully built BoVW index: ${totalCards} cards across ${numLeaves} visual words in ${elapsed}s -> ${outPath}`);
  process.exit(0);
}).catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
