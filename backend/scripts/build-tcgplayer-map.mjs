// One-off backfill: price every cached Pokémon set from TCGCSV and record its
// TCGplayer productId.
//
// The daily sweep in tcgcsvApi only visits sets the user owns cards from, which is
// right for a daily job — one request per set against somebody else's free mirror.
// This walks the whole cache instead, so search results and set browses show real
// prices too, and every Pokémon card gets a marketplace link that opens the card.
//
// Safe to re-run. It overwrites prices with fresher ones and re-derives the
// mapping; nothing is deleted.
//
// Usage, from backend/:
//   node scripts/build-tcgplayer-map.mjs              # every cached set
//   node scripts/build-tcgplayer-map.mjs --owned      # only sets you hold
//   node scripts/build-tcgplayer-map.mjs --dry        # match sets, write nothing
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const tcgcsv = require('../src/tcgcsvApi');

const args = process.argv.slice(2);
const scope = args.includes('--owned') ? 'owned' : 'all';
const dry = args.includes('--dry');

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

async function main() {
  await db.initDb();

  const sets = await tcgcsv.setsToPrice(scope);
  console.log(`${sets.length} cached Pokémon sets in scope (${scope}); Pocket sets excluded.`);

  const groups = {};
  for (const categoryId of Object.values(tcgcsv.CATEGORY)) {
    groups[categoryId] = await tcgcsv.getGroups(categoryId);
    console.log(`  TCGplayer category ${categoryId}: ${groups[categoryId].length} groups`);
  }
  const match = tcgcsv.buildGroupMatcher(groups);

  if (dry) {
    // Set matching is the risky half and needs no writes to inspect, so it can be
    // reviewed before anything touches a price column.
    let exact = 0, suffix = 0, missed = 0, missedCards = 0;
    for (const s of sets) {
      const m = match(s.set_id, s.set_name, s.language);
      if (!m) { missed++; missedCards += s.n; console.log(`  MISS  ${s.set_id} | ${s.set_name} (${s.language}, ${s.n} cards)`); }
      else if (m.confidence === 1) exact++;
      else { suffix++; console.log(`  ~     ${s.set_name} -> ${m.group.name} (confidence ${m.confidence})`); }
    }
    console.log(`\nexact ${exact}, suffix ${suffix}, unmatched ${missed} (${missedCards} cards)`);
    process.exit(0);
  }

  let priced = 0, cards = 0, unmatched = [];
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    try {
      const r = await tcgcsv.priceSet(s, match);
      cards += r.cached || 0;
      priced += r.priced;
      if (!r.matched) unmatched.push(`${s.set_id} (${s.language})`);
      const tag = r.matched ? `${r.priced}/${r.cached}` : 'no group';
      console.log(`  [${i + 1}/${sets.length}] ${s.set_id} ${s.language.padEnd(9)} ${tag}`);
    } catch (e) {
      console.warn(`  [${i + 1}/${sets.length}] ${s.set_id} FAILED: ${e.message}`);
    }
  }

  console.log(`\npriced ${priced} of ${cards} cached cards (${pct(priced, cards)})`);
  if (unmatched.length) console.log(`no TCGplayer group for: ${unmatched.join(', ')}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
