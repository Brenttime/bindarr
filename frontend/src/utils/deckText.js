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

export function buildDeckExport(cards, format = 'mtga') {
  if (!cards || !cards.length) return '';

  // Buylist: only the copies the deck needs beyond what's already owned,
  // as TCGplayer Mass Entry lines ("2 Card Name"). owned_qty comes from the
  // deck detail query.
  if (format === 'buylist') {
    return cards
      .map(c => ({ name: c.name, need: Math.max(0, (c.quantity || 0) - (c.owned_qty || 0)) }))
      .filter(c => c.need > 0)
      .map(c => `${c.need} ${c.name}`)
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
