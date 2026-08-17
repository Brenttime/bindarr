# Changelog

All notable changes to this project will be documented in this file. Each
release also carries fuller notes on its
[GitHub release](https://github.com/thenotoriousJeremy/bindarr/releases).

## [1.7.0] - 2026-08-17

### Added
- **Read-only API keys** — a per-user key, generated in Settings, for reading a collection from outside Bindarr (a dashboard, a tracker) without a session that expires overnight. It never expires, and that is acceptable only because it is read-only: `authenticateToken` refuses any non-GET request made with it, `requireAdmin` refuses it outright, and `/auth/me` strips the account's other provider keys so a key pasted into a dashboard config cannot leak the PSA or TCG one.
- **`GET /api/stats/networth`** — value, spent, gain, `byGame`, and `currencies` as a *list*, in one pass over the collection. Providers quote in USD and EUR and the total sums them as-is, so naming a single currency would be a lie.
- **Per-copy card values** — `collection.market_value`, typed by the owner or fetched, which `resolveCardPrice` prefers over every provider column. One column, so net worth, set totals, price sort and exports all read the same number regardless of origin. Needed because every price source here (TCGplayer, Scryfall, Cardmarket) quotes the *raw* card, and a PSA 10 is not the raw price plus a bit.
- **Graded-slab price lookup** for Pokémon, from an optional PokemonPriceTracker key: PSA, BGS and CGC, half grades included, from `ebay.salesByGrade`. A button and never a sweep — that provider bills per card returned and the free tier is 100 credits a day. When a grade has no sales the refusal names the grades that do.
- **PSA cert lookup and slab grading**, TCGCSV pricing, and per-card art overrides.
- **Binder drag-and-drop** — drag a card from Unsorted into a pocket, drag a filed card to another pocket (empty moves, occupied swaps, across the spread included), or drag one back to the queue to unfile it. No backend change: `/collection/:id/place` already swapped and moved. Custom-order binders, mouse only; touch keeps filing by tap under Arrange, since a touch drag would swallow the page-swipe.

### Changed
- **Code-free scan matching recalls with BoVW** instead of CLIP, and the global index pipeline was rebuilt around it.
- README rewritten around Docker, with the non-setup material moved to PROJECT.md. Settings now keeps every provider key in one panel instead of four.

### Fixed
- **`/api/export` answered 500 on every current database.** It selected `c.sub_location_1`, a column `db.js` drops the table to remove, and its market price was `cc.price_trend` flat — wrong for every foil, 1st Edition and slab. Rebuilt from the compartment and priced through `resolveCardPrice`.
- **The card inspector showed the price resolved for the *saved* printing**, so switching foil type changed nothing until a save and a refetch. It resolves live now.
- The Pokémon provider is decided once, and by provider rather than by language.

## [1.6.1] - 2026-08-04

### Added
- **Eight new locales** — es, fr, it, ko, pt-BR, ru, zh-Hans, zh-Hant — plus German and Japanese completed, all ten reporting a full key count. Plurals follow each language's own CLDR categories rather than English's two: one form for ja/ko/zh, three for es/fr/it/pt-BR, four for ru with correct case declension.

### Fixed
- `container.type.other` and its sibling key are renamed. `check-locales.mjs` reads a key ending in a plural category as a counted phrase, so `other` made the checker demand a `container.type.one` from every language with more than two plural forms. The stored database value is unchanged; only the lookup key moved.

## [1.6.0] - 2026-08-04

### Added
- **Card languages** (#25) — language is recorded per copy. MTG printings come from Scryfall and non-English Pokémon cards from TCGdex, since pokemontcg.io has no data for them at all, prices included. Set indexes and scanning are per game *and* language, because the art and the set lists both differ.
- **Translatable interface** (#25) — every string lives in `frontend/src/locales/en.json`; a translation is that one file copied and translated, with no code or tooling, and untranslated keys fall back to English individually. See `docs/TRANSLATING.md`.
- **Hide games you don't collect** (#26) — a per-device Settings toggle removes a game from every picker, tab and filter. Display only: nothing is deleted and export is unchanged.
- **HTTPS listener** (#27) — browsers only hand the camera to a secure context, so `http://<lan-ip>:3001` could never scan and showed no prompt to accept. The image now serves the same app on 3443 with a self-signed certificate generated beside the database, so phones can scan without a reverse proxy. HSTS stays off while that certificate is self-signed, or clicking past the warning becomes impossible.
- `backend/test/crop.test.js`, a measured recall gate for scan cropping, which caught silent crop regressions.

## [1.5.2] - 2026-07-29

### Fixed
- **`latest` tracked `main` rather than the newest release, and pointed at a different digest than the version tags.** It was gated on `refs/heads/main` while the semver tags only apply on a tag ref, so the two were published by separate runs. The README tells self-hosters to run `:latest`, which handed them whatever was last merged — including states whose server binaries did not start. `latest` is now applied on `v*` tags alongside the version numbers, on one digest; `main` publishes **`edge`** for anyone tracking unreleased work. The Docker workflow gained `workflow_dispatch` so a release's image tags can be republished without moving its git tag, and the README documents what each tag points at.

No application code changed in this release.

## [1.5.1] - 2026-07-29

### Fixed
- **The self-hosted server binary exited immediately on launch** with `Cannot find module '../../../shared/cardOrder.json'`. `compartmentSort.js` reads the canonical card-order tables from the repo-root `shared/` directory, which the release job never copied into the packaged tree — so **every server binary from v1.4.x onward was affected**. Docker images and the mobile apps were never affected; both keep the repository layout, where the path resolves. Nothing caught it because the whole test suite runs from source.
- CI now **boots the assembled binary and polls `/api/health`**, failing the build if it exits or never answers. Source-based tests are structurally blind to packaging faults.
- The launcher no longer dies silently: it prints the failure, points at the issue tracker for a missing-file error, and waits for a keypress — while still exiting immediately when stdin is not a TTY, so running it as a service or piped into a log is unchanged.

## [1.5.0] - 2026-07-28

### Added
- **Search & Add paging** — 30/60/120/250 per page with a Load more button and the provider's real match count, replacing a hard 50-result cap. Scryfall's default collapse to one printing per name is off, so "Sol Ring" returns its 55 printings rather than 2. A set plus a collector number identifies exactly one card, so that pair opens Quick Add directly. Digital-only prints (Alchemy rebalances) are excluded — no physical card exists.
- **Multi-select with shift-click ranges** in Search & Add, using the same hook, long-press gesture and visuals as the collection, which gains range-select too. **Bulk add** puts a whole selection in with one action, sharing the single-add path so placement and price history behave identically.
- **Rapid Add** — pin a set, type a collector number, press Enter; the field keeps focus for the next card, with a running receipt and per-card undo. **Owned badges** show what is already in your binder while browsing a set, and set codes autocomplete over every known set for both games.
- **About Bindarr panel** — version, update check against GitHub releases, and one-click bug report or feature request with version, platform and browser prefilled (nothing is submitted until you review it on GitHub). The version is baked in at build time, so it shows even when the backend is unreachable, and a frontend/backend version disagreement is called out as a half-finished update.
- Full-screen card art in the Search & Add drawer, sharing one viewer with the collection inspector.

### Changed
- **`pokemon_cards.db` is renamed to `bindarr.db`** — a leftover from when this was PokeKeep, a Pokémon-only tracker. Upgrades migrate automatically on first start: the old file is renamed along with its `-wal`/`-shm` sidecars, never overwriting an existing `bindarr.db`, and falling back to the old file if the rename fails rather than opening an empty database. A pinned `DB_PATH` on the old filename keeps working, and existing `pokemon_cards.*.bak` backups still list and restore.
- **Price history ranges are now 30D and All.** 1Y and 5Y could never show anything different — no card API sells back-history, so they redrew the same line under a different label. Pokémon charts use Cardmarket's real `avg30`/`avg7`/`avg1` rolling averages, each plotted at the midpoint of the period it averages rather than its start.

### Fixed
- **Repeated Scryfall `429`s**, from two real faults: the published limits are per endpoint (`/cards/search` and `/cards/collection` allow 2/second, not the 10/second that covers other methods), and a `429` only backed off the request that received it while the queue behind it kept firing and renewed the penalty. All Scryfall traffic now pauses for the window Scryfall asks for.
- Price sweeps batch through `/cards/collection` at 75 identifiers per request — a 160-card sweep went from 160 requests over ~50s to **3 requests in 2.1s** — and run at most once daily, matching Scryfall's own price cadence. The boot sweep previously re-ran on every restart.
- **Snapshots are recorded only when the price changes**, and use millisecond timestamps. One card had accumulated 335 snapshots covering 3 distinct prices; flat runs now collapse on read to 14 plotted points without losing shape. `recorded_at` is part of the primary key, so two genuine moves inside one second silently dropped one.
- **MTG search reported a throttled or unreachable Scryfall as "no cards matched"** — the same misleading-empty-result class fixed for Pokémon in #23. It now serves cache, or reports the outage honestly. The MTG rate-limit banner no longer suggests a pokemontcg.io API key; Scryfall does not use one.
- Search & Add opened on Pokémon regardless of the Settings default game, and searching a Pokémon set with no card name returned nothing at all.

## [1.4.30] - 2026-07-21

### Added
- **Default Card Stacking** — collection views now default to stacking identical cards. Added stacking toggle filters (unstack, group by condition, group by printing) to the shared collection view.
- **Bidirectional Rarity Sort** — added `Rarity (High-Low)` and `Rarity (Low-High)` sorting to main and shared collection views.
- **Shared Theme Support** — share links now preserve and force active theme via `?theme=` URL query parameter (e.g. `?theme=lcars` or `?theme=light`).

### Fixed
- **Chart Tooltip Text Readability** — styled Recharts chart tooltips across all themes (Dark, LCARS, Light) so hover popups are always crisp and legible.
- **Single Card Quantity Badge** — hid the `x1` quantity tag on single cards in shared collection view.
- **Location Slot Number in Card Inspector** — fixed card inspector pop-up to accurately display slot number across 0-indexed and multiplier position encodings (e.g., `binder • Page 1 • Slot 1`).

## [1.4.25] - 2026-07-21

### Added
- **Notes** — a standalone notebook tab for free-form notes (wishlist ideas, deals, trade plans), separate from card entries. Create, edit (saves on blur), pin to top, and delete. Includes client-side search over title/body and sort by recently updated, recently created, or title.
- **Per-card notes** — collection entries now carry an optional free-text note (provenance, condition details, trade plans), editable in the card inspector and shown on the card's detail view.

## [1.4.21] - 2026-07-21

### Fixed
- **Sign Up button never appeared in the native app** even when the server had registration enabled. The login screen fetches `/api/auth/config` once on mount, but on a native cold start the WebView renders before the CapacitorHttp bridge/network is ready, so that fetch failed and `registrationEnabled` stayed `false` with no retry. The config check now retries on failure (up to 5x, 1.5s apart), refetches when the app resumes, and is debounced so a freshly-typed server address is checked once it settles. A genuine `200 {registrationEnabled:false}` still stops immediately, so invite-only servers are unaffected.

## [1.4.20] - 2026-07-21

### Fixed
- **Scan settings panel shifted the buttons when toggled.** Opening the gear panel pushed the whole action row (Stop / Auto / Capture / gear) down, so the gear moved out from under your finger. The panel now expands below the button row (`order: 2`); the buttons stay put whether settings are open or closed.
- **Manual exposure slider did nothing until you moved it *and* pressed Auto.** `changeExposure` set `exposureMode: 'manual'`, but `exposureCompensation` is an EV bias that only applies on top of continuous auto-exposure — in manual mode the camera drives exposure by exposureTime/ISO and ignores the compensation. The slider now applies compensation in `'continuous'` mode, so it takes effect live on the first move (Android back cameras).

### Changed
- **Camera preview is a consistent size across devices and the packaged app.** An inline `aspectRatio` override made the preview box jump to each camera stream's own ratio once it loaded, so the box was a different size on every device. Removed the override so the box stays locked to the trading-card 5/7 ratio, and switched `.camera-video` to `object-fit: cover` (with the crop mapping switched from `min` to `max` to match) so the live video fills the card box edge-to-edge with no letterbox bars.

## [1.4.18] - 2026-07-20

### Fixed
- **Scanning died after ~67 cards** with `preprocessCard failed: undefined` / `scan-match failed: undefined`, permanently until the backend restarted. Root cause: the ORB verify loops (`inlierCount` in `scanMatch.js`, `inliers` in `setIndex.js`) leaked an embind `DMatchVector` wrapper (`knn.get(i)`) on every match row — it was never `.delete()`d. The opencv-wasm heap grows and never shrinks, so the leak ratcheted memory up (128 MB → 1 GB+) until `memory.grow()` failed and OpenCV aborted with a numeric error (hence the `undefined` message). Every subsequent OpenCV call then failed instantly, and since the backend process held the dead heap, restarting the app didn't help. Fixed by deleting the wrapper each iteration; the heap now stays flat.

### Performance
- **Set-scoped scan verification is now parallel** across a warmed worker-thread pool (`backend/src/scanPool.js`, `scanWorker.js`), each worker holding its own opencv-wasm instance. The independent per-printing ORB verifies are sharded across cores; results are identical to the previous single-threaded ranking (lossless). Measured on a 771-card set: **7079 ms → 2306 ms (4 workers) → 1457 ms (8 workers)**. Configurable via the new `SCAN_WORKERS` env var (default `min(4, cores-1)`, `0` disables). `matchSet` is now async; the pool is warmed at server startup so the first scan doesn't pay worker spawn + wasm load.
- Faster candidate feature loading in the global path: `readOrb` builds descriptor Mats via `Mat.data.set()` instead of `matFromArray(Array.from(buf))` (~53 ms/scan saved on 250 candidates; identical bytes).
- Worker threads no longer open a SQLite connection each: `scryfallApi`/`tcgApi` (which pull in the DB) are lazy-required inside the build/preview paths only, keeping the verify path DB-free.

### Diagnostics
- Opt-in `SCAN_RANK_LOG=1` appends one line per confident scan to `backend/scan-rank.log` recording where the winning card sat in the CLIP recall list — for measuring whether the global-path `RECALL_K` (250) can be lowered. Off by default, zero overhead.

### Storage
- Removed the category-map filing feature from the storage view (`showCategoryMap` / category-to-page filing) in `LocationManager.jsx`.

## [1.4.0] - 2026-07-15

### Features
- Bulk-set condition and printing on selected cards from the collection long-press/select bar (`POST /api/collection/bulk` actions `condition` and `printing`).
- Split a total price paid for a pack or deck across cards into per-card `purchase_price` (`bulk` action `purchase_split`), weighted by market value or evenly, chosen at apply time. Integer-cent math keeps the parts summing to the exact total (`backend/src/utils/splitPrice.js`). Available in the collection bulk bar and the scanner's Recent Scans panel.

### Scanner
- Tap the auto-add countdown popup (Fast/Balanced/Accurate tiers) to pause and adjust condition/printing before the card is saved; ignoring it lets the normal auto-add proceed. Turbo remains instant.
- Quick-add fields: larger +/- quantity stepper; the rarely-changed Language field is dropped from the scanner quick-add.
- Tighter camera preview height on small screens.

### Storage
- Mobile filing: below 1024px, view the container detail and Unsorted queue one at a time via a segmented toggle; during filing the binder stays on screen (recommended slot blinks) with a compact pinned filing bar for Placed/Skip, and the view auto-follows the recommended slot.
- Custom (manual) container order is saved when all sort rules are removed; guidance text updated accordingly.
- Removed the Auto-Assign Categories action.

## [1.3.0] - 2026-07-14

### Fixed
- Replaced `COUNT(*)` with `COALESCE(SUM(quantity), 0)` in storage capacity calculations across `collectionHelpers.js`, `compartmentSort.js`, and `storage.js`.
- Fixed N+1 database access loops in multi-quantity card creation (`POST /api/collection`) and bulk operations (`POST /api/collection/bulk`).
- Fixed serial loop in deck checkout allocation (`checkedOutAllocation`) using a single SQL `JOIN` query.

### Performance & Memory
- Implemented `withTransaction` atomic SQLite transaction management in `db.js`.
- Refactored physical container re-sorting (`POST /api/locations/:id/resort`) using SQL `CASE ... WHEN` batch updates.
- Added single-pass JSON metadata pre-parsing (`types`, `subtypes`, `color_identity`) in `compartmentSort.js`.
- Added composite SQL performance indexes for compartment lookups, location ordering, card search, deck checkout, tag joins, and audit log ordering.

### Features
- Added custom user tags system (`tags` master table & `collection_tags` junction table, `/api/tags` endpoints).
- Added storage capacity alert warnings endpoint (`GET /api/locations/alerts`).
- Added append-only audit logging & action revert capabilities (`audit_logs` table, `/api/audit-logs`, `/api/audit-logs/:id/revert`).
- Added saved filter presets (`saved_filter_presets` table, `/api/collection/filters/presets`, dynamic query builder).
- Added third-party CSV strategy import mappers and hygiene export mappers for TCGPlayer, Dragon Shield, and ManaBox (`csvMappers.js`, `csvExporters.js`).

### Scanner
- Added a Scan Detail slider (Turbo/Fast/Balanced/Accurate) trading speed for accuracy per scan: upload resolution, auto-capture cadence, server-side CLIP recall depth (`recallK`) and ORB feature count (`orb`).
- Turbo runs a fixed 2-second capture cadence with an on-screen countdown ring; the metronome holds while a scan is in flight so captures never overlap.
- Instant capture cue (click + vibrate + border flash) fires the moment the frame is grabbed.
- Added manual exposure control (shown when the camera track supports `exposureCompensation`).
- Duplicate-scan handling: dedup guard set before the add request; the resolved-duplicate skip clears when the card leaves frame or a different card appears; Cancel in the candidate picker stops auto-capture.
