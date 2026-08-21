// Card-list text export, shared by the frontend (CollectionList bulk bar,
// Settings) and the backend (GET /api/collection/cardlist) so every copy of
// Bindarr emits byte-identical text.
//
// Two shapes:
//   plain    "4 Lightning Bolt"
//   detailed "4 Lightning Bolt (JUD) 124" — set code in parens + collector
//            number, the shape ManaBox / TCGplayer buylist tools expect.
//
// Split cards ("A // B") stay one line: one line per physical card, name
// verbatim — the "//" never appears where a tool would parse it away.
//
// CJS on purpose: the server (Node 20, plain require) and the e2e tests import
// it that way, and the frontend bundles it through Vite/esbuild, both of
// which interop CJS named exports without issue.

const norm = (v) => String(v == null ? '' : v).trim();

// One card line. Cards arrive in different shapes by source: collection rows
// carry set_id/number, deck cards carry set_code/collector_number — accept
// every spelling, uppercasing the set code the way the deck exports do.
function cardListLine(card, style = 'plain') {
  const qty = Math.max(1, parseInt(card.quantity, 10) || 1);
  const name = norm(card.name);
  if (style === 'detailed') {
    const set = norm(card.set_id || card.set_code).toUpperCase();
    const num = norm(card.number || card.collector_number);
    let line = name;
    if (set) line += ` (${set})`;
    if (num) line += ` ${num}`;
    return `${qty} ${line}`;
  }
  return `${qty} ${name}`;
}

// A whole list: one line per card, blank for no cards (a clipboard of nothing
// is worse than an error).
function buildCardListText(cards, style = 'plain') {
  if (!Array.isArray(cards) || cards.length === 0) return '';
  return cards.map(c => cardListLine(c, style)).join('\n');
}

module.exports = { cardListLine, buildCardListText };
