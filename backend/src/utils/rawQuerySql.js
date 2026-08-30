// Compile a Scryfall-syntax query (the LOCAL subset — operators the stored
// card_cache rows can answer) into a single SQLite predicate over card_cache.
//
// Why this exists: a raw query like "is:land color:g set:lea rarity:rare" used
// to always hit Scryfall (2/sec, 175-card pages, 60s timeout) even though every
// operator here is answerable from rows this install already holds. Answering
// it in the database is instant and never burns the rate limit.
//
// The AST comes from shared/scryfallQuery.js analyze(), which is the single
// source of truth for what the syntax MEANS. This file only does the
// AST -> SQL translation; target resolution (color codes, rarity aliases,
// language names) is imported from the shared module so the SQL path and the
// browser's JS evaluator (CollectionList's local filter) can never drift.
//
// Operators translated (all in shared/scryfallQuery.js KNOWN_OPERATORS):
//   word / "phrase" / name:x   partial name match (name or printed_name)
//   is:x / type:x              type-line match (supertype + subtypes)
//   color:x / c:x              color_identity (colorless = empty identity)
//   rarity:x / r:x             rarity (letter alias or word, word-boundary)
//   set:x                      set code
//   number:x                   collector number (leading-zero tolerant)
//   lang:x / language:x        language
//   m:x / cmc:x                converted mana cost
//   -x / -(a b) / or / (a b)   negation, OR, grouping
//
// Anything outside this subset is a CATALOG query (otag:, availability:, t:,
// artist:, ...) and is NOT handled here — the caller routes it to the live
// Scryfall path instead.
const {
  resolveColorTarget,
  resolveRarityTarget,
  resolveLanguageTarget,
} = require('../../../shared/scryfallQuery.js');

// JSON array columns (subtypes, color_identity) are stored as strings.
// json_each() is the JSON1 accessor; SQLite here is built with JSON1.
const JT = 'cc.subtypes';   // subtypes JSON array
const CI = 'cc.color_identity'; // color_identity JSON array

// One parameter value per placeholder. `p` is the params array being filled.
function push(p, value) {
  p.push(value);
  return '?';
}

// The subtypes of a row, lowercased, joined with single spaces: "basic land".
// A correlated scalar subquery over json_each. An empty/NULL array yields ''
// (group_concat over zero rows is NULL — coalesce it, or the whole type line
// below goes NULL and nothing matches).
function subtypesLine() {
  return `COALESCE((SELECT group_concat(LOWER(je.value), ' ') FROM json_each(${JT}) je), '')`;
}

// A full type line (supertype + subtypes) for type:. Mirrors the JS evaluator,
// which joins supertype + subtypes with single spaces.
function typeLine() {
  return `LOWER(COALESCE(cc.supertype, '') || ' ' || ${subtypesLine()})`;
}

// name: / bare word / quoted phrase -> partial match on either name column.
// The value is already lowercase for bare words and phrases (parseTerm
// lowers them); LIKE is ASCII-case-insensitive, matching the JS
// includes()-on-lowercase semantics.
function nameMatch(p, value) {
  const a = push(p, `%${value}%`);
  const b = push(p, `%${value}%`);
  return `(cc.name LIKE ${a} OR cc.printed_name LIKE ${b})`;
}

function isMatch(p, rawValue) {
  // is:basic-land -> "basic land" as it reads in the type line.
  const val = String(rawValue).replace(/-/g, ' ').toLowerCase();
  const supEq = push(p, val);
  const subEq = push(p, val);
  const subSub = push(p, `%${val}%`);
  return `(` +
    `LOWER(COALESCE(cc.supertype, '')) = ${supEq} ` +
    `OR EXISTS (SELECT 1 FROM json_each(${JT}) je WHERE LOWER(je.value) = ${subEq}) ` +
    `OR ${subtypesLine()} LIKE ${subSub}` +
    `)`;
}

function typeMatch(p, rawValue) {
  const val = String(rawValue).trim().toLowerCase();
  const ph = push(p, `%${val}%`);
  return `${typeLine()} LIKE ${ph}`;
}

function colorMatch(p, rawValue) {
  const target = resolveColorTarget(rawValue);
  // The identity column is a JSON array string; a NULL column would make
  // json_each() error, so null becomes '[]' (no colors = colorless).
  const json = `CASE WHEN ${CI} IS NULL THEN '[]' ELSE ${CI} END`;
  if (target === 'colorless') {
    // No colors at all: the identity array is empty.
    return `(SELECT count(*) FROM json_each(${json}) ci) = 0`;
  }
  const ph = push(p, target.toLowerCase());
  return `EXISTS (SELECT 1 FROM json_each(${json}) ci WHERE LOWER(ci.value) = ${ph})`;
}

function rarityMatch(p, rawValue) {
  const target = resolveRarityTarget(rawValue);
  const stored = `LOWER(REPLACE(COALESCE(cc.rarity, ''), '_', ' '))`;
  if (target.length === 1) {
    // Letter alias: stored rarity begins with that letter ('r' -> rare).
    const ph = push(p, `${target}%`);
    return `${stored} LIKE ${ph}`;
  }
  // Word-level: the stored rarity (one or more words) contains the word.
  const padded = `' ' || ${stored} || ' '`;
  const ph = push(p, ` ${target} `);
  return `${padded} LIKE ${ph}`;
}

function setMatch(p, rawValue) {
  const ph = push(p, String(rawValue).trim().toLowerCase());
  return `LOWER(COALESCE(cc.set_id, '')) = ${ph}`;
}

// "Is this string made only of digits, non-empty?" — a REPLACE chain (SQLite
// has no built-in REGEXP). Only used where a CAST would otherwise over-match.
function allDigitsExpr(expr) {
  let stripped = expr;
  for (const d of '0123456789') stripped = `REPLACE(${stripped}, '${d}', '')`;
  return `LENGTH(${expr}) > 0 AND LENGTH(${expr}) = LENGTH(${stripped})`;
}

function numberMatch(p, rawValue) {
  const v = String(rawValue).trim();
  const stored = `TRIM(COALESCE(cc.number, ''))`;
  const exact = push(p, v);
  const ors = [`${stored} = ${exact}`];
  // "085" finds a stored "85" (and vice versa) — but only when BOTH forms are
  // purely numeric. A bare CAST is the dangerous half: SQLite casts any
  // non-numeric string to 0 (CAST('TG12') = CAST('SV49') = 0), so "8" would
  // match every letter-numbered promo, and CAST('8a') = 8 would match a
  // "8a". The all-digits gate keeps the CAST to exactly the cases the JS
  // evaluator accepts (/^\d+$/ on both sides) — the same tolerance the
  // field-search SQL path uses.
  if (/^\d+$/.test(v)) {
    const pv = push(p, v);
    ors.push(`(${allDigitsExpr('cc.number')} AND CAST(cc.number AS INTEGER) = CAST(${pv} AS INTEGER))`);
  }
  return `(${ors.join(' OR ')})`;
}

function langMatch(p, rawValue) {
  const target = resolveLanguageTarget(rawValue);
  if (!target) return `0`; // unknown language names no row (JS returns false)
  const ph = push(p, target.toLowerCase());
  return `LOWER(COALESCE(cc.language, '')) = ${ph}`;
}

function cmcMatch(p, rawValue) {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return `0`; // m:abc matches nothing (JS: false)
  const ph = push(p, num);
  return `cc.cmc IS NOT NULL AND CAST(cc.cmc AS REAL) = ${ph}`;
}

function leafToSql(node, p) {
  if (node.kind === 'name') return nameMatch(p, node.value);
  switch (node.op) {
    case 'name': return nameMatch(p, node.value);
    case 'is': return isMatch(p, node.value);
    case 'type': return typeMatch(p, node.value);
    case 'color':
    case 'c': return colorMatch(p, node.value);
    case 'rarity':
    case 'r': return rarityMatch(p, node.value);
    case 'set': return setMatch(p, node.value);
    case 'number': return numberMatch(p, node.value);
    case 'lang':
    case 'language': return langMatch(p, node.value);
    case 'm':
    case 'cmc': return cmcMatch(p, node.value);
    default:
      // Unreachable for a local-mode query (analyze() already rejected unknown
      // operators as catalog-mode). Fail loudly if this is ever called with
      // one anyway rather than silently matching everything.
      throw new Error(`rawQuerySql: unhandled operator "${node.op}:"`);
  }
}

// Wrap a composite node in parentheses so it keeps its precedence when nested.
function isComposite(node) {
  return node.op === 'and' || node.op === 'or' || node.op === 'not';
}

function nodeToSql(node, p) {
  if (node.op === 'and') {
    const parts = node.terms.map(t => isComposite(t) ? `(${nodeToSql(t, p)})` : nodeToSql(t, p));
    return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
  }
  if (node.op === 'or') {
    const parts = node.terms.map(t => isComposite(t) ? `(${nodeToSql(t, p)})` : nodeToSql(t, p));
    return `(${parts.join(' OR ')})`;
  }
  if (node.op === 'not') {
    return `NOT (${nodeToSql(node.term, p)})`;
  }
  return leafToSql(node, p);
}

// Build { whereSql, params } for one card_cache row. `whereSql` begins with
// "AND <predicate>" (caller prepends the base table + language filter).
function compileWhere(ast) {
  const params = [];
  const whereSql = `AND ${nodeToSql(ast, params)}`;
  return { whereSql, params };
}

// Full SELECT + COUNT for a raw local query, scoped to one language.
//   language  display name ('English', 'Japanese', ...) — the requested lang
//   ast       from analyze(query).ast
//   limit/offset  1-based page window
//   orderBy     stable deterministic order so paging never shuffles
// Returns { sql, params, countSql, countParams }.
function compileRawQuery({ ast, language, limit = 60, offset = 0 }) {
  const { whereSql, params } = compileWhere(ast);
  const orderBy = `ORDER BY LOWER(cc.name), cc.set_id, cc.number, cc.id`;
  const base = `FROM card_cache cc WHERE cc.language = ?`;
  const sql = `SELECT cc.* ${base}${whereSql} ${orderBy} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n ${base}${whereSql}`;
  return {
    sql,
    params: [language, ...params, limit, offset],
    countSql,
    countParams: [language, ...params],
  };
}

module.exports = { compileRawQuery, compileWhere };
