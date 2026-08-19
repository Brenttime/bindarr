// Drop Pokémon set rows the CURRENT provider does not list.
//
// The `sets` table is a cache of "which sets exist", and the two Pokémon
// providers number the same sets differently (sv1/sv01, pgo/swsh10.5, me1/me01).
// Nothing ever deleted from it, so switching provider left both numberings in
// place: 270 rows for 218 real sets, and every set picker showing Scarlet &
// Violet twice.
//
// A stale row is kept when a cached card still points at it — that row is the
// only thing naming the set those cards belong to, and losing it would leave
// them unlabelled and unsortable. So this removes duplicates, never history.
const db = require('../db');

async function pruneStaleSets(currentIds, label = 'provider') {
  if (!Array.isArray(currentIds) || !currentIds.length) return 0;
  const keep = currentIds.map(id => String(id).toLowerCase());
  const stale = await db.all(
    `SELECT id FROM sets
      WHERE game = 'pokemon'
        AND LOWER(id) NOT IN (${keep.map(() => '?').join(',')})
        AND LOWER(id) NOT IN (SELECT DISTINCT LOWER(set_id) FROM card_cache WHERE game = 'pokemon' AND set_id IS NOT NULL)`,
    keep
  );
  for (const s of stale) {
    await db.run(`DELETE FROM sets WHERE id = ? AND game = 'pokemon'`, [s.id]);
  }
  if (stale.length) console.log(`Removed ${stale.length} Pokemon set rows not listed by ${label} (none had cached cards).`);
  return stale.length;
}

module.exports = { pruneStaleSets };
