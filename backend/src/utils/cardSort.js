// Shared card-ordering logic (the "how do I sort cards" half of the old
// compartmentSort.js). The storage half — compartment placement, capacity,
// slot recommendation, location rules — was removed along with the Storage
// feature. What remains powers the collection/deck sort schemes and the sets
// cache they consult, and is mirrored on the frontend by utils/cardSort.js.
const db = require('../db');

let setsCache = [];
async function loadSetsCache(database) {
  const dbClient = database || db;
  try {
    setsCache = await dbClient.all('SELECT * FROM sets ORDER BY release_date ASC, id ASC');
    console.log(`Loaded ${setsCache.length} sets into cardSort cache`);
  } catch (e) {
    console.error('Failed to load sets cache', e);
  }
}

function safeJsonParse(val, fallback = []) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch (e) {
    return fallback;
  }
}

function prepareCardMetadata(card) {
  if (!card) return card;
  return {
    ...card,
    parsed_types: Array.isArray(card.types) ? card.types : safeJsonParse(card.types, []),
    parsed_subtypes: Array.isArray(card.subtypes) ? card.subtypes : safeJsonParse(card.subtypes, []),
    parsed_color_identity: Array.isArray(card.color_identity) ? card.color_identity : safeJsonParse(card.color_identity, [])
  };
}

// Canonical category orderings shared with the frontend. See shared/cardOrder.json.
const cardOrder = require('../../../shared/cardOrder.json');
const sortSchemes = require('../../../shared/sortSchemes.json');
const PRINTING_ORDER_NORMALS_FIRST = cardOrder.printingNormalsFirst;
const PRINTING_ORDER_FOILS_FIRST = cardOrder.printingFoilsFirst;
const LANGUAGE_ORDER = cardOrder.language;
const WUBRG_ORDER = cardOrder.wubrg;

function getColorCategory(card) {
  if (!card) return 'Colorless';
  let ci = [];
  if (typeof card.color_identity === 'string') {
    try { ci = JSON.parse(card.color_identity); } catch(e){ if (card.color_identity) ci = [card.color_identity]; }
  } else if (Array.isArray(card.color_identity)) {
    ci = card.color_identity;
  }
  if (!ci || ci.length === 0) return 'Colorless';
  if (ci.length > 1) return 'Multicolor';
  const names = { 'W': 'White', 'U': 'Blue', 'B': 'Black', 'R': 'Red', 'G': 'Green' };
  return names[ci[0]] || ci[0] || 'Colorless';
}

const RARITY_RANK = [
  ['classic collection', 16], ['hyper', 15], ['special illustration', 14],
  ['illustration', 13], ['secret', 12], ['ultra', 11], ['radiant', 10],
  ['amazing', 9], ['shiny', 8], ['double rare', 7], ['mythic', 6],
  ['rare holo', 5], ['holo rare', 5], ['promo', 4], ['rare', 3],
  ['uncommon', 2], ['common', 1],
];
function rarityRank(rarity) {
  const r = (rarity || '').toLowerCase();
  for (const [kw, rank] of RARITY_RANK) if (r.includes(kw)) return rank;
  return 0;
}

function sortCards(cards, sortOrder, foilSorting) {
  let criteria = [];
  if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('[')) {
      try { criteria = JSON.parse(sortOrder); } catch(e){}
    } else {
      criteria = sortSchemes[sortOrder] || [];
    }
  } else if (Array.isArray(sortOrder)) {
    criteria = sortOrder;
  }

  const printingOrder = foilSorting === 'foils_first' ? PRINTING_ORDER_FOILS_FIRST : PRINTING_ORDER_NORMALS_FIRST;

  if (!criteria || criteria.length === 0) return [...cards];

  const sorted = [...cards];
  sorted.sort((a, b) => {
    for (const c of criteria) {
      const dirMult = c.dir === 'desc' ? -1 : 1;
      let cmp = 0;
      switch (c.by) {
        case 'favorite':
          cmp = (a.favorite ? 1 : 0) - (b.favorite ? 1 : 0);
          break;
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
        case 'price':
          cmp = (a.price_trend || 0) - (b.price_trend || 0);
          break;
        case 'set': {
          const setAIndex = setsCache.findIndex(s => s.name === a.set_name);
          const setBIndex = setsCache.findIndex(s => s.name === b.set_name);
          const cmpSetChrono = (setAIndex >= 0 ? setAIndex : 999999) - (setBIndex >= 0 ? setBIndex : 999999);
          if (cmpSetChrono !== 0) { cmp = cmpSetChrono; break; }
          cmp = (a.set_name || '').localeCompare(b.set_name || '');
          break;
        }
        case 'number': {
          const nA = parseInt(a.number || '0', 10);
          const nB = parseInt(b.number || '0', 10);
          if (!isNaN(nA) && !isNaN(nB) && nA !== nB) { cmp = nA - nB; break; }
          cmp = (a.number || '').localeCompare(b.number || '');
          break;
        }
        case 'printing':
          cmp = (printingOrder[a.printing] || 10) - (printingOrder[b.printing] || 10);
          break;
        case 'language': {
          const la = LANGUAGE_ORDER[a.language] || 99;
          const lb = LANGUAGE_ORDER[b.language] || 99;
          cmp = la - lb;
          break;
        }
        case 'cmc':
          cmp = (a.cmc || 0) - (b.cmc || 0);
          break;
        case 'color_identity':
        case 'color': {
          const catA = getColorCategory(a);
          const catB = getColorCategory(b);
          const orderA = WUBRG_ORDER[catA] || 99;
          const orderB = WUBRG_ORDER[catB] || 99;
          cmp = orderA - orderB;
          if (cmp === 0) cmp = catA.localeCompare(catB);
          break;
        }
        case 'rarity':
          cmp = rarityRank(a.rarity) - rarityRank(b.rarity);
          break;
      }
      if (cmp !== 0) return cmp * dirMult;
    }
    return 0;
  });
  return sorted;
}

// The top-level grouping a sort scheme would file a card under, for schemes
// that carry an explicit divider. Mirrors the divider logic the frontend uses
// to label groups; returns null for schemes that don't bucket.
function getSortCategory(card, sortOrder) {
  if (!card || !sortOrder || sortOrder === 'custom') return null;
  let criteria = [];
  if (typeof sortOrder === 'string') {
    if (sortOrder.startsWith('[')) {
      try { criteria = JSON.parse(sortOrder); } catch(e){}
    } else {
      criteria = [{by: sortOrder.split('-')[0], divider: true}];
    }
  } else if (Array.isArray(sortOrder)) {
    criteria = sortOrder;
  }
  if (!criteria || criteria.length === 0) return null;

  const dividers = criteria.filter(c => c.divider === true);
  if (dividers.length === 0 && criteria.some(c => c.divider === false)) {
    return null;
  }

  const primary = dividers.length > 0 ? dividers[0].by : criteria[0].by;

  if (primary === 'name') return card.name ? card.name.charAt(0).toUpperCase() : '?';
  if (primary === 'set') {
    if (!card.set_name) return 'Unknown Set';
    if (!setsCache || setsCache.length === 0) return card.set_name;
    const idx = setsCache.findIndex(s => s.name === card.set_name);
    return idx >= 0 ? `${idx + 1}. ${card.set_name}` : card.set_name;
  }
  if (primary === 'color_identity' || primary === 'color') {
    return getColorCategory(card);
  }
  if (primary === 'price') {
    const p = card.price_trend || 0;
    if (p >= 100) return '$100+';
    if (p >= 50) return '$50+';
    if (p >= 20) return '$20+';
    if (p >= 10) return '$10+';
    if (p >= 5) return '$5+';
    if (p >= 1) return '$1+';
    return '< $1';
  }
  if (primary === 'language') return card.language || 'English';
  if (primary === 'cmc') return `CMC ${card.cmc != null ? card.cmc : '?'}`;
  if (primary === 'rarity') return card.rarity || 'Common';

  return null;
}

module.exports = {
  sortCards,
  loadSetsCache,
  getSortCategory,
  getColorCategory,
  rarityRank,
  prepareCardMetadata,
  safeJsonParse,
};
