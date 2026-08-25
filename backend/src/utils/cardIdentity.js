// A card's printing id identifies the physical object shown in the collection.
// Everywhere else, Bindarr treats reprints and alternate art as the same game
// card. card_cache does not persist Scryfall oracle_id, so the identity available
// across existing rows is Scryfall's canonical English `name`. This is a
// compatibility fallback, not a perfect Oracle identity: future canonical name
// changes/aliases still require an oracle_id schema migration. Keep the SQL
// expression centralized so checkout, deck rules, lists, search, and collection
// allocation cannot drift back to exact-printing comparisons.

function safeAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Unsafe SQL alias: ${alias}`);
  }
  return alias;
}

function sqlCardKey(alias) {
  const a = safeAlias(alias);
  return `LOWER(TRIM(COALESCE(${a}.name, '')))`;
}

function sqlSameCard(leftAlias, rightAlias) {
  return `${sqlCardKey(leftAlias)} = ${sqlCardKey(rightAlias)}`;
}

// SQL twin of deckRules.isBasicLand. Keeping this as an expression lets the
// guarded checkout UPDATE exempt basic lands in the same atomic statement that
// reserves every non-basic card.
function sqlIsBasicLand(alias) {
  const a = safeAlias(alias);
  const key = sqlCardKey(a);
  const subtypes = `LOWER(COALESCE(${a}.subtypes, ''))`;
  const isLand = `(LOWER(COALESCE(${a}.supertype, '')) = 'land' OR INSTR(${subtypes}, '"land"') > 0)`;
  // A typed dual such as Tundra has Plains/Island subtypes but is not a
  // Basic Land. Require the Basic subtype, except for the six canonical basic
  // names retained for compatibility with older cache rows.
  const isBasicType = `(${key} IN ('plains', 'island', 'swamp', 'mountain', 'forest', 'wastes') OR ` +
    `INSTR(${subtypes}, '"basic"') > 0)`;
  return `(${isLand} AND ${isBasicType})`;
}

module.exports = { sqlCardKey, sqlSameCard, sqlIsBasicLand };
