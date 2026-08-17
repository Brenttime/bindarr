const express = require('express');
const db = require('../db');
const tcgApi = require('../tcgApi');
const tcgdexApi = require('../tcgdexApi');
const scryfallApi = require('../scryfallApi');
const scanMatch = require('../scanMatch');
const setIndex = require('../setIndex');
const languages = require('../utils/languages');
const pokemonProvider = require('../utils/pokemonProvider');
const psaApi = require('../psaApi');
const gradedPrices = require('../gradedPrices');
const cardApi = require('../utils/cardApi');
const { authenticateToken, searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { parseSetList } = require('../utils/setQuery');
const { compartmentLabel, isBinderType, rebalanceCompartmentByScheme } = require('../utils/compartmentSort');
const { checkedOutAllocation, resolveCompartmentAndPosition, describePlacement, setStackQuantity } = require('../utils/collectionHelpers');
const { validateDeckAddition } = require('../utils/deckRules');
const { splitPrice } = require('../utils/splitPrice');

const router = express.Router();

router.use(authenticateToken);

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
async function attachOwnedQty(cards, userId) {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = 'collection' AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));
  for (const c of cards) c.owned_qty = owned.get(c.id) || 0;
}

// 1. Search cards (proxies to Pokémon TCG, Scryfall or TCGdex + database cache).
// `game` and the PROVIDER route the request; all three return the same card shape.
//
// Language alone is not enough, and getting that wrong is not cosmetic. TCGdex can
// serve English too, and when it is the selected provider the scan indexes are
// built from its catalogue — so a match hands back TCGdex set ids (swsh10.5,
// sv01, me01). Routing those to pokemontcg.io, which numbers the same sets pgo,
// sv1 and me1, finds nothing; the client then retries by name alone and gets some
// unrelated printing of the right card. On screen that is a card with the correct
// name, the wrong set and number, and frequently no art at all.
//
// So: non-English always goes to TCGdex (pokemontcg.io is English-only), and
// English follows whichever provider actually built the data being searched.
// That rule lives in utils/pokemonProvider — this only maps its answer to a module.
async function pokemonApiFor(lang) {
  return (await pokemonProvider.usesTcgdex(lang)) ? tcgdexApi : tcgApi;
}
router.get('/search', searchLimiter, async (req, res) => {
  const { name, number, set, scope = 'database', game = 'pokemon', lang, prints } = req.query;
  // 1-based page over `limit`-sized pages. 250 is the pokemontcg.io ceiling and
  // a sane cap on how much one Scryfall search will page through per request.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(req.query.limit, 10) || 60));
  try {
    let cards, total;
    if (game === 'mtg') {
      ({ cards, total } = await scryfallApi.searchCards(name, number, set, scope, req.user.id, lang, prints === '1', page, limit));
    } else {
      const provider = await pokemonApiFor(lang);
      // The two Pokémon providers do not share a signature: pokemontcg.io takes
      // the user's API key, TCGdex takes the language it is searching in.
      ({ cards, total } = provider === tcgdexApi
        ? await provider.searchCards(name, number, set, scope, req.user.id, lang || 'en', page, limit)
        : await provider.searchCards(name, number, set, req.user.tcg_api_key, scope, req.user.id, page, limit));
    }
    await attachOwnedQty(cards, req.user.id);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(cards);
  } catch (error) {
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 1a2. Identify a graded slab from the cert number printed on its label.
//
// Returns the cert AND a list of candidate cards — it does not pick one. PSA
// labels a card as 'CHARIZARD-HOLO' with year 1999 and brand 'POKEMON GAME',
// which names a card without identifying a printing: that name+number exists in
// Base Set, Base Set 2 and a dozen reprints, and PSA's label does not distinguish
// them. Auto-picking would file the wrong printing silently and confidently, so
// the user picks and the client then adds through POST /collection as usual with
// grader/grade/cert_number filled in.
//
// GET, and cheap on a repeat: psaApi caches every cert permanently, so re-checking
// a number costs no quota and works with no token configured.
// Path is spelled in full because this router mounts at /api, not at /api/collection
// — every route here carries its own complete path (see '/search' above).
router.get('/collection/cert/:certNumber', searchLimiter, async (req, res) => {
  try {
    const cert = await psaApi.lookupCert(req.params.certNumber, req.user.psa_api_token || '');
    // Which game to search is read off PSA's own brand/category text. Unknown means
    // unknown — PSA grades sports cards and tickets too, and guessing 'pokemon' for
    // a 1986 Fleer basketball card would return nonsense candidates rather than an
    // honest empty list.
    const brand = `${cert.brand || ''} ${cert.category || ''}`.toUpperCase();
    const game = /POKEMON/.test(brand) ? 'pokemon' : (/MAGIC|GATHERING/.test(brand) ? 'mtg' : null);
    let candidates = [];
    if (game) {
      const name = psaApi.searchableName(cert.subject);
      if (name) {
        // Number included when PSA gave one: it is the single strongest
        // discriminator between printings of the same name, and the search treats
        // it as optional so a label without one still returns something.
        const number = cert.card_number || '';
        if (game === 'mtg') {
          ({ cards: candidates } = await scryfallApi.searchCards(name, number, '', 'database', req.user.id, null, true, 1, 24));
        } else {
          const provider = await pokemonApiFor(null);
          ({ cards: candidates } = provider === tcgdexApi
            ? await provider.searchCards(name, number, '', 'database', req.user.id, 'en', 1, 24)
            : await provider.searchCards(name, number, '', req.user.tcg_api_key, 'database', req.user.id, 1, 24));
        }
        await attachOwnedQty(candidates, req.user.id);
      }
    }
    res.json({ cert, game, candidates });
  } catch (error) {
    // psaApi puts a caller-visible status on everything it throws; anything without
    // one is a genuine bug here rather than a bad cert number.
    const status = error.status || 500;
    if (status >= 500) console.error('cert lookup failed:', error.message);
    res.status(status).json({ error: status >= 500 ? 'Certification lookup failed' : error.message });
  }
});

// 1b. Identify a scanned card image by visual-feature match.
router.post('/scan-match', searchLimiter, async (req, res) => {
  try {
    const { game = 'pokemon', image, set = '', recallK, orb, lang } = req.body || {};
    if (game !== 'mtg' && game !== 'pokemon') return res.status(400).json({ error: 'Invalid game' });
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });
    const result = await scanMatch.match(buf, game, 8, set, { recallK, orb, lang });
    if (result.candidates && result.candidates.length > 0) {
      // Hydration is language-scoped: a Japanese scan matched a Japanese index, so
      // handing back the English row for the same set+number would name the card
      // correctly and then add the wrong printing to the collection.
      const langName = languages.toName(lang);
      // A hydrated row REPLACES the client's /api/search lookup — CameraScanner
      // takes a `top.card` fast path and applies it directly. So an unusable row
      // is strictly worse than no row at all: it suppresses the fetch that would
      // have produced a good one. A row with no artwork is exactly that, and it
      // is what a stale cache served here — the right name with no picture and no
      // number. Hydration is an optimisation; it must decline rather than degrade.
      const USABLE = `image_url IS NOT NULL AND image_url != ''`;
      const hydrated = await Promise.all(result.candidates.map(async (cand) => {
        let row = null;
        if (cand.set && cand.number) {
          // EXACT OR NOTHING. ORB identified a specific printing, and this row is
          // handed to the client as that printing — so a near-miss is not a
          // partial success, it is a different card wearing the right name.
          //
          // There used to be a name-only fallback here for when the exact lookup
          // missed. It fired constantly (any set whose rows are not cached yet)
          // and returned whichever printing of that name happened to be cached,
          // so the picker offered cards from sets ORB never matched while the
          // debug list above it showed the correct ones.
          //
          // Missing is fine: the client falls through to /api/search, which
          // fetches the exact set+number from the provider.
          row = await db.get(
            `SELECT * FROM card_cache WHERE game = ? AND language = ? AND (set_id = ? OR LOWER(set_name) = LOWER(?)) AND number = ? AND ${USABLE} LIMIT 1`,
            [result.game, langName, cand.set, cand.set, cand.number]
          );
        } else if (cand.name) {
          // Only when there is no identity to be exact about. Then the name is
          // all anyone has, and one printing of it beats nothing.
          row = await db.get(
            `SELECT * FROM card_cache
             WHERE game = ? AND language = ? AND (LOWER(name) = LOWER(?) OR LOWER(printed_name) = LOWER(?)) AND ${USABLE}
             LIMIT 1`,
            [result.game, langName, cand.name, cand.name]
          );
        }
        return row ? { ...cand, card: parseCardRow(row) } : cand;
      }));
      result.candidates = hydrated;
    }
    res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// Build/verify a per-set ORB index
router.post('/prepare-set', searchLimiter, async (req, res) => {
  try {
    const { game = 'mtg', set, lang } = req.body || {};
    const supported = game === 'mtg' || game === 'pokemon';
    const sets = parseSetList(set);
    if (!supported || !sets.length) return res.json({ ready: false, supported });
    const pending = sets.filter(s => !setIndex.isReady(game, s, lang));
    if (pending.length === 0) return res.json({ ready: true });

    // A set that cannot be built (no such set for this language, or the provider
    // has no card data for it) has to be reported, not polled forever. Without
    // this the client sat on "fetching card list" indefinitely while every poll
    // kicked off another doomed build.
    const failures = pending
      .map(s => ({ set: s, error: setIndex.buildFailed(game, s, lang) }))
      .filter(f => f.error);
    const buildable = pending.filter(s => !setIndex.buildFailed(game, s, lang));
    if (buildable.length === 0) {
      return res.json({ ready: false, building: false, failed: true, failures, error: failures[0].error });
    }

    // The set index this scan needs is also everything a code-free scan needs, so
    // folding it into the whole-game rollup afterwards costs no extra download —
    // it is scheduled in the background rather than made to wait for it.
    buildable.forEach(s => setIndex.ensureSet(game, s, lang)
      .then(ok => { if (ok) require('../globalIndex').scheduleRollupRefresh(game, lang); })
      .catch(() => {}));
    // Report the first still-building set's progress for the UI bar, plus any
    // sets in the list that already failed (a multi-set scan can be part ready).
    res.json({ ready: false, building: true, progress: setIndex.setProgress(game, buildable[0], lang), pending: buildable, failures });
  } catch (error) {
    console.error('prepare-set failed:', error.message);
    res.status(500).json({ error: 'Prepare set failed' });
  }
});

// Read-only scan-index coverage, for ANY logged-in user.
//
// This exists because a member scanning without a set code previously just got
// "no match" with no way to learn that the whole-game index was never built. The
// build actions stay admin-only; understanding why scanning cannot work does not
// need to be.
router.get('/scan-index-status', async (req, res) => {
  try {
    const { game = 'mtg', lang } = req.query;
    if (game !== 'mtg' && game !== 'pokemon') return res.status(400).json({ error: 'game (mtg|pokemon) is required' });
    const globalIndex = require('../globalIndex');
    const code = languages.toCode(lang);
    const status = globalIndex.statusOf(game, code);
    // Coverage hits the provider for the set list, so it is opt-in via ?coverage=1
    // — the readiness flags below answer the common question without a round trip.
    //
    // And it is best-effort. The readiness flags are read from local files and
    // cannot fail; coverage needs the provider's set list and can. Letting that
    // take the whole response down means a provider hiccup deletes the scanner's
    // "can I scan without a set code?" hint — reinstating, during an outage, the
    // exact silent failure this endpoint exists to prevent. The scanner already
    // treats a null coverage as "unknown" and falls back to the plain message.
    let coverage = null;
    if (req.query.coverage === '1') {
      try { coverage = await globalIndex.coverage(game, code); }
      catch (e) { console.warn(`scan-index-status: coverage unavailable for ${game} (${code}): ${e.message}`); }
    }
    res.json({
      game, lang: code,
      codeFreeScanning: status.orb.present && status.orb.hashed,
      cards: status.orb.cards || 0,
      builtAt: status.orb.builtAt || 0,
      coverage,
    });
  } catch (error) {
    console.error('scan-index-status failed:', error.message);
    res.status(500).json({ error: 'Failed to read scan index status' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        c.grader,
        c.grade,
        c.cert_number,
        c.market_value,
        c.market_value_source,
        c.market_value_at,
        cc.name,
        -- The localized name for a non-English printing, so every view that
        -- renders a collection card can show it as the card actually reads.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.price_1st_edition,
        cc.price_currency,
        cc.price_source,
        cc.game,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        cc.tcgplayer_product_id,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const alloc = await checkedOutAllocation(req.user.id);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
      sub_location: row.compartment_id
        ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
        : ''
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, compartment
// resolution, rebalance, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
class AddCardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Mirrors the collection.grader CHECK constraint in db.js. 'Raw' is the default
// and means an ungraded card, not a missing value.
const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG'];

async function addCardToCollection(user, body) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    list_type = 'collection',
    is_trade = 0,
    game = 'pokemon',
    stackable = false,
    grader = 'Raw',
    grade = null,
    cert_number = null
  } = body;
  const req = { user, body };

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }

  // Grading, validated here rather than at the two call sites, so the single add
  // and the bulk add cannot disagree about what a slab is.
  if (!GRADERS.includes(grader)) {
    throw new AddCardError(400, `Invalid grader. One of: ${GRADERS.join(', ')}`);
  }
  const gradeNum = grade == null || grade === '' ? null : Number(grade);
  if (gradeNum != null && !(gradeNum > 0 && gradeNum <= 10)) {
    throw new AddCardError(400, 'grade must be between 0 and 10');
  }
  const cert = cert_number ? String(cert_number).trim() : null;
  // A raw card has no grade and no cert by definition. Silently keeping either
  // would leave a row that reads as raw in one column and graded in another, and
  // every downstream check would then depend on which column it happened to read.
  const isGraded = grader !== 'Raw';
  const certValue = isGraded ? cert : null;
  const gradeValue = isGraded ? gradeNum : null;

  // Checked before the insert purely for the message: the unique index in db.js is
  // what actually enforces this, and still catches a race between two requests.
  // Without the check the user gets 'Failed to add card' and no idea why.
  if (certValue) {
    const dup = await db.get(
      `SELECT c.id, cc.name FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.grader = ? AND c.cert_number = ?`,
      [user.id, grader, certValue]
    );
    if (dup) {
      throw new AddCardError(409, `${grader} cert ${certValue} is already in your collection as ${dup.name}.`);
    }
  }

  {
    // A card matched by a set-scoped scan was cached from a TCGdex set brief:
    // name, number and art only. Fill it in before it enters the collection, or it
    // is stored with no price, no marketplace link and a defaulted rarity — which
    // is what it then shows in the inspector forever.
    await cardApi.hydrate(card_id);

    let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      card = await cardApi.getCardById(card_id, { game, tcgApiKey: req.user.tcg_api_key });
      if (!card) {
        throw new AddCardError(404, `Card ID ${card_id} not found.`);
      }
    }

    const effectiveGame = (req.body.game && req.body.game !== 'pokemon')
      ? req.body.game
      : (card.game || cardApi.gameOf(card_id));

    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        throw new AddCardError(400, 'Invalid location ID');
      }
    }

    const resolved = await resolveCompartmentAndPosition({
      locationId: location_id,
      userId: req.user.id,
      cardId: card_id,
      printing,
      language
    });

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    let lastInsertedId = null;
    // A cert number names ONE physical slab, so a quantity above 1 is not a
    // request for more of them — it is a mistake that the per-user unique index on
    // (grader, cert_number) would reject on the second insert anyway, after the
    // first had already been written. Collapse it here so the request succeeds with
    // the row the user actually meant.
    const count = certValue ? 1 : Math.max(1, parseInt(quantity, 10) || 1);
    // Stacking is quantity-on-one-row, which is meaningful only for interchangeable
    // copies. Two slabs are never interchangeable: they have different certs, and
    // usually different grades.
    const stack = stackable && !isGraded;

    if (stack) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, list_type, game,
          grader, grade, cert_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card_id, req.user.id, count, condition, printing, language, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type, effectiveGame,
        grader, gradeValue, certValue
      ]);
      lastInsertedId = result.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const result = await db.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, language, purchase_price,
            location_id, compartment_id, position, is_trade, list_type, game,
            grader, grade, cert_number
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          card_id, req.user.id, condition, printing, language, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type, effectiveGame,
          grader, gradeValue, certValue
        ]);
        lastInsertedId = result.lastID;
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        await rebalanceCompartmentByScheme(db, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    await recordPrice(card_id, card.price_trend);

    return {
      message: 'Card added to collection',
      id: lastInsertedId,
      placement: resolved.compartment_id
        ? await describePlacement(db, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full,
      rule_rejected: !!resolved.rejected
    };
  }
}

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  try {
    res.status(200).json(await addCardToCollection(req.user, req.body));
  } catch (error) {
    if (error instanceof AddCardError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
router.post('/collection/bulk-add', async (req, res) => {
  const { card_ids = [], ...shared } = req.body;
  if (!Array.isArray(card_ids) || card_ids.length === 0) {
    return res.status(400).json({ error: 'card_ids is required' });
  }
  if (card_ids.length > BULK_ADD_MAX) {
    return res.status(400).json({ error: `Cannot add more than ${BULK_ADD_MAX} cards at once.` });
  }
  // Every field in `shared` is applied to every card, which a cert number cannot
  // survive: it identifies one slab. Rejected rather than dropped, because silently
  // discarding it would add the cards ungraded and look like it worked.
  if (shared.cert_number) {
    return res.status(400).json({ error: 'A certification number applies to a single card. Add graded cards one at a time.' });
  }
  // Sequential on purpose: placement resolves against the rows already inserted,
  // so adds must not race each other for the same compartment slot.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError)) console.error(error);
      failed.push({ card_id, error: error instanceof AddCardError ? error.message : 'Failed to add card' });
    }
  }
  const qty = Math.max(1, parseInt(shared.quantity, 10) || 1);
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty > 1 ? ` (x${qty} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, language, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, game, notes,
    grader, grade, cert_number, market_value
  } = req.body;

  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const isMoving = location_id !== undefined && location_id !== entry.location_id;
    let finalCompartmentId = entry.compartment_id;
    let finalLocationId = entry.location_id;
    let finalPosition = entry.position;
    let resolvedFull = false;
    let resolvedRejected = false;

    if (isMoving) {
      if (location_id === null || location_id === '') {
        finalLocationId = null;
        finalCompartmentId = null;
        finalPosition = 0;
      } else {
        const resolved = await resolveCompartmentAndPosition({
          locationId: location_id,
          userId: req.user.id,
          cardId: entry.card_id,
          printing: printing !== undefined ? printing : entry.printing,
          language: language !== undefined ? language : entry.language
        });
        finalCompartmentId = resolved.compartment_id;
        finalLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;
        finalPosition = resolved.position;
        resolvedFull = !!resolved.full;
        resolvedRejected = !!resolved.rejected;
      }
    } else if (compartment_id !== undefined) {
      finalCompartmentId = compartment_id;
    }

    const updates = [];
    const params = [];

    // Absolute, not additive: see the reconcile below. Deliberately NOT part of
    // the UPDATE — setStackQuantity owns the quantity column so the two can
    // never disagree about how many copies the row stands for.
    const requestedQty = quantity !== undefined ? Math.max(1, parseInt(quantity, 10) || 1) : null;
    if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { updates.push('printing = ?'); params.push(printing); }
    if (language !== undefined) { updates.push('language = ?'); params.push(language); }
    if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
    if (isMoving || compartment_id !== undefined) {
      updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
      params.push(finalLocationId, finalCompartmentId, finalPosition);
    }
    if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
    if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
    if (game !== undefined) { updates.push('game = ?'); params.push(game); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    // Grading. The three columns move together on purpose: sending grader:'Raw'
    // must clear the grade and cert in the same statement, or the row keeps a grade
    // it no longer claims to have. Cracking a slab is a real thing people do.
    if (grader !== undefined) {
      if (!GRADERS.includes(grader)) return res.status(400).json({ error: `Invalid grader. One of: ${GRADERS.join(', ')}` });
      const raw = grader === 'Raw';
      const g = raw || grade == null || grade === '' ? null : Number(grade);
      if (g != null && !(g > 0 && g <= 10)) return res.status(400).json({ error: 'grade must be between 0 and 10' });
      const cert = raw || !cert_number ? null : String(cert_number).trim();
      if (cert) {
        const dup = await db.get(
          `SELECT id FROM collection WHERE user_id = ? AND grader = ? AND cert_number = ? AND id != ?`,
          [req.user.id, grader, cert, id]
        );
        if (dup) return res.status(409).json({ error: `${grader} cert ${cert} is already in your collection.` });
      }
      updates.push('grader = ?', 'grade = ?', 'cert_number = ?');
      params.push(grader, g, cert);
    }
    // What this copy is worth, typed by the owner. Empty string and null both mean
    // "drop it and go back to the provider price" — the field is a text input, and
    // clearing it has to be possible or a mistyped 10000 is permanent.
    if (market_value !== undefined) {
      if (market_value === null || market_value === '') {
        updates.push('market_value = ?', 'market_value_source = ?', 'market_value_at = ?');
        params.push(null, null, null);
      } else {
        const value = Number(market_value);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ error: 'market_value must be a number of 0 or more' });
        }
        updates.push('market_value = ?', 'market_value_source = ?', "market_value_at = CURRENT_TIMESTAMP");
        params.push(value, 'manual');
      }
    }

    if (updates.length > 0) {
      params.push(id, req.user.id);
      await db.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    if (isMoving && finalCompartmentId && finalLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
      if (loc) await rebalanceCompartmentByScheme(db, finalCompartmentId, loc.sort_order, loc.foil_sorting);
    }
    if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
      const oldLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
      if (oldLoc) await rebalanceCompartmentByScheme(db, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
    }

    // Quantity is absolute — it is how many copies the user says they own, and
    // in the stacked collection view the number in the form is the total across
    // the identical rows, not this row alone. So reconcile the whole stack to
    // it, up or down. It used to only ever insert (quantity - 1) extra rows,
    // which made lowering the number a no-op and made every save duplicate the
    // entry instead of editing it.
    if (requestedQty !== null) {
      const changed = await setStackQuantity(db, req.user.id, id, requestedQty);
      if (changed !== 0) {
        const row = await db.get(`SELECT compartment_id, location_id FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (row && row.compartment_id && row.location_id) {
          const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, req.user.id]);
          if (loc) await rebalanceCompartmentByScheme(db, row.compartment_id, loc.sort_order, loc.foil_sorting);
        }
      }
    }

    const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(db, id, req.user.id) : null;
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4a. Fetch this copy's graded value from the price provider and store it.
//
// Deliberately one entry per request and never automatic: the free tier of the
// only provider that publishes slab prices is metered per day, and a sweep over a
// collection would spend a week's allowance in one boot. The button is the budget.
router.post('/collection/:id/market-value/fetch', searchLimiter, async (req, res) => {
  try {
    const entry = await db.get(`
      SELECT c.id, c.grade, c.grader, cc.name, cc.set_name, cc.number, cc.game, cc.tcgplayer_product_id
      FROM collection c JOIN card_cache cc ON cc.id = c.card_id
      WHERE c.id = ? AND c.user_id = ?`, [req.params.id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });
    if (!entry.grader || entry.grader === 'Raw') {
      return res.status(400).json({ error: 'This copy is not graded. Graded prices apply to slabs only.' });
    }

    const result = await gradedPrices.fetchGradedPrice({
      game: entry.game,
      name: entry.name,
      setName: entry.set_name,
      number: entry.number,
      grader: entry.grader,
      grade: entry.grade,
      // The exact-card lookup: one card returned instead of a page of them, which
      // is the difference between 2 credits and a hundred.
      tcgPlayerId: entry.tcgplayer_product_id,
      apiKey: req.user.graded_price_api_key,
    });

    await db.run(
      `UPDATE collection SET market_value = ?, market_value_source = ?, market_value_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [result.price, result.source, req.params.id, req.user.id]
    );
    res.json({ market_value: result.price, source: result.source, basis: result.basis });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('graded price fetch failed:', error.message);
    res.status(status).json({ error: error.message || 'Failed to fetch graded price' });
  }
});

// 4b. Manual tap-to-place (Custom order)
router.post('/collection/:id/place', async (req, res) => {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });

    const comp = await db.get(`
      SELECT c.id, c.capacity, l.id AS loc_id, l.type AS loc_type, l.sort_order
      FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?`, [compartment_id, req.user.id]);
    if (!comp) return res.status(400).json({ error: 'Invalid compartment' });
    if (comp.sort_order !== 'custom') return res.status(400).json({ error: 'Manual placement is only available in Custom order' });

    const isBinder = isBinderType(comp.loc_type);

    if (swap_with) {
      const other = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
      if (!other) return res.status(400).json({ error: 'Swap target not found' });
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [other.compartment_id, other.location_id, other.position, id, req.user.id]);
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
      const placement = await describePlacement(db, id, req.user.id);
      return res.json({ message: 'Cards swapped', placement });
    }

    if (!Number.isInteger(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot' });

    if (entry.compartment_id !== compartment_id) {
      const cnt = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE compartment_id = ? AND user_id = ?`, [compartment_id, req.user.id]);
      if (cnt.n >= comp.capacity) return res.status(400).json({ error: 'COMPARTMENT_FULL' });
    }

    const sourceComp = entry.compartment_id;
    if (isBinder) {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000, id, req.user.id]);
    } else {
      await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
        [compartment_id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
      await rebalanceCompartmentByScheme(db, compartment_id, req.user.id, { sort_order: 'custom' });
    }

    if (sourceComp && sourceComp !== compartment_id) {
      const src = await db.get(`SELECT l.type AS loc_type FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`, [sourceComp]);
      if (src && !isBinderType(src.loc_type)) {
        await rebalanceCompartmentByScheme(db, sourceComp, req.user.id, { sort_order: 'custom' });
      }
    }

    const placement = await describePlacement(db, id, req.user.id);
    res.json({ message: 'Card placed', placement });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'purchase_split', 'add_to_deck'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const BULK_PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
router.post('/collection/bulk', async (req, res) => {
  const { entry_ids = [], action, value } = req.body;
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const ids = entry_ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid entry_ids' });
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      const rows = await db.all(
        `SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (${placeholders}) AND user_id = ? GROUP BY card_id`,
        [...ids, req.user.id]
      );

      let added = 0;
      const rejected = [];
      for (const row of rows) {
        const existing = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, row.card_id]);
        const current = existing ? existing.quantity : 0;
        const newQty = current + row.total_qty;
        // Enforce deck rules (owned cap + max 4 per name) so this path can't
        // bypass the limits the deck builder enforces.
        const check = await validateDeckAddition({ deckId, userId: req.user.id, cardId: row.card_id, newQty });
        if (!check.ok) { rejected.push(check.error); continue; }
        await db.run(
          `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
          [deckId, row.card_id, newQty]
        );
        added += row.total_qty;
      }
      const msg = rejected.length
        ? (added ? `Added ${added} card(s). ${rejected[0]}` : rejected[0])
        : `Added ${added} card(s) to deck`;
      return res.json({ message: msg, affected: added, rejected: rejected.length });
    }

    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'trade' || action === 'untrade') {
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!['collection', 'wishlist'].includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      const allowed = action === 'condition' ? BULK_CONDITIONS : BULK_PRINTINGS;
      if (!allowed.includes(value)) return res.status(400).json({ error: `Invalid ${action}` });
      // Column name is action, drawn from the BULK_ACTIONS whitelist (not user
      // input), so it is safe to interpolate.
      const result = await db.run(`UPDATE collection SET ${action} = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Set ${action} on ${result.changes} card(s)`, affected: result.changes });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!(total >= 0)) return res.status(400).json({ error: 'total must be a non-negative number' });
      const rows = await db.all(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      for (let i = 0; i < rows.length; i++) {
        await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [shares[i], rows[i].id, req.user.id]);
      }
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
    }
    let moved = 0;
    const touched = new Map();
    for (const id of ids) {
      const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) continue;
      if (!locationId) {
        await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        moved++;
        continue;
      }
      const resolved = await resolveCompartmentAndPosition({
        locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing, language: entry.language
      });
      const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
      if (resolved.compartment_id) touched.set(resolved.compartment_id, finalLoc);
      moved++;
    }
    for (const [compId, locId] of touched) {
      const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
      if (rbLoc) await rebalanceCompartmentByScheme(db, compId, rbLoc.sort_order, rbLoc.foil_sorting);
    }
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

// Saved Filter Presets
router.get('/collection/filters/presets', async (req, res) => {
  try {
    const presets = await db.all(
      `SELECT * FROM saved_filter_presets WHERE user_id = ? ORDER BY name ASC`,
      [req.user.id]
    );
    res.json({ presets });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch filter presets', message: error.message });
  }
});

router.post('/collection/filters/presets', async (req, res) => {
  const { name, filter_config, sort_config, is_default = 0 } = req.body;
  if (!name || !filter_config) {
    return res.status(400).json({ error: 'Preset name and filter_config are required' });
  }

  try {
    const result = await db.run(
      `INSERT INTO saved_filter_presets (user_id, name, filter_config, sort_config, is_default)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user.id,
        name.trim(),
        typeof filter_config === 'string' ? filter_config : JSON.stringify(filter_config),
        typeof sort_config === 'string' ? sort_config : JSON.stringify(sort_config || []),
        is_default ? 1 : 0
      ]
    );
    res.status(201).json({ success: true, id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save filter preset', message: error.message });
  }
});

router.delete('/collection/filters/presets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM saved_filter_presets WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Filter preset not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete filter preset', message: error.message });
  }
});

module.exports = router;
