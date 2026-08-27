// A Scryfall-search-syntax evaluator that Bindarr runs against cards it
// already holds. The collection screen filters its loaded rows in the browser;
// this module is the single source of truth for what the syntax means, so the
// UI and any future server-side use cannot drift.
//
// It covers the operators people actually use against their own collection,
// not the whole Scryfall grammar:
//
//   word / "phrase" / name:x   partial name match (English name or printed name)
//   -word / -op:x / -(a b)     negation
//   a or b                     OR, looser than the implicit AND (like Scryfall)
//   (a b)                      grouping
//   is:x                       is:land, is:creature, is:basic-land, ...
//   type:x                     any fragment of the type line
//   color:x  c:x               w u b r g, or c / colorless for no colors
//   rarity:x                   common uncommon rare mythic secret variant
//                              (or the first letter: c u r m s v)
//   set:x                      set code (lea, m21, ...)
//   number:x                   collector number, leading-zero tolerant
//   lang:x  language:x         language code or name (ja, japanese, ...)
//   m:x  cmc:x                 converted mana cost
//
// Anything it cannot understand throws a QuerySyntaxError, so the caller can
// NAME the problem ("invalid query") instead of silently matching nothing —
// or, worse, everything.
//
// CJS on purpose, like shared/cardListText.js: the server can require it
// (Node 20), the frontend bundles it through Vite, and both test suites can
// assert on it.
const LANG_TABLE = require('./languages.json');

class QuerySyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuerySyntaxError';
  }
}

// Every spelling a stored row might use, mapped to the display name the row
// actually holds ('English', 'Japanese', ...).
const LANG_INDEX = new Map();
for (const l of LANG_TABLE) {
  LANG_INDEX.set(l.name.toLowerCase(), l.name);
  LANG_INDEX.set(l.code.toLowerCase(), l.name);
  if (l.scryfall && l.scryfall !== l.code) LANG_INDEX.set(l.scryfall, l.name);
}

// Scryfall accepts a rarity by its first letter; a full word wins wherever
// both exist ('m' is mythic, not a prefix game — there is no other rarity
// that starts with m).
const RARITY_ALIASES = { c: 'common', u: 'uncommon', r: 'rare', m: 'mythic', s: 'secret', v: 'variant' };

// The single-letter color codes Scryfall uses, mapped to the display names
// stored in color_identity.
const COLOR_NAMES = { w: 'white', u: 'blue', b: 'black', r: 'red', g: 'green' };

const KNOWN_OPERATORS = new Set([
  'name', 'is', 'type', 'color', 'c', 'rarity', 'r', 'set', 'number', 'lang', 'language', 'm', 'cmc',
]);

function tokenize(query) {
  const tokens = [];
  const s = String(query);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(') {
      tokens.push({ type: 'open' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'close' });
      i += 1;
      continue;
    }
    if (ch === '-' && s[i + 1] === '(') {
      // Negated group: -(a b). A bare "-" is handled by the word scan below.
      tokens.push({ type: 'open', neg: true });
      i += 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== '"') { val += s[j]; j += 1; }
      if (j >= s.length) throw new QuerySyntaxError('Unterminated quoted phrase — close it with "');
      tokens.push({ type: 'phrase', value: val });
      i = j + 1;
      continue;
    }
    // A plain word: up to the next whitespace or parenthesis.
    const start = i;
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '(' && s[j] !== ')') j += 1;
    let word = s.slice(start, j);
    i = j;

    let neg = false;
    if (word.startsWith('-')) {
      neg = true;
      word = word.slice(1);
      if (!word) throw new QuerySyntaxError('"-" must negate a term');
      if (/^or$/i.test(word)) throw new QuerySyntaxError('Cannot negate "or"');
    }
    if (!neg && /^or$/i.test(word)) {
      tokens.push({ type: 'or' });
      continue;
    }

    let op = null;
    let value = word;
    const colon = word.indexOf(':');
    if (colon > 0) {
      op = word.slice(0, colon).toLowerCase();
      if (word[colon + 1] === '"') {
        // Quoted operator value, for values that contain a space.
        let k = start + colon + 2;
        let val = '';
        while (k < s.length && s[k] !== '"') { val += s[k]; k += 1; }
        if (k >= s.length) throw new QuerySyntaxError('Unterminated quoted value');
        tokens.push({ type: 'term', neg, op, value: val });
        i = k + 1;
        continue;
      }
      value = word.slice(colon + 1);
      if (!value) throw new QuerySyntaxError(`Operator "${op}:" needs a value`);
    }
    tokens.push({ type: 'term', neg, op, value });
  }
  return tokens;
}

// Tokens -> AST. Precedence, like Scryfall: `or` binds loosest, everything
// else ANDs, parentheses (and -( )) group.
function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos += 1];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'or') {
      next();
      const right = parseAnd();
      left = { op: 'or', terms: [left, right] };
    }
    return left;
  }

  function parseAnd() {
    const terms = [];
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.type === 'or' || t.type === 'close') break;
      next();
      terms.push(parseTerm(t));
    }
    if (!terms.length) throw new QuerySyntaxError('Empty query or empty parenthesis group');
    return terms.length === 1 ? terms[0] : { op: 'and', terms };
  }

  function parseTerm(t) {
    if (t.type === 'open') {
      const inner = parseOr();
      // parseAnd stops BEFORE the closing token, so `close` is at the current
      // position — peek it, then advance past it.
      const close = peek();
      if (!close || close.type !== 'close') throw new QuerySyntaxError('Unbalanced parenthesis');
      next();
      return t.neg ? { op: 'not', term: inner } : inner;
    }
    if (t.type === 'phrase') {
      return { kind: 'name', value: t.value.toLowerCase() };
    }
    let leaf;
    if (t.op) {
      leaf = { kind: 'op', op: t.op, value: t.value };
    } else {
      // "colorless" is Scryfall's own keyword for cards with no colors —
      // treat the bare word as the operator, so `-colorless` works too.
      leaf = /^colorless$/i.test(t.value)
        ? { kind: 'op', op: 'color', value: 'colorless' }
        : { kind: 'name', value: t.value.toLowerCase() };
    }
    return t.neg ? { op: 'not', term: leaf } : leaf;
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new QuerySyntaxError('Unbalanced parenthesis');
  return ast;
}

function evalNode(node, card) {
  if (node.op === 'or') return node.terms.some(t => evalNode(t, card));
  if (node.op === 'and') return node.terms.every(t => evalNode(t, card));
  if (node.op === 'not') return !evalNode(node.term, card);
  return evalLeaf(node, card);
}

function evalLeaf(leaf, card) {
  if (leaf.kind === 'name') {
    const name = String(card.name || '').toLowerCase();
    const printed = String(card.printed_name || '').toLowerCase();
    return name.includes(leaf.value) || printed.includes(leaf.value);
  }
  const v = String(leaf.value).trim().toLowerCase();
  switch (leaf.op) {
    case 'name': {
      const name = String(card.name || '').toLowerCase();
      const printed = String(card.printed_name || '').toLowerCase();
      return name.includes(v) || printed.includes(v);
    }
    case 'is': {
      // is:basic-land -> "basic land" as it reads in the type line.
      const val = v.replace(/-/g, ' ');
      const sup = String(card.supertype || '').toLowerCase();
      if (sup === val) return true;
      const subs = (card.subtypes || []).map(x => String(x).toLowerCase());
      if (subs.includes(val)) return true;
      // Multi-word values are not single subtypes, so look at the joined line.
      return subs.join(' ').includes(val);
    }
    case 'type': {
      const line = [
        String(card.supertype || '').toLowerCase(),
        ...(card.subtypes || []).map(x => String(x).toLowerCase()),
      ].filter(Boolean).join(' ');
      return line.includes(v);
    }
    case 'color':
    case 'c': {
      const ci = (card.color_identity || []).map(x => String(x).toLowerCase());
      const target = v === 'c' ? 'colorless' : (COLOR_NAMES[v] || v);
      if (target === 'colorless') return ci.length === 0;
      return ci.includes(target);
    }
    case 'rarity':
    case 'r': {
      const stored = String(card.rarity || '').toLowerCase().replace(/_/g, ' ');
      const target = RARITY_ALIASES[v] || v;
      if (target.length === 1) return stored.startsWith(target);
      // Word-level: a stored two-word rarity matches each of its words,
      // mirroring Scryfall's own matching for rarity:.
      return stored.split(' ').includes(target);
    }
    case 'set':
      return String(card.set_id || '').toLowerCase() === v;
    case 'number': {
      const stored = String(card.number != null ? card.number : '').trim();
      if (stored.toLowerCase() === v) return true;
      // "085" finds a stored "85" (and vice versa) — the same tolerance the
      // SQL search path has, so both paths agree.
      if (/^\d+$/.test(v) && /^\d+$/.test(stored)) {
        return parseInt(stored, 10) === parseInt(v, 10);
      }
      return false;
    }
    case 'lang':
    case 'language': {
      const target = LANG_INDEX.get(v);
      if (!target) return false;
      return String(card.language || '').toLowerCase() === target.toLowerCase();
    }
    case 'm':
    case 'cmc': {
      if (card.cmc == null) return false;
      return Number(card.cmc) === Number(v) && Number.isFinite(Number(v));
    }
    default:
      // Unreachable: compileQuery rejects unknown operators up front.
      throw new QuerySyntaxError(`Unknown operator: "${leaf.op}:"`);
  }
}

// Parse + validate once, return a predicate. The collection screen calls this
// per keystroke and applies the predicate to every loaded row, so the parse
// (and its errors) happen exactly once per query string.
function compileQuery(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) throw new QuerySyntaxError('Empty query');
  const ast = parseTokens(tokenize(trimmed));
  (function walk(n) {
    if (n.op === 'not') return walk(n.term);
    if (n.op === 'and' || n.op === 'or') {
      n.terms.forEach(walk);
      return;
    }
    if (n.kind === 'op' && !KNOWN_OPERATORS.has(n.op)) {
      throw new QuerySyntaxError(`Unknown operator: "${n.op}:"`);
    }
  })(ast);
  return (card) => evalNode(ast, card);
}

// One-shot convenience: parse + evaluate a single card.
function matches(card, query) {
  return compileQuery(query)(card);
}

module.exports = { QuerySyntaxError, compileQuery, matches };
