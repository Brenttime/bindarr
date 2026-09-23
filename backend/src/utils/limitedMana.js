// Pure helpers for the Limited Lands analyzer (no network, unit-tested).

const BASICS = new Map([
  ['plains', 'W'], ['island', 'U'], ['swamp', 'B'], ['mountain', 'R'], ['forest', 'G'], ['wastes', 'C'],
  ['snow-covered plains', 'W'], ['snow-covered island', 'U'], ['snow-covered swamp', 'B'],
  ['snow-covered mountain', 'R'], ['snow-covered forest', 'G'],
]);
const SECTION = /^(sideboard|maybeboard|commander|companion|tokens?)\b/i;

// "2 Doom Blade", "2x Doom Blade (M10) 88", "Doom Blade". Stops at a sideboard
// header or the first blank line after cards (Arena/MTGO export layout).
function parseDecklist(text) {
  const out = new Map();
  let seenCard = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { if (seenCard) break; continue; }
    if (/^\/\/|^#/.test(line)) continue;
    if (/^deck$/i.test(line) || /^main(board)?:?$/i.test(line)) continue;
    if (SECTION.test(line)) break;
    const m = /^(\d{1,3})\s*x?\s+(.+)$/i.exec(line);
    const quantity = m ? parseInt(m[1], 10) : 1;
    let name = (m ? m[2] : line)
      .replace(/\s+\([A-Z0-9]{2,6}\)\s*[\w-]*\s*$/i, '')  // (SET) 123
      .replace(/\s+\*[^*]+\*\s*$/, '')                     // *F* foil marks
      .trim();
    if (!name || quantity < 1) continue;
    seenCard = true;
    const key = name.toLowerCase();
    if (out.has(key)) out.get(key).quantity += quantity;
    else out.set(key, { name, quantity });
  }
  return [...out.values()];
}

const COLOR_IDS = ['W', 'U', 'B', 'R', 'G'];

// Pips from one mana-cost string. Hybrid {W/U} counts half to each color,
// Phyrexian {B/P} counts to its color, {2/W} counts to the color, {C} is
// colorless. Generic numbers, {X} and {S} are ignored.
function costPips(cost) {
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const [, sym] of String(cost || '').matchAll(/\{([^}]+)\}/g)) {
    const parts = sym.toUpperCase().split('/').filter(p => p !== 'P');
    const colors = parts.filter(p => COLOR_IDS.includes(p));
    if (sym.toUpperCase() === 'C') pips.C += 1;
    else if (colors.length) for (const c of colors) pips[c] += 1 / colors.length;
  }
  return pips;
}

function frontFace(card) {
  return Array.isArray(card.card_faces) && card.card_faces.length ? card.card_faces[0] : card;
}

// Split a resolved list into spell pips, basics and non-basic land rows.
// Only the front face's cost is counted for DFC / adventure / split cards; a
// spell//land MDFC counts as a spell (the side you usually count).
function analyzeCards(cards) {
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const basics = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const lands = [];
  let spells = 0;
  for (const { quantity, card } of cards) {
    const face = frontFace(card);
    const typeLine = String(face.type_line || card.type_line || '');
    const isLand = /\bLand\b/.test(typeLine);
    const basic = BASICS.get(String(card.name).toLowerCase());
    if (isLand && basic) { basics[basic] += quantity; continue; }
    if (isLand) {
      const text = String(face.oracle_text || card.oracle_text || '');
      const produces = (card.produced_mana || []).filter(c => ['W', 'U', 'B', 'R', 'G', 'C'].includes(c));
      lands.push({
        name: card.name,
        quantity,
        produces: [...new Set(produces)],
        tapped: /enters (the battlefield )?tapped/i.test(text) && !/unless/i.test(text),
        // Restricted mana or fetch-style lands get no automatic fixing credit.
        conditional: /spend this mana only|search your library/i.test(text),
      });
      continue;
    }
    spells += quantity;
    const p = costPips(face.mana_cost != null ? face.mana_cost : card.mana_cost);
    for (const id of Object.keys(pips)) pips[id] += p[id] * quantity;
  }
  for (const id of Object.keys(pips)) pips[id] = Math.round(pips[id]);
  const basicCount = Object.values(basics).reduce((a, b) => a + b, 0);
  const landCount = basicCount + lands.reduce((a, l) => a + l.quantity, 0);
  return { pips, basics, lands, spells, landCount, basicCount, deckSize: spells + landCount };
}

module.exports = { parseDecklist, costPips, analyzeCards };
