// Repair card_cache rows left behind by the English/TCGdex caching bug.
//
// setIndex.buildSet chose its FETCH by provider but its CACHE by language, so
// with pokemon_provider = 'tcgdex' every English set index pushed TCGdex card
// briefs through pokemontcg.io's normalizer. That normalizer reads `c.images.large`
// and `c.number`, which a TCGdex brief does not carry, so each row landed with the
// right name and an empty image_url and number. A scan then matched the card,
// added it, and displayed nothing.
//
// The code bug is fixed (setIndex.js caches by provider now), but the rows it
// already wrote stay wrong until something rewrites them, and a rebuild will not
// do it: the fix changes the id scheme to `tcgdex-en-*`, so the old rows are
// simply orphaned rather than overwritten.
//
// Two populations, two different repairs, because collection/deck views INNER JOIN
// card_cache — deleting a referenced row would make the card vanish from the
// collection entirely, which is worse than showing it without art:
//
//   referenced by collection or a deck  ->  delete, then re-fetch by id. Their ids
//                                           are valid pokemontcg.io ids, so the
//                                           card comes back complete.
//   everything else                     ->  delete. Pure cache; the next build or
//                                           scan re-populates it correctly.
//
// Dry run by default. Pass --apply to write, and --owned-only to repair just the
// cards you actually own and leave the (large, regenerable) cache alone.
//
//   node scripts/repairThinPokemonCache.js
//   node scripts/repairThinPokemonCache.js --apply --owned-only
//   node scripts/repairThinPokemonCache.js --apply
const path = require('path');

process.env.DB_PATH = process.env.DB_PATH
  || path.join(__dirname, '..', 'database', 'bindarr.db');

const db = require('../src/db');
const tcgApi = require('../src/tcgApi');

const APPLY = process.argv.includes('--apply');
const OWNED_ONLY = process.argv.includes('--owned-only');

// Rows written by the broken path: English Pokémon, no image, and NOT already on
// one of the id schemes that own their own refresh (tcgdex-*, mtg-*).
const BROKEN = `
  FROM card_cache
  WHERE game = 'pokemon'
    AND language = 'English'
    AND id NOT LIKE 'tcgdex-%'
    AND id NOT LIKE 'mtg-%'
    AND (image_url IS NULL OR image_url = '')
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // No initDb(): the schema already exists (the server made it), and running
  // migrations from a side process against a live database is not worth the risk
  // for a script that only reads and rewrites cache rows.
  const broken = await db.all(`SELECT id, name, set_id ${BROKEN} ORDER BY id`);
  if (!broken.length) {
    console.log('Nothing to repair: no English Pokémon rows with a blank image_url.');
    process.exit(0);
  }

  const referenced = await db.all(`
    SELECT DISTINCT cc.id, cc.name, cc.set_id
    FROM card_cache cc
    WHERE (cc.id IN (SELECT card_id FROM collection) OR cc.id IN (SELECT card_id FROM deck_cards))
      AND cc.game = 'pokemon' AND cc.language = 'English'
      AND cc.id NOT LIKE 'tcgdex-%' AND cc.id NOT LIKE 'mtg-%'
      AND (cc.image_url IS NULL OR cc.image_url = '')
    ORDER BY cc.id
  `);
  const refIds = new Set(referenced.map(r => r.id));
  const unreferenced = broken.filter(r => !refIds.has(r.id));

  console.log(`malformed English Pokémon rows: ${broken.length}`);
  console.log(`  owned (collection/deck):      ${referenced.length}  -> delete + re-fetch`);
  console.log(`  unreferenced cache only:      ${unreferenced.length}  -> delete`);
  if (referenced.length) {
    console.log('\nowned cards to re-fetch:');
    for (const r of referenced) console.log(`  ${r.id.padEnd(24)} ${r.set_id.padEnd(10)} ${r.name}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to repair.');
    process.exit(0);
  }

  // Before anything else: an owned card whose id the broken path INVENTED.
  //
  // Those rows took TCGdex's set id and pokemontcg.io's id format, so "swsh10.5-015"
  // is Pokémon GO #15 written in an id scheme where that set is called "pgo". It
  // resolves on neither provider, so re-fetching it can only ever 404. But the
  // correct row usually exists already from a post-fix rebuild — same set, same
  // number, proper "tcgdex-en-" prefix — so the repair is to point the collection
  // at it rather than to fetch anything.
  let remapped = 0;
  for (const r of referenced) {
    const target = `tcgdex-en-${r.id}`;
    const good = await db.get(`SELECT id FROM card_cache WHERE id = ? AND image_url != '' LIMIT 1`, [target]);
    if (!good) continue;
    if (APPLY) {
      await db.run(`UPDATE collection SET card_id = ? WHERE card_id = ?`, [target, r.id]);
      await db.run(`UPDATE deck_cards SET card_id = ? WHERE card_id = ?`, [target, r.id]);
    }
    remapped++;
    console.log(`  ${APPLY ? 'remapped' : 'would remap'} ${r.id} -> ${target}  ${r.name}`);
  }
  if (remapped) {
    // Re-read: the remapped ids are no longer referenced, so they are now plain
    // cache rows and fall to the bulk delete like any other.
    const stillRef = new Set((await db.all(`
      SELECT DISTINCT cc.id FROM card_cache cc
      WHERE (cc.id IN (SELECT card_id FROM collection) OR cc.id IN (SELECT card_id FROM deck_cards))
        AND (cc.image_url IS NULL OR cc.image_url = '')`)).map(x => x.id));
    for (let i = referenced.length - 1; i >= 0; i--) {
      if (!stillRef.has(referenced[i].id)) referenced.splice(i, 1);
    }
  }

  // Owned cards first: these are the ones a user can actually see missing, and
  // doing them before the bulk delete means an interrupted run never leaves an
  // owned card without a cache row to INNER JOIN against.
  //
  // Never DELETE one of these. collection.card_id carries a foreign key onto
  // card_cache, so removing the row is refused outright — and being refused is the
  // good outcome, since the alternative is a card vanishing from the collection.
  // Ageing the row instead defeats getCardById's three-day freshness check (these
  // rows were written recently, so it would otherwise hand the bad row straight
  // back) and lets the normal fetch-and-upsert path do the repair in place.
  let refetched = 0;
  const failed = [];
  for (const r of referenced) {
    try {
      await db.run(`UPDATE card_cache SET last_updated = '1970-01-01 00:00:00' WHERE id = ?`, [r.id]);
      const card = await tcgApi.getCardById(r.id);
      if (card && card.image_url) { refetched++; console.log(`  repaired ${r.id}  ${card.name}`); }
      else { failed.push(r); console.warn(`  NO IMAGE returned for ${r.id} (${r.name})`); }
    } catch (e) {
      failed.push(r);
      console.warn(`  failed ${r.id}: ${e.message}`);
    }
    await sleep(150);   // pokemontcg.io is rate limited and flaky under load
  }

  // An owned card whose re-fetch failed keeps its (bad) row. It shows without art,
  // which is the symptom being repaired — but deleting it would drop the card out
  // of the collection view altogether, and losing a card is not an acceptable
  // outcome for a cosmetic repair.
  let removed = 0;
  if (OWNED_ONLY) {
    console.log(`\nskipping ${unreferenced.length} unreferenced cache rows (--owned-only)`);
  } else {
    const spare = failed.map(r => r.id);
    const guard = spare.length ? ` AND id NOT IN (${spare.map(() => '?').join(',')})` : '';
    const del = await db.run(`DELETE ${BROKEN}${guard}`, spare);
    removed = del ? del.changes : 0;
  }

  console.log(`\nre-fetched ${refetched}/${referenced.length} owned cards`);
  console.log(`deleted ${removed} malformed cache rows`);
  if (failed.length) {
    console.log(`\n${failed.length} owned card(s) could not be re-fetched and were LEFT IN PLACE, so they`);
    console.log('stay in your collection but still show no art. Re-scan or re-add them:');
    for (const r of failed) console.log(`  ${r.id}  ${r.name}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
