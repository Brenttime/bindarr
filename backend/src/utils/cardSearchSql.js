// The two card_cache queries every provider runs, built in one place.
//
// Scryfall and the retired providers each carried their own copy of both — the
// same JOIN, the same name/number/set filter assembly, ~35 lines apiece. They had
// already drifted in three ways by the time they were merged, and the drift is
// the point: nobody chose it, and two of the variants were wrong.
//
// Where they disagreed, and why this file resolves it the way it does:
//
//  1. LANGUAGE IN COLLECTION SCOPE. One provider filtered `cc.language`; the
//     others deliberately did not, carrying a comment explaining that filtering
//     would hide a user's Japanese copies from a deck search. Not filtering wins:
//     collection scope answers "what do I own", and you own the card whatever
//     language you own it in. The old behaviour also made results depend on the
//     UI language for no reason a user could see — the same collection search
//     returned different rows in English and Japanese.
//
//  2. LEADING ZEROS. One provider matched a zero-stripped form of the number as well
//     ("004" also matching a stored "4"); the other two did not. Matching wins:
//     it is a pure OR, so it can only ever find more, and collector numbers are
//     written both ways depending on where they were typed.
//
//  3. LOCALIZED NAMES IN THE LOCAL CACHE. One provider searched `name` only; the others
//     searched `printed_name` too. Searching both wins, and costs nothing where
//     printed_name is NULL (a NULL LIKE is not true, so the OR just falls through).
//
// Language IS filtered in the local-cache query, in all three, and that stays:
// there it is part of a cached printing's identity, and answering a Japanese
// search with the English row sitting next to it would return the wrong card.
const { setSqlFilter } = require('./setQuery');
const { sqlCardKey } = require('./cardIdentity');

// Match a collector number written either way round.
//
// The CAST is what lets "4" find a stored "004", but on its own it over-matches
// badly: SQLite casts any non-numeric string to 0, so CAST('TG12') = CAST('SV49')
// = 0 and a search for one promo number matched every card whose number starts
// with a letter. It is therefore only applied when the query IS numeric, where it
// means what it looks like. Non-numeric numbers fall back to exact matching,
// which is what they needed all along.
function numberClause(column, number) {
  const exact = String(number || '').trim();
  if (!exact) return null;
  const match = exact.match(/^#?([A-Z0-9★\-]+)(?:\s*\/\s*[A-Z0-9★\-]+)?$/i);
  const clean = match ? match[1] : exact;
  const stripped = clean.replace(/^0+/, '');
  const terms = [`${column} = ?`];
  const params = [exact];
  if (clean !== exact) {
    terms.push(`${column} = ?`);
    params.push(clean);
  }
  if (stripped !== clean && stripped !== '' && stripped !== exact) {
    terms.push(`${column} = ?`);
    params.push(stripped);
  }
  if (/^\d+$/.test(clean) || /^\d+$/.test(exact)) {
    terms.push(`CAST(${column} AS INTEGER) = CAST(? AS INTEGER)`);
    params.push(clean);
  }
  return { clause: `(${terms.join(' OR ')})`, params };
}

// A name typed in any language: `name` holds the English/searchable name and
// `printed_name` the localized one, so both are checked.
function nameClause(prefix, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  return {
    clause: `(${prefix}name LIKE ? OR ${prefix}printed_name LIKE ?)`,
    params: [`%${trimmed}%`, `%${trimmed}%`],
  };
}

// What the user OWNS, across every language they own it in.
function collectionQuery({ userId, name, number, setList = [], limit, offset }) {
  let sql = `
    WITH logical_owned AS (
      SELECT ${sqlCardKey('owned_cc')} AS card_key, SUM(owned.quantity) AS owned_qty
      FROM collection owned
      JOIN card_cache owned_cc ON owned.card_id = owned_cc.id
      WHERE owned.user_id = ? AND owned.quantity > 0
      GROUP BY ${sqlCardKey('owned_cc')}
    )
    SELECT cc.*, logical_owned.owned_qty
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    JOIN logical_owned ON logical_owned.card_key = ${sqlCardKey('cc')}
    WHERE c.user_id = ? AND c.quantity > 0
  `;
  const params = [userId, userId];
  for (const part of [nameClause('cc.', name), numberClause('cc.number', number), setSqlFilter(setList, 'cc')]) {
    if (!part) continue;
    sql += ` AND ${part.clause}`;
    params.push(...part.params);
  }
  sql += ` GROUP BY cc.id LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return { sql, params };
}

// The cached rows for ONE language — see the note above on why language is
// filtered here and not in collection scope.
function localCacheQuery({ language, name, number, setList = [], limit, offset }) {
  let sql = `SELECT * FROM card_cache WHERE language = ?`;
  const params = [language];
  for (const part of [nameClause('', name), numberClause('number', number), setSqlFilter(setList)]) {
    if (!part) continue;
    sql += ` AND ${part.clause}`;
    params.push(...part.params);
  }
  sql += ` LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return { sql, params };
}

// The user's owned rows whose game card is in `names`. The caller already
// decided WHICH cards a (catalog-only) Scryfall query matches — this is just
// the "of those, what do I own" half. Names are the canonical English names,
// which is the app's card identity (see cardIdentity.sqlCardKey), so the
// compare is the same LOWER(TRIM(name)) join every other ownership query uses.
//
// The projection and ORDER BY mirror the /api/collection endpoint exactly, so
// the returned rows drop into the collection screen's tiles unchanged (entry_id
// drives bulk actions; quantity/condition/printing/language are per-entry).
// One row per owned printing, same as the collection list.
function ownedByNames(userId, names) {
  const clean = [...new Set(names.map(n => String(n || '').trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return { sql: null, params: [] };
  const placeholders = clean.map(() => '?').join(', ');
  const sql = `
    SELECT
      c.id AS entry_id,
      c.card_id,
      c.quantity,
      c.condition,
      c.printing,
      c.language,
      c.purchase_price,
      c.added_at,
      c.is_trade,
      c.favorite,
      c.notes,
      cc.name,
      cc.printed_name,
      cc.supertype,
      cc.subtypes,
      cc.types,
      cc.cmc,
      cc.color_identity,
      cc.rarity,
      cc.set_id,
      cc.set_name,
      cc.number,
      cc.image_url,
      cc.price_trend,
      cc.price_normal,
      cc.price_holofoil,
      cc.price_currency,
      cc.price_source,
      cc.tcgplayer_url,
      cc.cardmarket_url,
      cc.tcgplayer_product_id
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    WHERE c.user_id = ? AND c.quantity > 0
      AND ${sqlCardKey('cc')} IN (${placeholders})
    ORDER BY c.added_at DESC, c.id DESC
  `;
  return { sql, params: [userId, ...clean] };
}

module.exports = { collectionQuery, localCacheQuery, ownedByNames, nameClause, numberClause };
