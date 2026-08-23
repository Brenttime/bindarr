// SQLite's CURRENT_TIMESTAMP stores UTC but as a naive "YYYY-MM-DD HH:MM:SS"
// string with no timezone marker. JS's Date parser treats a string like that
// as LOCAL time, so on any server not running in UTC, a value that's really
// "now" gets parsed as hours off — enough to misorder it against a properly
// UTC-tagged timestamp (e.g. an ISO string with a trailing Z). Always read
// SQLite datetimes through this so they compare correctly against Date.now()
// or other real UTC timestamps.
function parseSqliteUtc(str) {
  if (!str) return new Date(NaN);
  return /Z$|[+-]\d\d:\d\d$/.test(str) ? new Date(str) : new Date(str.replace(' ', 'T') + 'Z');
}

function resolveCardPrice(card) {
  if (!card) return 0;
  // A value set on the copy wins over every provider price. It is either what the
  // owner typed or what a graded-price provider returned for this exact slab, and
  // both know something card_cache cannot: a PSA 10 is worth a multiple of the raw
  // price, and the raw price is all the card APIs quote. Only rows selected with
  // collection.market_value carry it, so a bare card_cache row is unaffected.
  if (card.market_value > 0) return card.market_value;
  if (card.printing === 'Holofoil' && card.price_holofoil !== null && card.price_holofoil > 0) {
    return card.price_holofoil;
  }
  if (card.printing === 'Reverse Holofoil' && card.price_reverse_holofoil !== null && card.price_reverse_holofoil > 0) {
    return card.price_reverse_holofoil;
  }
  if (card.printing === 'Normal' && card.price_normal !== null && card.price_normal > 0) {
    return card.price_normal;
  }
  // '1st Edition' has been a legal printing since v1.0 but had no price of its own,
  // so it fell through to price_trend — the UNLIMITED price. On a Base Set Charizard
  // that understates the card by thousands. Only TCGCSV fills this column, so the
  // fallthrough below still covers every row nothing has priced that way.
  if (card.printing === '1st Edition' && card.price_1st_edition !== null && card.price_1st_edition > 0) {
    return card.price_1st_edition;
  }
  return card.price_trend || 0;
}

// Hydrate a raw card_cache row: its array columns are stored as JSON strings,
// so parse them back to arrays. Missing columns (e.g. color_identity on a
// Pokémon row) become []. Returns a shallow copy; the raw row is untouched.
function parseCardRow(row) {
  if (!row) return row;
  return {
    ...row,
    subtypes: JSON.parse(row.subtypes || '[]'),
    types: JSON.parse(row.types || '[]'),
    color_identity: JSON.parse(row.color_identity || '[]'),
  };
}

const isVintageSet = (setId) => {
  const id = (setId || '').toLowerCase();
  return id.startsWith('base') || id.startsWith('gym') || id.startsWith('neo') ||
         id.startsWith('lc') || id.startsWith('ecard') || id.startsWith('ex') ||
         id.startsWith('pop') || id.startsWith('promo1') || id.startsWith('si') ||
         id.startsWith('xy12') || id.startsWith('cel25');
};

// Record a price point, but only when it actually moved. The price sweep runs
// on every boot and nodemon reboots on every code edit, so the unguarded insert
// was writing a fresh row per card per restart — 17k rows in a single day, all
// the same number. A price series only needs the points where the price
// changed; the flat stretches between them are implied by the line.
async function recordPrice(cardId, price) {
  if (!cardId || !(price > 0)) return false;
  const db = require('../db');
  const last = await db.get(
    `SELECT price FROM price_history WHERE card_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    [cardId]
  );
  if (last && last.price === price) return false;
  // Millisecond resolution, not CURRENT_TIMESTAMP. recorded_at is part of the
  // primary key, and the default is second-resolution — so two genuine price
  // movements in the same second collided and the second one was silently
  // dropped by OR IGNORE. %f keeps the guard while making that effectively
  // impossible. parseSqliteUtc already reads the fractional form correctly.
  await db.run(
    `INSERT OR IGNORE INTO price_history (card_id, price, recorded_at)
     VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
    [cardId, price]
  );
  return true;
}

// Scryfall: "We only update prices for cards once per day. Fetching card data
// more frequently than 24 hours will not yield new prices."
// (https://scryfall.com/docs/api/rate-limits). Sweeping more often than daily
// is pure load for zero new data, so both providers gate on this.
const PRICE_SWEEP_INTERVAL_MS = 1000 * 60 * 60 * 24;
// tcgdex gets its own clock: it serves the non-English Pokémon cards that
// pokemontcg.io has no rows for, so the two sweep different cards and letting
// either one mark the other's gate would silently skip a whole language.
// Every provider that sweeps needs an entry here, and an unknown key is treated as
// "do not sweep" — so a provider added to server.js but forgotten here goes quiet
// instead of loud: shouldSweepPrices returns false, the boot catch-up skips, and
// markPricesSwept no-ops. That is exactly what happened to tcgcsv on first run.
const SWEEP_COLUMN = {
  mtg: 'mtg_prices_swept_at',
  pokemon: 'pokemon_prices_swept_at',
  tcgdex: 'tcgdex_prices_swept_at',
  tcgcsv: 'tcgcsv_prices_swept_at',
};

// Has this game's price sweep gone stale enough to be worth running again?
async function shouldSweepPrices(game) {
  const col = SWEEP_COLUMN[game];
  if (!col) return false;
  const db = require('../db');
  try {
    const row = await db.get(`SELECT ${col} AS sweptAt FROM app_settings WHERE id = 1`);
    if (!row || !row.sweptAt) return true;
    return Date.now() - parseSqliteUtc(row.sweptAt).getTime() >= PRICE_SWEEP_INTERVAL_MS;
  } catch {
    return true; // never block the sweep on a bookkeeping failure
  }
}

async function markPricesSwept(game) {
  const col = SWEEP_COLUMN[game];
  if (!col) return;
  const db = require('../db');
  try {
    await db.run(`UPDATE app_settings SET ${col} = CURRENT_TIMESTAMP WHERE id = 1`);
  } catch (e) {
    console.warn(`Could not record ${game} price sweep time:`, e.message);
  }
}

module.exports = {
  parseSqliteUtc,
  shouldSweepPrices,
  markPricesSwept,
  PRICE_SWEEP_INTERVAL_MS,
  resolveCardPrice,
  parseCardRow,
  isVintageSet,
  recordPrice
};
