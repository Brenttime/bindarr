// Preconstructed deck lists, from MTGJSON v5's public API.
//
// Two endpoints, both plain static JSON that is regenerated daily:
//
//   GET https://mtgjson.com/api/v5/DeckList.json
//     Every WOTC preconstructed product ever released (~3,000 of them),
//     as a slim index: name, set code, product type, release date and the
//     name of that product's full card-list file.
//
//   GET https://mtgjson.com/api/v5/decks/<fileName>.json
//     The product's card list: mainboard, sideboard, commander and
//     display-commander sections, each card carrying setCode + number and
//     identifiers.scryfallId (the very uuid card_cache ids are built from).
//
// Why MTGJSON: the WOTC precons people actually want to play — booster-pack
// decks, intro packs, jumpstarts, event and challenger decks, commanders —
// are published as exact products, and the card lists say precisely which
// printing each copy comes from. Resolving set + number through
// bulkFetchByIdentifier lands on exactly that printing, which is what makes
// "export what's missing" honest: the row points at the printing the product
// ships, so an owned copy of a different printing does not count.
//
// The index is large (~3,000 entries), so it is fetched at most once a day,
// mirrored to disk under the database directory, and the mirror is what a
// search actually reads. When both the mirror and the network fail, search
// still works from the mirror alone (stale rather than absent), and import
// reports 502 — a network failure must never be mistaken for "no match".
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../db');
const { cacheNormalizedCards } = require('./cardCache');

const MTGJSON = 'https://mtgjson.com/api/v5';
const INDEX_URL = `${MTGJSON}/DeckList.json`;
const DECKS_URL = `${MTGJSON}/decks/`;
const client = axios.create({ timeout: 60000, headers: { 'User-Agent': 'Bindarr/1.0' } });
// The index changes with the daily MTGJSON build; once a day is the right
// cadence for a search box, and it is what the cache header asks for anyway.
const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// MTGJSON URL-encodes non-ASCII characters in file names (Š → %C5%A0).
const cleanFileName = (s) => String(s || '').replace(/[^A-Za-z0-9_]+/g, '');

const dataDir = path.dirname(db.dbPath);
const indexPath = path.join(dataDir, 'precons.json');

// --- Index ------------------------------------------------------------

function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (raw && Array.isArray(raw.decks) && raw.decks.length) return raw;
  } catch { /* no mirror yet */ }
  return null;
}

function writeIndex(payload) {
  const decks = (payload.data || []).map((d) => ({
    name: d.name || '',
    code: d.code || '',
    type: d.type || '',
    releaseDate: d.releaseDate || '',
    fileName: d.fileName || '',
  })).filter((d) => d.name && d.fileName);
  if (!decks.length) throw new Error('DeckList payload carried no decks');
  const doc = {
    fetchedAt: new Date().toISOString(),
    mtgjsonDate: (payload.meta && payload.meta.date) || '',
    decks,
  };
  const tmp = `${indexPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, indexPath);
  return doc;
}

// Returns { decks, fetchedAt, mtgjsonDate, source }. `source` tells the
// caller whether this is a fresh download or a (possibly stale) mirror:
// "fresh", "stale", or "cache".
async function getPreconIndex() {
  const cached = readIndex();
  const fresh = !cached || (Date.now() - Date.parse(cached.fetchedAt) >= INDEX_MAX_AGE_MS);
  if (!fresh) return { ...cached, source: 'cache' };

  try {
    const resp = await client.get(INDEX_URL);
    const doc = writeIndex(resp.data);
    return { ...doc, source: 'fresh' };
  } catch (err) {
    if (cached) return { ...cached, source: 'stale' };
    // No mirror and no network: nothing to search.
    throw Object.assign(new Error(`Precon index unavailable (${err.message})`), { status: 502 });
  }
}

// Name + set + type, case-insensitive: exact-name first, then substring,
// then subsequence — the same ranking feel as the deck vault's search box.
function rankPrecons(decks, q) {
  const needle = q.toLowerCase();
  const subseq = (hay) => {
    let i = 0;
    for (const ch of needle) {
      const at = hay.indexOf(ch, i);
      if (at < 0) return false;
      i = at + 1;
    }
    return true;
  };
  const scored = [];
  for (const d of decks) {
    const name = String(d.name || '').toLowerCase();
    const hay = `${name} ${String(d.code || '').toLowerCase()} ${String(d.type || '').toLowerCase()}`;
    let score = -1;
    if (name.includes(needle)) score = 0;
    else if (hay.includes(needle)) score = 1;
    else if (subseq(name)) score = 2;
    if (score >= 0) scored.push({ ...d, _score: score, _at: name.indexOf(needle) });
  }
  scored.sort((a, b) => a._score - b._score || a._at - b._at || a.name.localeCompare(b.name));
  return scored;
}

// --- Card list ---------------------------------------------------------

// MTGJSON deck-file key → section of a playable deck. displayCommander is the
// oversized foil commander, not a card you play; sideboard and scheme/planar
// sections exist in some products but the builder has no sideboard, so only
// mainboard and (playable) commander make it into the deck.
const SECTIONS = [['mainBoard', 'mainboard'], ['commander', 'commander']];

async function getPreconCardList(fileName) {
  const safe = cleanFileName(fileName);
  if (!safe) throw Object.assign(new Error('Invalid precon file name'), { status: 400 });
  const resp = await client.get(`${DECKS_URL}${encodeURIComponent(safe)}.json`);
  const data = (resp.data && resp.data.data) || null;
  if (!data || !Array.isArray(data.mainBoard)) {
    throw Object.assign(new Error('Malformed MTGJSON deck file'), { status: 502 });
  }
  const cards = [];
  for (const [key, section] of SECTIONS) {
    for (const c of data[key] || []) {
      cards.push({
        setCode: c.setCode || '',
        number: String(c.number || ''),
        count: Number.isFinite(c.count) ? c.count : 1,
        scryfallId: (c.identifiers && c.identifiers.scryfallId) || '',
        section,
      });
    }
  }
  return {
    name: data.name || null,
    code: data.code || null,
    type: data.type || null,
    releaseDate: data.releaseDate || null,
    cards,
  };
}

// The import core: resolve card-list entries to real card_cache rows, cache
// the resolved printings, and write the deck. `rows` are {set_id, number,
// quantity}; `cardById` is a bulk resolver returning {cards, pairs, notFound}
// (the app passes bulkFetchByIdentifier, tests pass a stub); `decksRun`/
// `cardsRun` receive (sql, params) — the app passes db.run, tests record.
async function importPreconCardsIntoDeck({
  name, description, format, category, accentColor, targetSize, userId,
  rows, cardById, cacheCards = cacheNormalizedCards, decksRun, cardsRun,
}) {
  const uniq = new Map();
  for (const r of rows) {
    const key = `${String(r.set_id).toLowerCase()}|${String(r.number).toLowerCase()}`;
    if (uniq.has(key)) uniq.get(key).quantity += r.quantity;
    else uniq.set(key, { ...r });
  }
  const list = [...uniq.values()];

  // Resolve every printing against Scryfall. The resolver answers with the
  // authoritative normalized card for each identifier — the exact row
  // card_cache should hold — so a miss here means Scryfall does not have that
  // printing, and the card is simply left out rather than faked.
  const { cards, pairs, notFound } = await cardById(list);

  // Cache the resolved printings (upsert — idempotent). Deduped by id so a
  // printing that appears in both mainboard and commander is written once.
  const seen = new Set();
  const fresh = [];
  for (const c of cards) {
    if (c && String(c.id).startsWith('mtg-') && !seen.has(c.id)) { seen.add(c.id); fresh.push(c); }
  }
  if (fresh.length) await cacheCards(fresh);

  const cardIds = [];
  for (const { row, card } of pairs) {
    if (card && String(card.id).startsWith('mtg-')) {
      cardIds.push({ cardId: card.id, quantity: row.quantity });
    }
  }
  if (!cardIds.length) {
    throw Object.assign(
      new Error("None of this preconstructed deck's cards could be resolved to card printings"),
      { status: 422, notFound: notFound + 0 }
    );
  }

  const deck = await decksRun(
    `INSERT INTO decks (name, description, format, category, accent_color, target_size, user_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, description, format, category, accentColor, targetSize, userId, 'precon']
  );
  for (const { cardId, quantity } of cardIds) {
    await cardsRun(
      `INSERT INTO deck_cards (deck_id, card_id, quantity)
       VALUES (?, ?, ?)
       ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
      [deck.lastID, cardId, quantity]
    );
  }
  return { deckId: deck.lastID, cards: cardIds.length, notFound };
}

module.exports = {
  getPreconIndex,
  getPreconCardList,
  rankPrecons,
  importPreconCardsIntoDeck,
  INDEX_URL,
  MTGJSON,
};
