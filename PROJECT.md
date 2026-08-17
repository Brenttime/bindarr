# Bindarr — Architecture & Developer Guide

Developer-facing reference for the codebase. For install/run/deploy and end-user
features, see [README.md](README.md); this document explains **how the system is
built and why**.

Bindarr is a self-hosted trading-card collection manager for **Pokémon** and
**Magic: The Gathering**. It identifies cards from a phone photo (no typing),
tracks their real-world physical location (which binder page / box row slot),
values the collection over time, and helps you pull and re-file the cards for a
deck.

- **Backend**: Node.js + Express, SQLite (single file), served together with the built frontend from one container.
- **Frontend**: React + Vite SPA.
- **Auth**: opaque session tokens in a server-side `sessions` table, sent as a `Bearer` header.
- **Card data**: Pokémon TCG API (Pokémon) and Scryfall (MTG), cached locally in `card_cache`.
- **Image ID**: perceptual hash + bag-of-visual-words recall, then ORB feature matching with RANSAC homography to verify. All server-side via `opencv-wasm`. No ML runtime.

Stack: React + Vite + Recharts on the front, Express + `sqlite3` + Helmet +
`express-rate-limit` on the back, `opencv-wasm` and `sharp` for images, Docker +
GitHub Actions to ship.

---

## Repository layout

```
backend/
  src/
    server.js              Express app: middleware, route mounts, static SPA, health, admin bootstrap
    db.js                  SQLite connection (promisified run/get/all), schema init, password hashing
    middleware/auth.js     authenticateToken (session lookup), requireAdmin, rate limiters
    routes/
      auth.js              register / login / logout / me / per-user settings
      collection.js        collection CRUD, locations & compartments, sorting, scan-match, stats, import/export
      decks.js             deck CRUD, deck cards, checkout / return, /:id/locations locator payload
      sets.js              set catalog lookup
      settings.js          app-wide settings (admin)
      shared.js            public read-only shared collection by share_token
      admin.js             user management, card seeding
    tcgApi.js              Pokémon TCG API client (search + fetch by id) -> card_cache shape
    scryfallApi.js         Scryfall (MTG) client -> same normalized card shape
    psaApi.js              PSA cert lookup (what is in the slab), cached forever in psa_cert
    gradedPrices.js        Graded-price lookup (what the slab is worth) via PokemonPriceTracker
    scanMatch.js           Image ID pipeline: detect/rectify -> dHash + BoVW recall -> ORB+homography verify
    orbUnion.js            Rolls per-set ORB indexes into one whole-game index; carries the dHash columns recall sweeps
    buildBovw.js           Builds the whole-game BoVW index from those same descriptors
    bovwVocab.js           Visual-word vocabulary; bovwIndex/bovwMatch read and query it
    setIndex.js            On-demand per-set ORB index (set-scoped MTG matching), built from Scryfall
    globalIndex.js         Build orchestration + state for the whole-game indexes (Admin -> Global Scan Indexes)
    utils/
      compartmentSort.js   Placement engine: which compartment/slot a card files into; sort comparators
      priceHelpers.js      Price resolution across printings; vintage-set detection; UTC parsing
      authHelpers.js       Auth-related helpers
      backup.js            DB backup helpers
  scripts/                 Standalone recall-index builder + scan eval harnesses
  test/                    Node test suites (sort, auth) and an e2e runner under test/e2e/
frontend/
  src/
    main.jsx, App.jsx      Entry + root: auth state, fetch wrapper (injects Bearer), tab routing, code-split views
    components/            One component per screen/widget (see Frontend section)
    utils/                 Pure helpers: sorting, pricing, printing/rarity styling, language, shuffle
Dockerfile, docker-compose.yml, .github/workflows/docker-build.yml   Container build + CI publish to GHCR
```

Regenerable/large artifacts live in `backend/data/` (ORB/BoVW rollups, per-set
indexes) and the SQLite DB — both gitignored. In the container those paths move
into the mounted volume via `SETS_DIR=/app/database/sets` and
`INDEX_DATA_DIR=/app/database/index`, so a rebuilt image doesn't discard them.

---

## Backend

### Request lifecycle

`server.js` wires Helmet (with a Report-Only CSP that allow-lists the card-image
hosts), JSON body limits, the API routers, then serves the
built SPA and a SPA fallback. `GET /api/health` is unauthenticated and backs the
Docker `HEALTHCHECK`. On first startup with an empty DB it creates the default
`admin` user and prints the generated password once (or uses `DEFAULT_ADMIN_PASSWORD`).

### Auth

Authentication is DB-backed session tokens, not JWTs:

- `POST /api/auth/login` verifies a PBKDF2 password hash and inserts a row into `sessions` (`user_id`, `token`, `expires_at`).
- `authenticateToken` (`middleware/auth.js`) reads the `Bearer` token, looks it up in `sessions` where `expires_at > now`, and sets `req.user = { id, username, role, tcg_api_key, ... }`.
- `requireAdmin` gates admin-only routes on `req.user.role === 'admin'`.
- A bearer token that matches no session is then checked against `users.api_key` — a long-lived read-only credential for external scripts (issue #33). It sets `req.user.via_api_key`, which makes `authenticateToken` refuse any non-GET (403) and `requireAdmin` refuse it outright, and makes `/auth/me` strip the account's other provider keys. Read-only is the whole reason a non-expiring credential is acceptable here; anything that weakens it has to replace it with something scoped.
- Rate limiters (`authLimiter`, `searchLimiter`, `importLimiter`) protect login and expensive endpoints.

`collection.js` applies `router.use(authenticateToken)` up front, so every
collection/location/deck-adjacent route requires a valid session.

### Route map

| Mount | File | Responsibility |
|-------|------|----------------|
| `/api/auth` | auth.js | `register`, `login`, `logout`, `me`, `PUT /settings` (per-user, e.g. `tcg_api_key`), `POST/DELETE /api-key` (read-only external key) |
| `/api` | collection.js | Card `search`, `scan-match`, `prepare-set`; `collection` CRUD + `bulk` + `:id/market-value/fetch`; `locations` & `compartments` CRUD; `recommend(-batch)`, `apply-all`, `resort`; `stats`, `stats/history`, `stats/networth`, `export`, `import`; `cards/:id/price-history` |
| `/api/decks` | decks.js | Deck CRUD, `:id/cards`, `:id/checkout`, `:id/return`, `:id/locations` (checkout/check-in locator payload) |
| `/api/sets` | sets.js | Set catalog (used for set dividers and set-scoped scan) |
| `/api/settings` | settings.js | App-wide settings (read any; write requires admin) |
| `/api/shared` | shared.js | Public, read-only collection view by `share_token` (no auth) |
| `/api/admin` | admin.js | User management, card cache seeding (admin) |

### Card data sources

`tcgApi.js` (Pokémon) and `scryfallApi.js` (MTG) both normalize provider cards
into one shape and upsert into `card_cache` so the rest of the app is
game-agnostic. Every card carries a `game` field (`pokemon` | `mtg`). A user's
Pokémon TCG API key (stored per-user) is passed through where available.

### Image identification pipeline

Server-side, image-only (no OCR). Entry point `scanMatch.match(buffer, game, topK, setCode)`:

1. **Detect & rectify** (`scanMatch.detectCard`/`preprocessCard`): OpenCV Canny + contour analysis scores card-like regions by `size × aspect-fit × centrality`, then perspective-warps a clean 4-point quad flat or crops the best bounding box; falls back to a centered guide-box crop.
2. **Recall, two channels unioned** (`scanMatch.hashRecall` + BoVW): a 64-bit dHash of the rectified crop is popcount-compared against every printing's stored hash (110k pairs, sub-millisecond) for the top 250; a BoVW visual-word lookup over the query's ORB descriptors adds its top 10. They fail on different photos — blur moves the local descriptors BoVW quantizes but barely touches a brightness-gradient hash, while reframing moves the hash and leaves descriptors alone. The hashes ride on the ORB rollup's meta, so that channel costs nothing extra to build; BoVW is its own rollup file.
3. **Verify** (`scanMatch.inlierCount`): ORB descriptors matched with a brute-force Hamming matcher + Lowe ratio (0.75), then a RANSAC homography (5px); rank by geometric **inlier** count. Only the true printing yields many consistent matches.
4. **Game auto-detect**: verifies the requested game first; if weak (< 25 inliers) it also tries the other game and keeps the higher score.
5. **Set-scoped fast path** (`setIndex.js`): if an MTG set code is supplied, match ORB inliers against just that set's ~300 printings (index built on demand from Scryfall, cached under `SETS_DIR`) — no global recall needed. The per-printing verify fans out across a warmed worker pool (`SCAN_WORKERS`); ranking is identical to single-threaded.

The client (`CameraScanner.jsx`) gates the result: auto-fill above threshold
(≥12 ORB inliers), otherwise show candidates for a manual pick.

### Why both recall channels

Recall was a CLIP embedding table once. It ran a second model over every image
at build and scan time, and held one row per *artwork*, so a reprint could be
named right but almost never placed in the right set. BoVW replaced it and fixed
the reprint problem; the perceptual hash was added beside it. Ablated over 100
MTG cards on one sample:

| recall | exact printing | right card | latency |
| --- | --- | --- | --- |
| hash 250 + BoVW 10 | **91.0%** | **98.0%** | 772 ms |
| hash 60 + BoVW 250 | 91.0% | 98.0% | 1328 ms |
| hash 250 + BoVW 0 | 82.0% | 90.0% | 700 ms |
| hash 0 + BoVW 250 | 84.0% | 93.0% | 1360 ms |

Neither channel alone matches the pair. BoVW earns its keep in its first ten
results (recall@1 of 48% against the hash's 32%) and almost nothing after, which
is why it gets ten and the hash gets the rest of the verify budget. Dropping it
cost 9 points of exact printing here, plus 8 of 65 real phone captures whose
true printing sat at BoVW rank ~213.

### Index builds

There is one unit of work — a per-set ORB index — and everything derives from
it. Scanning with a set code needs only that set's index, built on demand by the
scan itself. Scanning without one needs every set indexed plus two whole-game
rollups: the ORB rollup (`orbUnion.js`, a concatenation of the per-set files,
keyed `set|number`, whose meta carries each printing's dHash) and the BoVW index
(`buildBovw.js`) built from those same descriptors. So a build is one walk over
the sets: each set fetched once, its images downloaded once. No second card
source, no second download pass.

Admin → Global Scan Indexes drives it: **Preflight** samples the catalogue and
reports coverage in seconds; **Index every set** does the walk; **Rebuild** does
the walk plus the rollups. A stop lands within one set and resume continues from
that boundary; per-set indexes already on disk are reused. A run whose
*reachable* sets mostly fail is refused rather than swapped over a working index
— sets with no data in the chosen language are counted separately, not as
failures.

Sets built by the scan path are immediately eligible for the rollups, so if (and
only if) the rollups already exist, a background pass re-runs them 30s after the
last set lands. Code-free coverage grows as you scan. Where rollups have never
been built the pass does nothing: code-free scanning is maintained
automatically, never *started* automatically.

Index building is admin-only by default. Scanning a set already builds that
set's index for any logged-in user (`POST /api/prepare-set`), so **Admin →
Instance Settings → "Let members build individual set indexes"** only surfaces a
button for something members already trigger implicitly; rollups stay
admin-only. Any logged-in user can read `GET /api/scan-index-status` to see
whether code-free scanning is available.

Indexes are per-language because card images are: a Japanese printing has a
different name box and flavour text, so an English index can't match it. English
keeps un-suffixed filenames, so pre-language builds are still found. Non-English
Pokémon data comes from TCGdex, whose coverage varies wildly by language
(Russian has 9 sets to English's 218).

### Measuring accuracy

`RECALL_K = 250` out of ~110k printings is a 0.2% window: if the shortlist
misses the card, ORB never sees it. Changes to preprocessing, the vocabulary, or
`RECALL_K` get measured, not guessed:

```bash
node scripts/eval-global-index.mjs --game mtg --sample 200 --compare
```

It samples indexed cards deterministically (two runs are comparable) and reports
recall@1/@5/@K, exact-printing top-1, right-card top-1 (name correct, printing
may differ) and mean latency — first against each card's own reference image,
then against a camera-like degraded copy. Two readings are worth knowing how to
read: low *clean* recall@1 means the build and query sides disagree on
preprocessing, which produces no other error signal; a large exact-printing vs
right-card gap is printings of the same artwork, which art alone often can't
separate.

Baseline (MTG, 100 cards, noisy, seed 20260812): exact printing 91.0%, right
card 98.0%, 772 ms/scan.

`GLOBAL_PRINTING_EXPANSION=1` makes verification also test the other printings
of a recalled card and let inliers pick the exact one. It was written for CLIP
recall, which held one printing per artwork; hash recall indexes every printing,
so it matters far less now. Off by default — it trades latency for accuracy —
and bounded by `GLOBAL_PRINTING_EXPANSION_TOP` (20 candidates expanded) and
`GLOBAL_PRINTING_EXPANSION_MAX` (120 extra printings verified). Measure both
effects before turning it on.

### Prices

`utils/priceHelpers.resolveCardPrice(row)` is the single answer to "what is this
worth", and its order is: `collection.market_value` (this copy's own value),
then the price column matching the row's `printing`, then `price_trend`. Any
query whose result reaches it must select `c.market_value` alongside the
`cc.price_*` columns, or a graded copy silently reverts to the raw card's price
in that one view — the failure is invisible, it just reads low.

`market_value` is written from two places and read as one number: the owner types
it (`PUT /collection/:id`, source `manual`) or fetches it
(`POST /collection/:id/market-value/fetch`, source `pokemonpricetracker`). The
fetch path lives in `gradedPrices.js` and exists because no card API prices
slabs. It is per-request and never swept: the only free provider meters at 100
lookups a day. `frontend/src/utils/resolveCardPrice.js` mirrors the same order
for cards not yet saved.

### Storage & sorting engine

`utils/compartmentSort.js` decides where a card physically files:

- A **location** (binder/box/etc.) contains ordered **compartments** (binder pages / box rows).
- `recommendSlot()` picks the compartment + slot for a card based on the location's `sort_order` scheme and per-compartment `rule_config` filters.
- **Slot encoding**: a card's `position` is `slot * 1000` (slot 1 → 1000, slot 2 → 2000). `Math.floor(position / 1000)` recovers the human slot number. The gaps leave room for manual reordering.
- Sort schemes are either `custom` (manual order, honored via stored `position`) or structured (name / set-number / price / type-color / language), optionally foil-aware (`foil_sorting`). Structured schemes also drive the visual set/category **dividers** in the binder view.

---

## Data model (SQLite)

| Table | Purpose / key columns |
|-------|-----------------------|
| `users` | `id`, `username`, `password_hash` (PBKDF2, iterations embedded), `role`, `share_token`, `share_enabled`, `tcg_api_key`, `psa_api_token`, `graded_price_api_key`, `api_key` (read-only external credential) |
| `sessions` | `user_id`, `token`, `expires_at` — Bearer-token auth |
| `card_cache` | Normalized card metadata keyed by provider `id`: `name`, `set_id`/`set_name`, `number`, `image_url`, `types`/`subtypes`/`supertype`, `rarity`, `cmc`, `color_identity`, `price_*`, `game` |
| `collection` | One row per owned stack: `id` (entry_id), `user_id`, `card_id`→card_cache, `quantity`, `condition`, `printing`, `language`, `purchase_price`, `location_id`, `compartment_id`, `position`, `list_type` (`collection`/`trade`), `is_trade`, `game`, `added_at`; per-copy grading (`grader`, `grade`, `cert_number`) and per-copy value (`market_value`, `market_value_source`, `market_value_at`) |
| `locations` | Physical containers: `user_id`, `name`, `type`, `sort_order`, `foil_sorting`, `rule_type`, `rule_config`, `game` |
| `compartments` | Pages/rows within a location: `location_id`, `idx`, `label`, `capacity`, `rule_config` |
| `compartment_assignments` | Maps sort categories to specific compartments (category→page filing) |
| `decks` | `user_id`, `name`, `description`, `checked_out`, `checked_out_at`, `created_at` |
| `deck_cards` | Deck contents: `deck_id`, `card_id`, `quantity` |
| `price_history` | Per-card price points over time, powering trend charts |
| `sets` | Set catalog (names/ordering) for dividers and set-scoped scan |
| `app_settings` | App-wide key/value settings (e.g. registration toggle) |

**Entry identity**: a `collection.id` (`entry_id`) uniquely identifies one
physical stack. Features that track individual copies (checkout locator, storage
highlighting) key on `entry_id`, never on `card_id + position` (which can collide
across compartments).

---

## Frontend

`App.jsx` holds auth state (`token`/`user` in `localStorage` under
`bindarr_*`), installs a `fetch` wrapper that injects the `Bearer` header on
`/api/*` calls and dispatches a logout event on `401`, and tab-routes between
code-split view components. `/share/:token` renders the public view without auth.

| Component | Role |
|-----------|------|
| `Login` | Auth screen (login/register) |
| `Dashboard` | Collection value, net-worth trends, distributions, milestones |
| `AddCards` | Wrapper toggling **CameraScanner** vs **CardSearch** |
| `CameraScanner` | Camera capture, guide box, POST `/api/scan-match`, confidence gate + manual pick |
| `CardSearch` | Name/number text search against the card APIs |
| `CardInspectorModal` | Card detail: pricing, types, printing/rarity, location |
| `CollectionList` | Browse/filter/sort the collection; bulk actions |
| `LocationManager` | Manage containers; binder/box views; filing mode; storage select |
| `CompartmentView` | Renders one compartment (binder pocket grid or box coverflow); highlights cards by `entry_id`; greys checked-out cards |
| `CreateContainerModal` | New-container wizard |
| `DeckBuilder` | Deck CRUD, composition charts, draw simulator, checkout/return |
| `CheckoutWizardModal` | Checkout **and** check-in locator (mode prop): grouped by container→page, grid highlight, select-all per page/container/all |
| `SortFilterBuilder` | Drag-and-drop sort scheme + filter rule builders |
| `Settings`, `AdminPanel`, `SharedCollection`, `PriceHistoryChart` | Preferences, user admin, public view, price charts |

Client utils (`utils/`): `cardSort` (shared sort comparators + `sortCardsByOrder`),
`resolveCardPrice`/`formatPrice` (pricing display), `cardPrinting`/`cardRarity`
(badge styling), `langHelper`/`pokemonTranslation` (Japanese name handling),
`cardOptions` (condition/printing/language enums), `shuffle` (draw sim).

---

## Deck checkout / check-in

Reserving a deck's physical cards. **Checkout and check-in never move cards in
the DB** — a card's stored slot is both where you grab it and where it returns;
only `decks.checked_out` changes.

- `PUT /api/decks/:id/checkout` validates availability (owned minus copies locked by other checked-out decks) and sets the flag.
- `GET /api/decks/:id/locations` returns, per card, the specific stored copies to pull (`entry_id`, container, compartment display, slot from `position`) plus any `missing` count.
- `GET /api/collection` annotates each entry with `checked_out_qty` (`checkedOutAllocation` greedily allocates checked-out decks' requirements onto owned entries), so `CompartmentView` greys those copies with an "In Play" badge.
- `CheckoutWizardModal` renders that payload as a grouped checklist with the compartment grid highlighting the pulled cards; `PUT /api/decks/:id/return` flips the flag and reopens the same modal in reverse (`mode="checkin"`).

---

## Conventions & gotchas

- **Backend has no auto-reload** in production/local `node src/server.js`; restart it after backend changes so new routes/data load. Frontend uses Vite HMR.
- **SQLite runs in WAL mode** — checkpoint/stop before file-level backups so `-wal`/`-shm` are flushed.
- **Everything is game-scoped** (`pokemon` | `mtg`); new card fields must be threaded through both `tcgApi.js` and `scryfallApi.js` normalization.
- **`position = slot * 1000`** is the single source of truth for slot order; never assume packed array index equals slot.
- **Scan DBs are optional**: without the prebuilt whole-game ORB rollup, set-scoped MTG matching still works (builds on demand); global/code-free matching and game auto-detection need the pre-built data, including its dHash columns — a rollup without them has no recall stage at all.
- **Frontend lint is strict**: CI runs `eslint --max-warnings 0`, so unused vars/imports and empty blocks fail the Docker build.

---

## Build, run, test

Setup and Docker deployment: see [README.md](README.md). Quick reference:

- Backend: `cd backend && npm run dev` (nodemon) or `npm start`; port `3001`.
- Frontend: `cd frontend && npm run dev` (Vite, port `5173`, proxies `/api` → `3001`).
- Tests: `npm test` from the root (or `cd backend && npm test`) runs every unit suite in `backend/test/` plus the e2e suites under `backend/test/e2e/`. `npm run test:e2e` runs only the latter. No framework — each file is a plain `node` script.
- Lint (matches CI): `cd frontend && npm run lint`.
