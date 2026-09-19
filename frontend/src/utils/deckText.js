// Deck decklist text <-> card list. Export builds the MTG Arena (mtga) format
// or a plain generic list. parseDeckLine is the inverse used by import so the
// app round-trips its own export (and tolerates lists copied out of those tools).

// Set code is the raw stored set_id uppercased. MTGA uses its own set
// abbreviations that don't always equal our set_id; import matches by name so
// this stays correct on re-import, but a foreign tool may want the user to fix
// the code. Good enough for now.
function cardLine(c, format) {
  const set = String(c.set_id || c.set_code || '').toUpperCase();
  const num = c.number || '';
  if (format === 'mtga') return `${c.quantity} ${c.name}${set ? ` (${set})` : ''}${num ? ` ${num}` : ''}`;
  return `${c.quantity} ${c.name}`; // plain
}

// One definition of "what this deck still needs": copies demanded beyond what
// the collection owns, per printing, basics exempt (unlimited) and rows merged
// by printing identity. The missing panel, the buylist export, and
// create-list-from-missing all read it so screen and file can't disagree.
function normCardId(c) {
  return c.card_id ?? c.id ?? c.scryfall_id ?? c.oracle_id ??
    `${String(c.name || '').toLowerCase()}|${c.set_name || ''}|${c.collector_number || ''}`;
}
function isBasicLandish(c) {
  const t = String(c.type_line || c.type || '');
  const subs = c.subtypes || [];
  const isLand = /\bLand\b/i.test(t) || String(c.supertype || '').includes('Land') || subs.includes('Land');
  if (!isLand) return false;
  return /\bBasic\b/i.test(t) || subs.includes('Basic') ||
    ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'].includes(String(c.name || '').trim());
}
export function missingEntries(cards) {
  const agg = new Map();
  for (const c of cards || []) {
    const name = String(c.name || '').trim();
    if (!name || isBasicLandish(c)) continue;
    const need = Number(c.quantity ?? c.need ?? 0) || 0;
    const have = Number(c.owned_qty ?? c.have ?? 0) || 0;
    if (need <= 0) continue;
    const key = normCardId(c);
    const prev = agg.get(key);
    if (prev) { prev.need += need; prev.have += have; }
    else agg.set(key, { card_id: c.card_id ?? c.id ?? null, scryfall_id: c.scryfall_id ?? null, name, need, have });
  }
  return Array.from(agg.values()).filter((r) => r.have < r.need)
    .sort((a, b) => (b.need - b.have) - (a.need - a.have));  // biggest gap first; ties keep deck order
}

export function buildDeckExport(cards, format = 'mtga') {
  if (!cards || !cards.length) return '';

  // Buylist: only the copies the deck needs beyond what's already owned,
  // as TCGplayer Mass Entry lines ("2 Card Name"). owned_qty comes from the
  // deck detail query.
  if (format === 'buylist') {
    return missingEntries(cards)
      .map((m) => `${m.need - m.have} ${m.name}`)
      .join('\n');
  }

  if (format === 'mtga') {
    return 'Deck\n' + cards.map(c => cardLine(c, 'mtga')).join('\n');
  }

  return cards.map(c => cardLine(c, 'plain')).join('\n');
}

// Pull {qty, name} out of one decklist line, stripping trailing set code +
// collector number so "4 Lightning Bolt (2X2) 117", "2 Counterspell (SVI)
// #17" and "4 Lightning Bolt" all yield the bare card name.
export function parseDeckLine(line) {
  const m = String(line).trim().match(/^(\d+)x?\s+(.+)$/i);
  if (!m) return null;
  const qty = parseInt(m[1], 10);
  let name = m[2];

  name = name
    .replace(/\s*\([^)]*\)/g, '')          // "(SVI)" / "(2X2)"
    .replace(/\s*#\d+[a-zA-Z]?\s*$/, '')   // "#63"
    .replace(/\s+\d+[a-zA-Z]?$/, '')       // trailing bare collector number
    .trim();

  return name ? { qty, name } : null;
}
