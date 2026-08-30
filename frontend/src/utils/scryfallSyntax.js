// One box speaks two languages: a plain card name/number/set, or Scryfall
// syntax. It looks like syntax when it carries an operator token (set:lea,
// is:land, otag:...), a quoted phrase, a parenthesized group, a bare `or`,
// or a leading "-". Real card names never contain any of those — names are
// letters and spaces (plus a few apostrophes) — so the detection cannot
// misfire on a name. A string that LOOKS like syntax but does not parse is
// the caller's problem: the shared parser reports the exact error and the
// UI shows it inline instead of filtering.
//
// Shared by every surface that takes the box (currently the collection's
// filter bar), so all of them agree on what "this is a query" means.
const SCRYFLAY_SYNTAX_RE = /(^|\s)(?:-|\(|"|or\b|[\w-]+:)/i;

export function looksLikeSyntax(value) {
  return SCRYFLAY_SYNTAX_RE.test(String(value || '').trim());
}
