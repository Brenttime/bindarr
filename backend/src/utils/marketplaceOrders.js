// Buy-from-marketplace order import: turn a ManaPool or TCGplayer order number
// into collection entries, the same way the Secret Lair importer turns a product
// card list into entries — resolve each line through the proven
// bulkFetchByIdentifier -> card_cache path, then file through the shared
// bulk-add core. The user picks the order; Bindarr does the rest.
//
// Why the two providers are built differently (verified against their live
// endpoints, see the probes in the commit that introduced this file):
//
//   ManaPool — has a real buyer-facing REST API. base https://manapool.com/api/v1,
//     auth is `X-ManaPool-Email` + `X-ManaPool-Access-Token` (a token generated
//     in the user's dashboard Integration settings). `GET /orders/{number}`
//     answers the order with `items[]` whose `product.single` carries
//     name/set/number/finish and `price_cents` + `quantity`. Unknown routes
//     under that base 404 with an HTML body; a bad token 401s with a JSON
//     {"status":401,"message":"User not found..."} — so the two failure
//     classes are tellable apart, which is what makes a server-side "Test"
//     button honest here.
//
//   TCGplayer — its public API is closed to new keys and every documented
//     order endpoint is `Stores_*` (seller-side, needs the store's own
//     bearer). There is NO buyer order-history API. What the logged-in site
//     itself calls is the private SPA gateway: `GET {base}/customers/{id}/orders`
//     (cookie-authenticated, `withCredentials`), discovered by mining the
//     site's shipped JS bundle — the shape is `{ data: [...orders] }` style
//     list. Because that is an UNVERIFIED private contract (it can change
//     without notice, and we could not exercise it without a logged-in
//     account), the TCGplayer path is deliberately forgiving: it probes the
//     id, the me-alias, and the list endpoint, tolerates either response
//     shape, and — when the shape is not recognizable — returns the observed
//     keys so the Settings panel can say exactly what came back instead of a
//     silent "no cards". It also accepts a paste-JSON escape hatch: the
//     browser's own network response for that call can be pasted and parsed
//     locally, so the feature keeps working even if the private contract
//     shifts. Cookies are the user's own session, entered once in Settings.
const crypto = require('crypto');

// --- endpoints (pinned; never user-supplied, so the saved credential can only
// ever be sent where the user themselves chose to send it) ---
const MANAPOOL_BASE = process.env.MANAPOOL_API_BASE || 'https://manapool.com/api/v1';
const TCG_GATEWAY_BASES = [
  process.env.TCG_ORDER_BASE, // single-base override for testing
].filter(Boolean).length ? [process.env.TCG_ORDER_BASE] : [
  'https://mpapi.tcgplayer.com/',
  'https://mpgateway.tcgplayer.com/',
];
const TCG_REFERER = 'https://www.tcgplayer.com/';
const HTTP_TIMEOUT_MS = Number(process.env.MARKETPLACE_TIMEOUT_MS || 16000);

// The legal collection.printing values (mirrors the CHECK constraint in db.js).
// Order lines call foil variants "Foil"/"Etched"; both map to Holofoil, the
// only foil treatment Magic cards actually have and the one the DB accepts.
const PRINTING_VALUES = ['Normal', 'Holofoil'];
const VALID_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// Line condition codes the two markets use, mapped onto our CHECK-constrained
// vocabulary. Anything unmapped (or absent) falls back to the caller's default
// rather than being invented.
const CONDITION_MAP = {
  NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DAM: 'Damaged',
  MT: 'Damaged', // ManaPool "mint taped" is a damage grade, not a near-mint one
  GP: 'Lightly Played',
  EXC: 'Near Mint', VG: 'Moderately Played', G: 'Heavily Played', P: 'Damaged', // TCGplayer grading
  'Near Mint': 'Near Mint', 'Lightly Played': 'Lightly Played', 'Moderately Played': 'Moderately Played',
  'Heavily Played': 'Heavily Played', Damaged: 'Damaged',
};
function mapCondition(raw, fallback = 'Near Mint') {
  if (raw == null || raw === '') return fallback;
  const s = String(raw).trim();
  return CONDITION_MAP[s] || CONDITION_MAP[s.toUpperCase()] || fallback;
}
function isFoilish(item) {
  const flag = item.isFoil ?? item.foil ?? item.is_foil;
  if (flag === true || flag === 1 || flag === '1') return true;
  const finish = String(item.finish || item.printing || item.edge || '').toLowerCase();
  const name = String(item.name || item.productName || '').toLowerCase();
  if (/holofoil|etched|showcase|textless|overlay|borderless/.test(`${finish} ${name}`)) return true;
  if (/\bfoil\b/.test(name) && !/non-?foil/.test(name)) return true; // standalone word only: "foil" alone is too weak
  if (finish.includes('foil') && !finish.includes('non')) return true;
  return false;
}
// A sold card's unit price. ManaPool quotes cents (price_cents); TCGplayer's
// gateway uses dollars. Deciding on the VALUE's magnitude rather than trusting
// the field name is deliberate: a caller that mixes the two (or a gateway that
// changes dialect) then mis-prices by 100x in a way that reads as a bug —
// anything over $500 a card almost certainly is not, so that field is cents.
function unitPriceCents(item) {
  const cents = item.price_cents ?? item.priceCents ?? item.unit_price_cents;
  const dollars = item.price ?? item.unitPrice ?? item.pricePaid ?? item.unit_price;
  if (cents != null && Number.isFinite(Number(cents)) && Number(cents) >= 0) return Math.round(Number(cents));
  if (dollars == null || !Number.isFinite(Number(dollars)) || Number(dollars) < 0) return null;
  const d = Number(dollars);
  return d > 500 ? Math.round(d) : Math.round(d * 100);
}

// --- credentials normalisation -------------------------------------------------
// Cookies arrive either as a raw `Cookie:` header string or as a JSON array of
// {name,value,domain?} objects (what a browser export/extension hands over).
// Both normalise to a clean header string; junk that could not be read
// through is rejected rather than half-stored, because a broken cookie jar is
// indistinguishable from an expired one at fetch time.
function normalizeCookies(input) {
  if (typeof input !== 'string' || !input.trim()) {
    if (Array.isArray(input)) {
      const pairs = input
        .filter((c) => c && typeof c.name === 'string' && c.name && typeof c.value === 'string')
        .map((c) => `${c.name.trim()}=${c.value.trim()}`);
      return pairs.length ? pairs.join('; ') : null;
    }
    return null;
  }
  const raw = input.replace(/[\r\n]+/g, ' ').trim();
  if (raw.startsWith('cookie:') || raw.toLowerCase().startsWith('cookie:')) {
    // A pasted `Cookie:` header line is the whole jar, not a cookie pair; the
    // prefix itself would poison the very header we're assembling.
    return normalizeCookies(raw.replace(/^cookie:\s*/i, ''));
  }
  const pairs = raw.split(';').map((p) => p.trim()).filter((p) => p && p.includes('=') && !p.includes('\0'));
  const clean = pairs.map((p) => {
    const i = p.indexOf('=');
    return `${p.slice(0, i).trim()}=${p.slice(i + 1).trim()}`;
  });
  // De-dupe by name, last write wins (a re-export repeats names).
  const byName = new Map();
  for (const c of clean) byName.set(c.slice(0, c.indexOf('=')), c);
  const joined = [...byName.values()].join('; ');
  return joined.length && joined.length <= 64 * 1024 ? joined : null;
}
function cookieCount(cookies) {
  if (!cookies) return 0;
  return cookies.split(';').filter((p) => p.trim() && p.includes('=')).length;
}
// Never echo a token back over GET (the UI shows "configured?" state instead),
// and mask the account email so a shared screen/screenshot cannot leak it.
function maskSecret(s) {
  const str = String(s || '');
  if (!str) return '';
  if (str.length <= 8) return '••••';
  return `${str.slice(0, 3)}…${str.slice(-4)} (${str.length} chars)`;
}
function maskEmail(email) {
  const str = String(email || '');
  const at = str.indexOf('@');
  if (at < 1) return str ? `${str.slice(0, 1)}…` : '';
  const [user, domain] = [str.slice(0, at), str.slice(at + 1)];
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(8, user.length - 2)))}@${domain}`;
}
// The gateway wants a customer id; the SPA keeps it in a same-origin cookie,
// so we can often discover it without the user. Try the obvious cookie names
// before any network call (a cheap win when they exist).
function customerIdHints(cookies) {
  const out = [];
  for (const pair of String(cookies || '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const name = pair.slice(0, i).trim().toLowerCase();
    const value = pair.slice(i + 1).trim();
    if (value && /^(tcg_)?(customer|customerid|cust_id|customer_id|person|member|buyer|party|account)([_-]?id)?$/i.test(name)) {
      out.push(value);
    }
  }
  return [...new Set(out)].slice(0, 5);
}

// --- order fetch ----------------------------------------------------------------
// Both fetchers share the shape: return the parsed JSON body plus enough
// context for the route's error copy. `validateStatus: () => false` so we can
// read the body of a 401/404 and tell a bad credential from a bad order number
// — an honest error is worth more than a status code.
async function httpGet(url, headers = {}) {
  const axios = require('axios');
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Bindarr', Accept: 'application/json', ...headers },
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 3,
      validateStatus: () => true,
    });
    let body = res.data;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = { raw: body }; }
    }
    return { status: res.status, body };
  } catch (err) {
    throw Object.assign(new Error(`Marketplace request failed: ${err.message}`), { status: 502, cause: err });
  }
}

async function fetchManapoolOrder({ email, token, orderNumber, httpGet: http = httpGet }) {
  if (!email || !token) throw Object.assign(new Error('ManaPool credentials are not configured'), { status: 400 });
  const num = String(orderNumber || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(num)) throw Object.assign(new Error('Order number is not valid'), { status: 400 });
  const headers = { 'X-ManaPool-Email': email, 'X-ManaPool-Access-Token': token };
  const first = await http(`${MANAPOOL_BASE}/orders/${encodeURIComponent(num)}`, headers);
  // An auth rejection is an auth problem, not an empty order: saying "we could
  // not find order X" when the token is dead sends the user hunting for a typo
  // in the wrong field. Short-circuit here so the message names the credential.
  if (first.status === 401 || first.status === 403) {
    throw Object.assign(new Error('ManaPool rejected the saved credentials. Check the account email and the access token under ManaPool → account → Integration settings, then save them again.'), { status: 401 });
  }
  if (first.status === 429) {
    throw Object.assign(new Error('ManaPool is rate-limiting this account right now (too many requests or too much traffic). Wait a minute and try again.'), { status: 429 });
  }
  // The buyer-list route is the documented one; the bare detail route answers
  // 404 HTML there while the number-shaped detail route is the live one — try
  // the buyer form second so either dialect works, and only after BOTH miss is
  // it an unknown number. (401/403 short-circuits first: those are auth.)
  if (first.status === 404) {
    const second = await http(
      `${MANAPOOL_BASE}/orders/buyer/${encodeURIComponent(num)}`,
      { ...headers, Referer: 'https://manapool.com/account/orders' },
    );
    return merge(first, second);
  }
  return merge(first, first);
}
function merge(preferred, fallback) {
  const ok = (r) => r && r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object';
  if (ok(preferred)) return preferred;
  if (ok(fallback) && fallback !== preferred) return fallback;
  return preferred && preferred.status ? preferred : fallback;
}

async function fetchTcgOrder({ cookies, customerId, orderNumber, httpGet: http = httpGet }) {
  if (!cookies) throw Object.assign(new Error('TCGplayer session cookie is not configured'), { status: 400 });
  const num = String(orderNumber || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(num)) throw Object.assign(new Error('Order number is not valid'), { status: 400 });
  const headers = { Cookie: cookies, Referer: TCG_REFERER };
  const ids = [customerId, ...customerIdHints(cookies)].filter(Boolean);
  const seen = new Set();
  let last = null;
  for (const base of TCG_GATEWAY_BASES) {
    const paths = [];
    for (const id of ids) {
      if (!seen.has(String(id))) { seen.add(String(id)); paths.push(`customers/${encodeURIComponent(id)}/orders`); }
    }
    paths.push('customers/me/orders');
    for (const p of paths) {
      const url = `${base}${p}${p.includes('?') ? '&' : '?'}per_page=200&page=1`;
      const r = await http(url, headers);
      last = r;
      if (r.status >= 200 && r.status < 300 && looksLikeOrderList(r.body)) return { ...r, path: p };
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error('TCGplayer rejected the saved cookies (session expired or password-protected). Re-export them from a logged-in browser and save them again in Settings.'), { status: 401 });
      }
      // A gateway that 404s this path just does not speak it; keep looking.
    }
  }
  if (last && last.status >= 200 && last.status < 300) {
    // 2xx but not a recognisable list — report what DID come back rather than
    // a bare "no orders", so the private-contract drift is visible.
    return { ...last, unrecognised: true, keys: bodyKeys(last.body) };
  }
  throw Object.assign(new Error(`TCGplayer did not return an order list (last status ${last ? last.status : 'none'}).`), { status: 502 });
}
function bodyKeys(body) {
  if (!body || typeof body !== 'object') return [];
  const keys = Object.keys(body);
  return keys.length <= 25 ? keys : [...keys.slice(0, 25), `(+${keys.length - 25} more)`];
}
// One row proves the shape: an array of order-ish objects, under any of the
// keys the gateway/SPA dialects put their list under.
function looksLikeOrderList(body) {
  if (Array.isArray(body)) return body.length > 0 && body.every((o) => o && typeof o === 'object');
  if (!body || typeof body !== 'object') return false;
  for (const k of ['data', 'orders', 'results', 'items', 'list', 'records', 'orderResults']) {
    const v = body[k];
    if (Array.isArray(v) && v.length && v.every((o) => o && typeof o === 'object')) return true;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v.data || v.orders || v.results;
      if (Array.isArray(inner) && inner.length && inner.every((o) => o && typeof o === 'object')) return true;
    }
  }
  return false;
}
function orderArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const k of ['data', 'orders', 'results', 'items', 'list', 'records', 'orderResults']) {
    const v = body[k];
    if (Array.isArray(v) && v.length && v.every((o) => o && typeof o === 'object')) return v;
    if (v && typeof v === 'object') {
      const inner = v.data || v.orders || v.results;
      if (Array.isArray(inner) && inner.length) return inner;
    }
  }
  return [];
}

// --- normalising one order's lines ---------------------------------------------
// Both providers arrive as: a header (number/date/status/prices) + line items.
// We keep only what the filing path needs and drop the rest (addresses, payment
// methods, tracking — none of that belongs in a collection tool, and holding
// it in memory/server logs would be pure PII sprawl).
function pick(obj, names) {
  for (const n of names) {
    if (obj && obj[n] != null && obj[n] !== '') return obj[n];
  }
  return null;
}
const LINE_KEYS = ['items', 'lineItems', 'line_items', 'products', 'orderItems', 'cards', 'contents', 'entries'];

// Flatten the nested product forms the two markets use: ManaPool puts the card
// under `product.single` (or `.sealed`), TCGplayer rows carry `card`/`sku` or
// the `single` form directly. Returns the product object to read identity off
// and the wider row that carries quantity/price/condition.
function eachProductLines(item) {
  const p = item.product;
  if (p && typeof p === 'object') {
    const s = p.single || p.sealed || p.product || p;
    if (s && typeof s === 'object') return [s, p];
  }
  for (const k of ['card', 'single', 'sku', 'printing']) {
    if (item[k] && typeof item[k] === 'object') return [item[k], item];
  }
  return [item, item];
}

// Is this a sealed product (or accessory) rather than an individual card? The
// user asked for the ENDLINES of an order — the cards themselves — not booster
// boxes and storage gizmos, which come back as "products" with no card
// identity. Sealed detections are counted and reported, never filed as cards,
// unless the caller explicitly asked for extras.
const SEALED_KINDS = ['sealed', 'bundle', 'box', 'case', 'display', 'accessory', 'accessories', 'supplies'];
function isSealedLine(prod, item) {
  const kind = String(pick(prod, ['kind', 'product_type', 'productType', 'type', 'category'])
    ?? pick(item, ['kind', 'product_type', 'productType', 'type', 'category']) ?? '').toLowerCase();
  const sealedFlag = pick(prod, ['is_sealed', 'isSealed', 'sealed']) ?? pick(item, ['is_sealed', 'isSealed', 'sealed']);
  if (sealedFlag === true || sealedFlag === 1 || sealedFlag === '1') return true;
  if (SEALED_KINDS.includes(kind)) return true;
  const name = String(pick(prod, ['name', 'title']) ?? pick(item, ['name', 'productName']) ?? '').toLowerCase();
  if (/\b(sealed|booster|bundle|display|case|brick)\b/.test(name)) return true;
  if (/\bbox(es)?\b|binder|sleeves|protector|playmat|deck box|storage/i.test(name)
      && !pick(prod, ['scryfallId', 'scryfall_id', 'tcgplayerProductId', 'product_id'])
      && !pick(prod, ['set', 'setCode', 'set_code'])) return true;   // accessory with no card identity
  return false;
}

function orderLines(raw, opts = {}) {
  const includeExtras = opts.includeExtras === true;
  const src = raw && typeof raw === 'object' ? raw : {};
  let lines = [];
  for (const k of LINE_KEYS) {
    if (Array.isArray(src[k]) && src[k].length && src[k].every((x) => x && typeof x === 'object')) { lines = src[k]; break; }
  }
  if (!lines.length && Array.isArray(src.orderItems)) lines = src.orderItems;
  const out = [];
  let extras = 0;
  for (const item of lines) {
    const [prod, ctx] = eachProductLines(item);
    // A single sold card can be spread across forms; check both the row and the
    // product for sealed markers before believing it is a card.
    const sealedLine = isSealedLine(prod, item);
    if (sealedLine) { extras += 1; if (!includeExtras) continue; }
    const name = String(pick(prod, ['name', 'cardName', 'title']) || pick(item, ['name', 'productName', 'description']) || '').trim();
    const set = pick(prod, ['set', 'setCode', 'set_code', 'expansion', 'expansionName']) || pick(item, ['set', 'setCode']);
    const number = pick(prod, ['number', 'collectorNumber', 'cardNumber', 'collector_number']) ?? pick(item, ['number', 'collectorNumber']);
    const qty = Number(pick(item, ['quantity', 'qty', 'count', 'quantityFulfilled']) ?? pick(prod, ['quantity']) ?? 1);
    const cents = unitPriceCents(item) ?? unitPriceCents(prod);
    const scryfall = pick(prod, ['scryfallId', 'scryfall_id']) || pick(item, ['scryfallId']) || null;
    const tcgIdRaw = pick(prod, ['tcgplayerProductId', 'tcgplayer_product_id', 'product_id', 'id'])
      ?? pick(item, ['tcgplayerProductId', 'product_id']);
    // With no name and no identity at all, there is nothing to resolve: report
    // it unresolved rather than file a blank row.
    let junkLine = false;
    if (!name && !scryfall && !(set && number) && !(tcgIdRaw != null && /^\d+$/.test(String(tcgIdRaw)))) {
      junkLine = true; extras += 1; if (!includeExtras) continue;
    }
    out.push({
      name,
      set_code: set ? String(set).trim().toLowerCase() : null,
      number: number != null && number !== '' ? String(number).trim() : null,
      scryfall_id: scryfall,
      tcgplayer_product_id: tcgIdRaw != null && /^\d+$/.test(String(tcgIdRaw)) ? String(tcgIdRaw) : null,
      quantity: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
      price_cents: cents,
      is_foil: isFoilish(item) || isFoilish(prod),
      condition: mapCondition(pick(item, ['condition', 'conditionCode', 'grade', 'conditionText']) ?? pick(prod, ['condition', 'conditionCode'])),
      year: pick(prod, ['year', 'printed_year', 'printedYear']) || null,
      // Whether this line is a card at all. A sealed box is a real line the user
      // may choose to file, but it is not a card: it must not be counted as one,
      // and it must not be described as a card that failed to match.
      sealed: sealedLine,
      junk: junkLine,
    });
  }
  out.__extras = extras;
  // Copies on card lines only. `out.length` counts everything the caller asked
  // to keep, which with sealed included would let a booster box inflate a
  // "N copies" card tally.
  out.__cardCopies = out.reduce((n, l) => n + (l.sealed || l.junk ? 0 : (l.quantity || 1)), 0);
  out.__cardLines = out.filter((l) => !l.sealed && !l.junk).length;
  return out;
}
// One order-detail object normalised (both providers, list or detail form).
function parseOrderPayload(body, wantNumber, opts = {}) {
  const list = orderArray(body);
  const direct = body && typeof body === 'object' && !Array.isArray(body)
    && LINE_KEYS.some((k) => Array.isArray(body[k]) && body[k].length);
  let order = null;
  if (direct) order = body;
  else if (list.length) {
    const num = String(wantNumber || '').trim();
    order = list.find((o) => orderNumberMatches(o, num)) || (num ? null : list[0]);
  }
  if (!order) {
    const err = new Error('The order response did not include any usable line items.');
    err.status = 422;
    err.observedKeys = bodyKeys(body);
    throw err;
  }
  const lines = orderLines(order, opts);
  return {
    number: String(pick(order, ['number', 'orderNumber', 'order_number', 'id', 'orderId']) ?? wantNumber ?? '').trim() || null,
    placedAt: pick(order, ['created', 'createdAt', 'created_at', 'date', 'placedAt', 'orderDate']) || null,
    status: pick(order, ['status', 'orderStatus', 'fulfillmentStatus', 'fulfillment_status']) || null,
    currency: pick(order, ['currency', 'currencySymbol']) || null,
    total_cents: pick(order, ['total_cents', 'totalCents', 'total', 'orderTotal']) ?? pick(order.payment, ['total_cents', 'subtotal_cents']) ?? null,
    lines,
    lineCount: lines.length,
  };
}
function orderNumberMatches(order, want) {
  if (!want) return true;
  const cands = [];
  for (const k of ['number', 'orderNumber', 'order_number', 'friendly_id', 'friendlyId', 'name', 'id', 'orderId', 'order_id', 'key', 'reference']) {
    if (order[k] != null) cands.push(String(order[k]));
  }
  const norm = want.replace(/^#/, '').trim().toLowerCase();
  return cands.some((c) => c.toLowerCase() === norm || c.toLowerCase() === `#${norm}` || c.toLowerCase() === `order-${norm}`);
}

// --- the collection write -------------------------------------------------------
// The filing path is the SAME bulk-add core the tray and Secret Lair importer
// use; entries carry per-card quantity/price overrides so a multi-copy order
// line files as one stack at the right unit price instead of N inserts. The
// core merges shared condition/printing/language under the per-entry fields
// (collection.js:546), which is exactly what order lines need.
async function addOrderToCollection({ user, lines, condition, printingMode = 'auto', language = 'English', copies = 1, deps: depsOption = {} } = {}, depsArg = {}) {
  // `previewOrder` takes its injected collaborators as a SECOND argument; this
  // function historically took them inside the options object. Accept both, with
  // the positional form winning, because an asymmetric signature is a footgun: a
  // caller who passes `{...} , deps` here would have their stubs silently
  // ignored and the util would reach for the real network/db instead of failing
  // — which reads as "the test passed" while nothing was actually injected.
  const deps = { ...depsOption, ...depsArg };
  if (!user || !user.id) throw Object.assign(new Error('user required'), { status: 400 });
  if (!Array.isArray(lines) || !lines.length) return { added: 0, failed: [], resolved: 0, totalListed: 0, unresolved: 0, message: 'No cards to add' };
  const resolve = deps.bulkResolve || require('../scryfallApi').bulkFetchByIdentifier;
  const cache = deps.cacheCards || require('./cardCache').cacheNormalizedCards;
  const bulk = deps.bulkAdd || require('../routes/collection').bulkAddToCollection;
  if (typeof bulk !== 'function') throw Object.assign(new Error('bulk add service unavailable'), { status: 500 });

  const cond = VALID_CONDITIONS.includes(condition) ? condition : 'Near Mint';
  const mult = Math.max(1, Math.min(Number(copies) || 1, 500));

  // Collapse duplicate printings of the same line (a deck list can name the
  // same card twice) before resolving, then file with each line's own count.
  const uniq = new Map();
  for (const l of lines) {
    // A sealed box or an identity-less row has no card to file. It stays in the
    // order tally (so the order never looks short) but never reaches the
    // collection as a card that "failed to match" — those lines are not cards.
    if (l.sealed === true || l.junk === true) continue;
    const key = l.scryfall_id
      ? `i:${l.scryfall_id.toLowerCase()}`
      : `n:${String(l.name).toLowerCase()}|${String(l.set_code || '').toLowerCase()}|${String(l.number || '').toLowerCase()}|${l.is_foil ? 'f' : 'n'}`;
    if (uniq.has(key)) { uniq.get(key).quantity += l.quantity; continue; }
    uniq.set(key, { ...l });
  }
  const rows = [...uniq.values()].map((l) => ({
    id: l.scryfall_id || undefined,
    set_id: l.set_code || undefined,
    number: l.number || undefined,
    name: l.name || undefined,
    _line: l,
  }));

  // When the caller did not ask for extras, the sealed/accessory lines were
  // already dropped by orderLines; carry their count so the UI can say "3
  // non-card line(s) ignored" instead of the user wondering if the order was
  // read short. The card count shown is the cards, never the padded total.
  const extrasHeld = Number(lines.__extras || 0);
  const { cards, pairs, notFound } = await resolve(rows);
  if (cards && cards.length) await cache(cards);

  const plan = [];
  const seen = new Set();
  for (const p of pairs || []) {
    const card = p && p.card;
    if (!card || !card.id || seen.has(card.id)) continue;
    seen.add(card.id);
    const line = (p.row && p.row._line) || {};
    const printing = printingMode === 'foil' ? 'Holofoil'
      : printingMode === 'nonfoil' ? 'Normal'
        : (line.is_foil ? 'Holofoil' : 'Normal');
    plan.push({
      card_id: card.id,
      quantity: Math.max(1, Math.round((line.quantity || 1) * mult)),
      printing,
      purchase_price: line.price_cents != null ? Number((Number(line.price_cents) / 100).toFixed(2)) : undefined,
      condition: line.condition && VALID_CONDITIONS.includes(line.condition) ? line.condition : cond,
    });
  }
  let added = 0;
  const failed = [];
  for (const printing of ['Normal', 'Holofoil']) {
    const group = plan.filter((e) => e.printing === printing);
    if (!group.length) continue;
    const res = await bulk(user, group, { condition: cond, printing, language, stackable: true });
    added += (res && res.added ? res.added.length : 0);
    if (res && res.failed) failed.push(...res.failed);
  }
  return {
    added,
    failed,
    resolved: plan.length,
    // "What the order contained", including the non-card lines that were held
    // out of the file-in. Reporting only the card rows would make a sealed-heavy
    // order look like it came up short, which is exactly the doubt this number
    // exists to answer; `resolved` is the card-only count next to it.
    totalListed: uniq.size + extrasHeld,
    // Only genuine card lines that the resolver could not identify count as
    // unresolved; sealed/accessory rows are reported by `extras`, not here.
    unresolved: notFound || 0,
  };
}


// Resolve an order's lines to real card_cache rows WITHOUT filing anything, so
// the UI can show art, names, matched/not-matched and totals before the user
// commits. Shares the resolver and the dedup key with addOrderToCollection on
// purpose: what the preview shows is exactly what the add will file, so a card
// that resolves here cannot fail to resolve there, and the count the user reads
// is the count that lands.
//
// Resolution rides bulkFetchByIdentifier (scryfallId -> set+number -> name), the
// same path the Secret Lair and precon importers use, so an order behaves like
// every other bulk add in the app: unmatched lines are reported, never faked.
async function previewOrder({ lines, userId, includeExtras = false }, deps = {}) {
  if (!Array.isArray(lines) || !lines.length) {
    return { cards: [], totalListed: 0, resolvedCount: 0, unresolved: 0, extras: 0, sealedCount: 0 };
  }
  const resolve = deps.bulkResolve || require('../scryfallApi').bulkFetchByIdentifier;
  const cache = deps.cacheCards || require('./cardCache').cacheNormalizedCards;
  const database = deps.db || require('../db');

  // Collapse the same printing named twice (a deck-list order can repeat a
  // card across sections) before resolving; carry the summed count for the row.
  const uniq = new Map();
  for (const l of lines) {
    // Not a card: kept for the order tally and the price total, but never sent
    // to the resolver, so a booster box cannot show up as a card you "own" or as
    // a line that failed to match.
    if (l.sealed === true || l.junk === true) continue;
    const key = l.scryfall_id
      ? `i:${String(l.scryfall_id).toLowerCase()}`
      : `n:${String(l.name || '').toLowerCase()}|${String(l.set_code || '').toLowerCase()}|${String(l.number || '').toLowerCase()}|${l.is_foil ? 'f' : 'n'}`;
    if (uniq.has(key)) { uniq.get(key).quantity += l.quantity; continue; }
    uniq.set(key, { ...l });
  }
  // The row doubles as the identity handle: the resolver echoes the exact object
  // it was handed back on pairs[].row, so hanging the line off it survives the
  // round trip and reads back by object identity — no fragile re-keying of a
  // resolver that may normalise case or pick a different identifier.
  const rows = [...uniq.values()].map((l) => ({
    id: l.scryfall_id || undefined,
    set_id: l.set_code || undefined,
    number: l.number || undefined,
    name: l.name || undefined,
    _line: l,
  }));

  // When the caller did not ask for extras, the sealed/accessory lines were
  // already dropped by orderLines; carry their count so the UI can say "3
  // non-card line(s) ignored" instead of the user wondering if the order was
  // read short. The card count shown is the cards, never the padded total.
  const extrasHeld = Number(lines.__extras || 0);
  const { cards, pairs, notFound } = await resolve(rows);
  if (cards && cards.length) await cache(cards);

  const resolved = [];
  const seen = new Set();
  for (const p of pairs || []) {
    const card = p && p.card;
    if (!card || !card.id || seen.has(card.id)) continue;
    seen.add(card.id);
    const line = (p.row && p.row._line) || {};
    resolved.push({
      card_id: card.id,
      name: card.name || line.name || '',
      image_url: card.image_url || null,
      set_code: card.set_id || line.set_code || null,
      number: card.number != null ? String(card.number) : (line.number || null),
      quantity: line.quantity || 1,
      is_foil: Boolean(line.is_foil),
      condition: line.condition || null,
      price_cents: line.price_cents != null ? line.price_cents : null,
      matched: true,
    });
  }

  // Ownership, the way the Secret Lair preview counts it: SUM(quantity) grouped
  // per card_id for THIS user only (never COUNT(rows) — a stack is one row), so
  // the UI can badge "you already have 3 of these" before an add.
  let owned = new Map();
  if (userId && resolved.length) {
    const ids = resolved.map((r) => r.card_id).filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rowsOwned = await database.all(
        `SELECT card_id, SUM(quantity) AS qty FROM collection
          WHERE user_id = ? AND card_id IN (${placeholders})
          GROUP BY card_id`,
        [userId, ...ids]
      );
      for (const r of rowsOwned) owned.set(String(r.card_id).toLowerCase(), Number(r.qty) || 0);
    }
  }

  const totalCopies = [...uniq.values()].reduce((n, l) => n + (l.quantity || 1), 0);
  const cents = lines.reduce((n, l) => n + (l.price_cents != null ? l.price_cents * (l.quantity || 1) : 0), 0);
  return {
    cards: resolved.map((r) => ({ ...r, owned: owned.get(String(r.card_id).toLowerCase()) || 0 })),
    // Counted the same way the commit reports it: what the order listed, sealed
    // and accessories included, so `totalListed` = cards filed + held-out extras
    // and the summary line adds up in front of the user.
    totalListed: uniq.size + extrasHeld,
    totalCopies,
    resolvedCount: resolved.length,
    unresolved: (notFound || 0),
    extras: extrasHeld,
    sealedCount: extrasHeld,
    // Whether the user asked to keep the non-card lines. They are never FILED
    // either way (a booster box is not a card), but the wording the UI picks
    // depends on it: "left out" is wrong when the user deliberately included
    // them for the order total.
    extrasIncluded: !!includeExtras,
    price_cents: cents || null,
  };
}

module.exports = {
  MANAPOOL_BASE,
  normalizeCookies,
  cookieCount,
  maskSecret,
  maskEmail,
  customerIdHints,
  fetchManapoolOrder,
  fetchTcgOrder,
  parseOrderPayload,
  orderLines,
  mapCondition,
  isFoilish,
  unitPriceCents,
  addOrderToCollection,
  previewOrder,
};
