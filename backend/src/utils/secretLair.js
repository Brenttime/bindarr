// Secret Lair drops: search a drop by name and add its whole card list to the
// collection in one action.
//
//   GET {MTGJSON}/DeckList.json       the daily product index; rows typed
//                                     `Secret Lair Drop` are the drops, each with
//                                     fileName + name + code + release date.
//   GET {MTGJSON}/decks/<file>.json   that product's card list; every card
//                                     carries setCode + number + count +
//                                     identifiers.scryfallId and its own isFoil
//                                     flag, so it resolves through the SAME
//                                     proven path the precon importer uses
//                                     (bulkFetchByIdentifier -> card_cache),
//                                     which is what makes the "already own N
//                                     of these" counts honest.
//
// Why MTGJSON and not the Wizards store or Scryfall directly: the Secret Lair
// store endpoint is a purchasability feed (no bulk card list per drop) and is
// bot-gated; Scryfall has no endpoint that enumerates Secret Lair products at
// all. MTGJSON ships the drop list AND keeps the foil split as separate
// "... Foil Edition" products, which is what makes an honest foil/non-foil
// choice possible: the real product's own printings, not a guessed overlay.
const { getPreconIndex, getPreconCardList, rankPrecons } = require('./preconData');
const { bulkFetchByIdentifier } = require('../scryfallApi');
const { cacheNormalizedCards } = require('./cardCache');
const db = require('../db');

const SL_TYPE = 'Secret Lair Drop';

// Mirrors the collection.printing CHECK constraint (db.js): only these two
// exist, so a Secret Lair "foil" is the holofoil treatment — there is no
// separate foil column to invent, and the UI's choice maps onto this.
const PRINTING_VALUES = ['Normal', 'Holofoil'];
const VALID_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// MTGJSON names the foil twin "<base> Foil Edition"; some rows carry a separate
// isFoil flag. Both normalise to the same base key so a drop and its foil twin
// collapse into one picker entry with a foil option.
function baseName(name) {
  return String(name || '').replace(/\s+foil\s+edition\s*$/i, '').trim();
}
function nameKey(name) {
  return baseName(name).toLowerCase().replace(/[^\w]+/g, ' ').trim();
}
function isFoilRow(row) {
  return Boolean(row && (row.isFoil === true || /\s+foil\s+edition\s*$/i.test(String(row.name || ''))));
}

// Ranked drop list for the picker, with each drop's foil twin folded in as
// `foil` (its own fileName + release) when MTGJSON ships one. The caller picks
// WHICH product file to read by passing its fileName — the base or the foil
// twin's — so foil resolution uses the real Foil Edition product's own
// scryfallIds (correct art, ids, prices), never a name-convention guess.
// `q` empty returns the full catalogue (still capped), so the box browses.
// `opts.getIndex`/`opts.limit` are the test seams; production passes neither.
async function searchSecretLair(q, opts = {}) {
  const index = await (opts.getIndex || getPreconIndex)();
  const drops = (index.decks || []).filter((d) => String((d && d.type) || '') === SL_TYPE);
  const byKey = new Map();
  for (const d of drops) {
    const key = nameKey(d.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { base: null, foil: null });
    const slot = byKey.get(key);
    if (isFoilRow(d)) { if (!slot.foil) slot.foil = d; }
    else if (!slot.base) slot.base = d;
  }
  const merged = [];
  for (const [key, slot] of byKey) {
    if (!slot.base && !slot.foil) continue;
    const rep = slot.base || slot.foil;
    merged.push({
      key,
      name: baseName(rep.name) || rep.name,
      // The file to read for the NON-foil choice (base product; foil-only
      // drops fall back to their foil file, which is the only one that exists).
      fileName: (slot.base || slot.foil).fileName,
      code: rep.code || '',
      releaseDate: rep.releaseDate || null,
      hasFoil: Boolean(slot.foil),
      foilOnly: !slot.base && Boolean(slot.foil),
      foil: slot.foil ? { fileName: slot.foil.fileName, name: slot.foil.name, releaseDate: slot.foil.releaseDate || null } : null,
    });
  }
  const ranked = rankPrecons(merged, String(q || ''));
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  return {
    results: ranked.slice(0, limit).map(({ _score, _at, ...d }) => d),
    total: merged.length,
    // Only true when the live download failed and the last synced mirror is
    // being served — a fresh mirror is not stale.
    stale: index.source === 'stale',
    mtgjsonDate: index.mtgjsonDate || '',
  };
}

// SUM(quantity) grouped by card_id for this user, restricted to the given ids.
async function ownedCountForCards(userId, cardIds, database = db) {
  const owned = new Map();
  const ids = (cardIds || []).filter(Boolean);
  if (!userId || !ids.length) return owned;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await database.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
      WHERE user_id = ? AND card_id IN (${placeholders})
      GROUP BY card_id`,
    [userId, ...ids]
  );
  for (const r of rows) owned.set(String(r.card_id).toLowerCase(), Number(r.qty) || 0);
  return owned;
}

// Resolve one product file's card list to real card_cache rows.
// `fileName` is the MTGJSON product file to read — the base drop, or its Foil
// Edition twin when the caller wants the foil printings. `deps` injects the
// network/db touches so tests run hermetically; production passes nothing.
//
// Resolution goes through bulkFetchByIdentifier (the same resolver the import
// pipelines and the precon importer use): it prefers the row's own scryfallId
// uuid, then set+number, then name. We pass all three per card so a card with
// no usable uuid still lands. Resolved cards are cached (cacheCards idempotent)
// so the collection rows have art/prices to point at, exactly as the precon
// import does.
async function previewSecretLairDrop({ fileName, userId }, deps = {}) {
  if (!fileName || typeof fileName !== 'string') {
    throw Object.assign(new Error('fileName required'), { status: 400 });
  }
  const getCardList = deps.getCardList || getPreconCardList;
  const resolve = deps.bulkResolve || bulkFetchByIdentifier;
  const cache = deps.cacheCards || cacheNormalizedCards;
  const database = deps.db || db;

  const list = await getCardList(fileName); // throws .status=502 on upstream failure
  const entries = (list.cards || [])
    .map((c) => ({
      setCode: c.setCode || '',
      number: c.number != null ? String(c.number) : '',
      scryfallId: c.scryfallId || '',
      name: c.name || '',
      count: Number.isFinite(c.count) && c.count > 0 ? c.count : 1,
      isFoil: Boolean(c.isFoil),
    }))
    .filter((c) => c.name || (c.setCode && c.number));

  // One lookup row per distinct printing; a deck list can name the same card in
  // two sections, and a bulk resolver returns one entry per unique identifier,
  // so we collapse first and carry the summed copy count for the filing step.
  const uniq = new Map();
  for (const c of entries) {
    const key = c.scryfallId
      ? `i:${c.scryfallId.toLowerCase()}`
      : `n:${c.name.toLowerCase()}|${c.setCode.toLowerCase()}|${c.number.toLowerCase()}`;
    if (uniq.has(key)) { uniq.get(key).count += c.count; continue; }
    uniq.set(key, { ...c });
  }
  // The request row doubles as the identity handle: bulkFetchByIdentifier keys
  // each identifier to the row object it was handed and echoes that exact object
  // back in `pairs[].row`, so hanging the product's per-card count and foil flag
  // on it survives the round trip and reads back by object identity — no fragile
  // re-keying of a resolver that may normalise names, case, or which identifier it
  // chose. The resolver only ever reads id/set_id/number/name off a row, so the
  // underscore fields are inert to it.
  const rows = [...uniq.values()].map((c) => ({
    id: c.scryfallId || undefined,
    set_id: c.setCode || undefined,
    number: c.number || undefined,
    name: c.name || undefined,
    _count: c.count,
    _isFoil: c.isFoil,
  }));

  const { cards, pairs, notFound } = await resolve(rows);
  if (cards && cards.length) await cache(cards);

  const resolved = [];
  const seenId = new Set();
  for (const p of pairs || []) {
    const card = p && p.card;
    if (!card || !card.id || seenId.has(card.id)) continue;
    seenId.add(card.id);
    const src = p.row || {};
    resolved.push({
      card_id: card.id,
      name: card.name || src.name || '',
      image_url: card.image_url || null,
      set_code: card.set_id || src.set_code || null,
      number: card.number != null ? String(card.number) : null,
      count: src._count || 1,
      isFoil: Boolean(src._isFoil),
    });
  }

  // Ownership: count what this user already has, so the UI can badge cards
  // already owned rather than invite a blind duplicate add.
  let owned = new Map();
  if (userId && resolved.length) {
    owned = await ownedCountForCards(userId, resolved.map((r) => r.card_id), database);
  }

  return {
    name: list.name || baseName(fileName),
    code: list.code || null,
    type: list.type || null,
    cards: resolved.map((r) => ({ ...r, owned: owned.get(String(r.card_id).toLowerCase()) || 0 })),
    unresolved: notFound || 0,
    // Distinct printings the product's card list names, resolved vs not — the
    // UI shows "N of M printings found" and flags a partial answer rather
    // than letting a short list read as complete.
    totalListed: uniq.size,
    resolvedCount: resolved.length,
  };
}

// The write: add every resolved card of the drop to the user's collection at
// the chosen printing/condition/language, using the product's OWN per-card
// counts (a drop ships 4x of one card and 1x of another), through the shared
// bulk-add core the tray uses — same per-card service, same sequential order,
// same per-card error reporting, so a Secret Lair add and a tray add cannot
// drift on what "added" means. `printingMode`:
//   'auto'    — each card as the product lists it (its own isFoil flag)
//   'foil'    — force Holofoil (read the Foil Edition file: real foils)
//   'nonfoil' — force Normal
// Unresolved cards are reported, never faked.
async function addSecretLairToCollection({
  fileName, user, printingMode = 'auto', condition = 'Near Mint', language = 'English', copies = 1,
}, deps = {}) {
  if (!user || !user.id) throw Object.assign(new Error('user required'), { status: 400 });
  if (!fileName || typeof fileName !== 'string') throw Object.assign(new Error('fileName required'), { status: 400 });
  const mode = ['auto', 'foil', 'nonfoil'].includes(String(printingMode).toLowerCase())
    ? String(printingMode).toLowerCase() : 'auto';
  const condition2 = VALID_CONDITIONS.includes(condition) ? condition : 'Near Mint';
  const mult = Math.max(1, Math.min(Number(copies) || 1, 500));

  const preview = await previewSecretLairDrop({ fileName, userId: user.id }, deps);
  const addable = (preview.cards || []).filter((c) => c.card_id);
  if (!addable.length) {
    return {
      added: 0, failed: [], message: 'No cards to add',
      name: preview.name, totalCards: preview.totalListed, unresolved: preview.unresolved,
    };
  }

  // The bulk core applies ONE shared printing to the whole call, so group the
  // cards by the printing they should be filed under and call once per group.
  // Per-entry `quantity` still rides through (the core honours an entry's own
  // count over the shared one), which is what preserves the product's per-card
  // copy counts.
  const bulk = deps.bulkAdd || require('../routes/collection').bulkAddToCollection;
  if (typeof bulk !== 'function') {
    throw Object.assign(new Error('bulk add service unavailable'), { status: 500 });
  }

  const plan = addable.map((c) => ({
    card_id: c.card_id,
    quantity: Math.max(1, Math.round((c.count || 1) * mult)),
    printing: mode === 'foil' ? 'Holofoil'
      : mode === 'nonfoil' ? 'Normal'
        : (c.isFoil ? 'Holofoil' : 'Normal'),
  }));

  let added = 0;
  const failed = [];
  for (const printing of ['Normal', 'Holofoil']) {
    const group = plan.filter((e) => e.printing === printing);
    if (!group.length) continue;
    const res = await bulk(user, group, { condition: condition2, printing, language, stackable: true });
    added += (res && res.added ? res.added.length : 0);
    if (res && res.failed) failed.push(...res.failed);
  }
  return {
    added,
    failed,
    name: preview.name,
    totalCards: preview.totalListed,
    resolvedCount: preview.resolvedCount,
    unresolved: preview.unresolved,
  };
}

module.exports = {
  SL_TYPE,
  PRINTING_VALUES,
  VALID_CONDITIONS,
  baseName,
  nameKey,
  isFoilRow,
  searchSecretLair,
  previewSecretLairDrop,
  ownedCountForCards,
  addSecretLairToCollection,
};
