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
  if (card.printing === 'Holofoil' && card.price_holofoil !== null && card.price_holofoil > 0) {
    return card.price_holofoil;
  }
  if (card.printing === 'Normal' && card.price_normal !== null && card.price_normal > 0) {
    return card.price_normal;
  }
  return card.price_trend || 0;
}

// Hydrate a raw card_cache row: its array columns are stored as JSON strings,
// so parse them back to arrays. Missing columns (e.g. color_identity on a row
// cached before it existed) become []. Returns a shallow copy; the raw row is
// untouched.
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
  // MTG's vintage era: the core sets, expansions and masters released before
  // 2000 (per Scryfall). Everything from March 2000 (Onslaught) onward is
  // modern-era.
  return ['lea', 'leb', '2ed', 'arn', 'atq', '3ed', 'leg', 'drk', 'fem', '4bb', '4ed',
    'ice', 'bchr', 'chr', 'ren', 'rin', 'hml', 'all', 'mir', 'vis', '5ed', 'wth',
    'tmp', 'sth', 'exo', 'ugl', 'usg', 'ulg', '6ed', 'uds', 'mmq'].includes(id);
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
  const res = await db.run(
    `INSERT OR IGNORE INTO price_history (card_id, price, recorded_at)
     VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
    [cardId, price]
  );
  if (res && res.changes === 0) {
    await db.run(
      `INSERT OR IGNORE INTO price_history (card_id, price, recorded_at)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now', '+1 millisecond'))`,
      [cardId, price]
    );
  }
  return true;
}

// Scryfall: "We only update prices for cards once per day. Fetching card data
// more frequently than 24 hours will not yield new prices."
// (https://scryfall.com/docs/api/rate-limits). Sweeping more often than daily
// is pure load for zero new data, so the sweep gates on this.
const PRICE_SWEEP_INTERVAL_MS = 1000 * 60 * 60 * 24;
// Every provider that sweeps needs an entry here, and an unknown key is treated as
// "do not sweep" — so a provider added to server.js but forgotten here goes quiet
// instead of loud: shouldSweepPrices returns false, the boot catch-up skips, and
// markPricesSwept no-ops.
const SWEEP_COLUMN = {
  mtg: 'mtg_prices_swept_at',
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
