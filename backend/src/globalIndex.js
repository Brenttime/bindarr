// In-app management of the whole-game scan indexes — what a scan needs when it is
// given no set code.
//
// There is ONE unit of work here: a per-set index. Everything else is derived
// from it.
//
//   Scanning WITH a set code needs only that set's index, which the scan path
//   already builds on demand (see collection.js /prepare-set).
//
//   Scanning WITHOUT one needs every set indexed, plus ONE whole-game artifact:
//     · an ORB feature index (src/orbUnion.js) — every printing, keyed by
//       set|number and read per candidate to name the exact printing. Its meta
//       also carries each printing's perceptual hash, which is what recall
//       sweeps, so recall is not a separate artifact at all.
//
// The ORB rollup is a concatenation of the per-set files, so a build is one walk
// over the sets: each set is fetched once and its images downloaded once. That is
// also what makes the language dimension correct — the per-set fetch already asks
// the right provider for the right language, where the bulk card sources this
// used to page had no language dimension at all.
//
// Recall costs no walk and, now, no second artifact. It used to be a CLIP
// embedding table (a second model over every image, one row per ARTWORK, so it
// could only propose the printing Scryfall picked), then a BoVW visual-word
// index derived from the ORB descriptors. BoVW was dropped after ablation: over
// 100 MTG cards it moved exact-printing accuracy 90.0% -> 91.0% versus the hash
// channel alone, for a 427 MB file and most of the per-scan verification budget.
//
// Because the unit of work is a set, an interrupted build costs one set rather
// than hours, and any set the user already indexed for set-scoped scanning is
// reused as-is.
//
// Rollups are written to a staging dir and swapped over the live files at the very
// end, so scans keep using the previous tables until a build actually finishes.
const fs = require('fs');
const path = require('path');
const scanMatch = require('./scanMatch');
const setIndex = require('./setIndex');
const orbUnion = require('./orbUnion');
const { buildBovw } = require('./buildBovw');
const languages = require('./utils/languages');
const gpaths = require('./utils/globalIndexPaths');
const setCatalogueMatch = require('./utils/setCatalogueMatch');
const pokemonProvider = require('./utils/pokemonProvider');

// Where the rollups live and what they are called comes from utils/globalIndexPaths
// — the same module scanMatch reads them through. This file used to
// carry its own copy of the naming rules, which is the one duplication that cannot
// be caught by anything: a build writes files the readers never look for, and the
// scanner reports "not built yet" about an index sitting right there on disk.
const DATA_DIR = gpaths.DATA_DIR;
const GAMES = ['mtg', 'pokemon'];

// A build whose success rate falls below this is refused rather than swapped in.
// Before this existed, a build that failed every single download exited 0 and
// clobbered a working index with an empty one.
const MIN_SUCCESS_RATE = 0.95;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Does this build error mean "this set simply does not exist in this language"
// rather than "something went wrong"? The distinction decides whether a build is
// allowed to finish: a language may legitimately cover only a fraction of a game's
// sets, and treating those gaps as failures would make every non-English build
// refuse at the failure floor. Network errors, rate limits and 5xx must NOT land
// here — they are real failures and should stop a build.
//
// Reading the message is the FALLBACK. The fetchers that know they are reporting
// a gap now mark the error itself (setIndex's `absent` helper), so adding a new
// kind of gap or rewording an existing one no longer risks silently reclassifying
// it as a failure and stalling every build in that language.
function isAbsent(message) {
  const m = String(message || '').toLowerCase();
  return m.includes('no cards for set')
    || m.includes('no card data')
    || m.includes('but no card images')
    || m.includes('lists no cards')
    || m.includes('tcgdex has no')
    || m.includes('no cards for it yet')
    // routes/admin.js phrases this as `No <Language> cards found for <game> set "x"`.
    || m.includes('cards found for')
    || m.includes('status code 404');
}

// The classification actually used, given both signals.
//
// `flagged === true` only ever ADDS absences: an error carrying no flag — an
// axios 404, anything thrown by a module that has never heard of this
// distinction — still gets the phrase check. So the typed path can broaden what
// counts as an expected gap but can never turn a tolerated gap back into a
// build-stopping failure, which is the direction that would hurt.
function isAbsentFailure(message, flagged) {
  return flagged === true || isAbsent(message);
}

// Which KIND of gap, for the coverage breakdown. The counts alone ("55 excluded")
// leave the user with no idea whether to retry, switch language, switch provider,
// or accept it — and those are four different next moves.
//
// Grouping is deliberately coarse. The messages are written for humans and carry
// set names and counts, so they are unique per set and useless to group by; these
// buckets are the distinctions that change what you would DO about it.
function absentReason(message) {
  const m = String(message || '').toLowerCase();
  // Checked before the "no cards" bucket: this message says how many cards it
  // found, so a substring test for card-lessness would misfile it.
  if (m.includes('no card images')) return 'no card images';
  if (m.includes('no cards for it yet') || m.includes('no cards for set')
      || m.includes('lists no cards') || m.includes('no card data')) return 'no card records';
  if (m.includes('tcgdex has no') || m.includes('cards found for')
      || m.includes('status code 404')) return 'not published in this language';
  return 'unavailable';
}

const langOf = gpaths.langOf;
const tag = gpaths.tag;         // 'mtg' for English, 'mtg-ja' otherwise
const idKey = gpaths.key;       // progress/running key for one (game, language)

const FILES = gpaths.filesOf;
// Every whole-game artifact a code-free scan needs, in build order: the BoVW
// recall index is derived from the ORB rollup, so it can only be built after it.
// The other recall channel — the perceptual hash — rides on the rollup's own
// meta and so is not a separate artifact.
const KINDS = ['orb', 'bovw'];

const progress = {};   // "game|lang" -> { phase, done, total, status, error?, ... }
const running = {};    // "game|lang" -> { child?: ChildProcess, cancelled?: boolean }

function statOf(name) {
  try { const st = fs.statSync(path.join(DATA_DIR, name)); return { size: st.size, mtime: st.mtimeMs }; }
  catch { return null; }
}

function stagingDir(game, lang) { return path.join(DATA_DIR, `.staging-${tag(game, lang)}`); }
function progressFile(game, lang) { return path.join(stagingDir(game, lang), 'progress.json'); }

// Row count and scope of the ORB rollup meta, cached against the file's
// mtime+size.
//
// This is the biggest JSON file the app owns — the MTG ORB meta carries a row
// per printing — and the two things anyone asks of it are a count and a small
// scope object. Parsing the whole file for that is affordable once and not at
// all on a 1.5s poll, which is what the scan-index panel does while a build
// runs. The stamp means a swapped-in rollup is re-read on its next use, so the
// cache can never outlive the file it describes.
const rollupMetas = new Map();   // meta filename -> { stamp, summary }

function rollupMeta(game, lang) {
  const file = path.join(DATA_DIR, gpaths.names.orbMeta(game, lang));
  let st;
  try { st = fs.statSync(file); } catch { rollupMetas.delete(file); return null; }
  const stamp = `${st.mtimeMs}|${st.size}`;
  const hit = rollupMetas.get(file);
  if (hit && hit.stamp === stamp) return hit.summary;
  let summary = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file));
    const rows = Array.isArray(parsed.cards) ? parsed.cards : [];
    summary = {
      cards: rows.length,
      scope: parsed.scope || null,
      // Columns 5 and 6 are the perceptual hash. A rollup written before they
      // existed can still name a printing once ORB is given candidates, but it
      // has nothing to GENERATE candidates from now that BoVW is gone — so it is
      // not code-free ready, and saying so is what prompts a refresh.
      hashed: rows.length > 0 && rows[0].length >= 7,
    };
  } catch { summary = null; }   // not built yet, or half-written
  rollupMetas.set(file, { stamp, summary });
  return summary;
}

// On-disk status for one (game, language): for each kind, whether it's built,
// byte size, card/row count and build time. Drives the admin table.
function statusOf(game, lang) {
  const kinds = {};
  const meta = rollupMeta(game, lang) || {};
  const cards = meta.cards || 0;
  for (const kind of KINDS) {
    const stats = FILES[kind](game, lang).map(statOf);
    const present = stats.every(Boolean);
    const bytes = stats.reduce((s, x) => s + (x ? x.size : 0), 0);
    const builtAt = stats.reduce((m, x) => Math.max(m, x ? x.mtime : 0), 0);
    kinds[kind] = { present, bytes, builtAt, cards: present ? cards : 0, hashed: present && !!meta.hashed };
  }
  return { game, lang: langOf(lang), orb: kinds.orb, bovw: kinds.bovw };
}

// Every (game, language) pair the UI may show a row for. `langs` defaults to
// English only: a caller passes the languages the user has actually enabled in
// Settings so we don't invite anyone to start eleven multi-hour builds.
function listGlobals(langs = ['en']) {
  const codes = [...new Set(langs.map(langOf))];
  const out = [];
  for (const game of GAMES) for (const lang of codes) out.push(statusOf(game, lang));
  return out;
}

function getProgress() { return progress; }

// Mirror progress to the staging dir so it survives a server restart and an
// interrupted build can be reported (and resumed) rather than looking untouched.
function persist(game, lang) {
  try {
    fs.mkdirSync(stagingDir(game, lang), { recursive: true });
    fs.writeFileSync(progressFile(game, lang), JSON.stringify(progress[idKey(game, lang)]));
  } catch { /* progress is best-effort; never fail a build over it */ }
}

function update(game, lang, patch) {
  const k = idKey(game, lang);
  progress[k] = { ...progress[k], ...patch };
  persist(game, lang);
  return progress[k];
}

// --- the walk: one pass over the sets, producing both artifacts -----------

// Build (or reuse) every set's index for one game+language, roll them up into the
// whole-game ORB index, then derive the BoVW recall index from that rollup.
//
// The rollup is built from the per-set indexes rather than from a bulk card
// source. Those sources had no language dimension — pokemontcg.io is English
// only, and Scryfall's unique_artwork bulk is not language-scoped — so a Japanese
// build either failed outright or, worse, produced an English table under a
// Japanese name. The per-set fetch already asks the right provider for the right
// language, so deriving everything from it makes the language correct by
// construction.
//
// `rollup: false` stops after the set walk: that is the "index every set" action,
// which is exactly the same work minus the whole-game tables.
async function runWalk(game, lang, staging, { rollup = true, only = null, filter = null, rollupOnly = false } = {}) {
  const code = langOf(lang);
  const k = idKey(game, code);

  update(game, code, { phase: rollupOnly ? 'recall' : 'sets', done: 0, total: 0, fail: 0 });
  const all = await setIndex.listAllSets(game, code);
  if (!all.length) throw new Error(`no sets listed for ${game} (${code}) — nothing to index`);

  // A scoped build indexes only the requested sets. The full catalogue is still
  // fetched so the rollup can record what it does NOT cover: a partial recall
  // table that cannot say "this card is outside my range" would answer an
  // out-of-scope scan with the nearest artwork it does have, which is worse than
  // answering nothing.
  // A rollup-only refresh touches no provider and builds no set — it just
  // re-concatenates what is already on disk.
  let sets = rollupOnly ? [] : all;
  if (!rollupOnly && Array.isArray(only) && only.length) {
    const want = new Set(only.map(normSet));
    sets = all.filter(s => want.has(normSet(s)));
    const unknown = only.filter(s => !all.some(a => normSet(a) === normSet(s)));
    if (!sets.length) {
      throw new Error(`none of the requested sets exist for ${game} (${code}): ${only.slice(0, 5).join(', ')}`);
    }
    if (unknown.length) console.warn(`[global ${tag(game, code)}] ignoring ${unknown.length} unknown set(s): ${unknown.slice(0, 5).join(', ')}`);
  }
  update(game, code, { total: sets.length, scoped: sets.length !== all.length });

  let built = 0, absent = 0, failed = 0;
  const absentHere = [];
  for (let i = 0; i < sets.length; i++) {
    if (running[k]?.cancelled) throw new Error('build stopped');
    const set = sets[i];
    let err = null, flagged = null;
    try {
      if (await setIndex.ensureSet(game, set, code)) built++;
      else {
        // ensureSet swallows the throw, so the remembered failure is where the
        // message AND the absence flag have to come from.
        const f = setIndex.buildFailure(game, set, code);
        err = (f && f.error) || 'build returned false';
        flagged = f ? f.absent : null;
      }
    } catch (e) { err = e.message; flagged = e.absent === true ? true : null; }
    if (err) {
      if (isAbsentFailure(err, flagged)) {
        absent++;
        absentHere.push({ set, reason: absentReason(err), message: err });
      } else failed++;
    }
    update(game, code, { done: i + 1, fail: failed, absent, currentSet: set });
  }

  // The floor is measured against sets that HAVE data in this language, not
  // against every set in the game. Per-language coverage is genuinely patchy —
  // a language may only have printings for a fraction of a game's sets, and TCGdex
  // lists sets whose images do not exist yet — so counting those as failures would
  // make every non-English build refuse to finish.
  const attempted = built + failed;
  if (!built && !rollupOnly) {
    throw new Error(
      `no sets could be indexed for ${game} in ${languages.toName(code)} ` +
      `(${absent} have no data in that language, ${failed} failed) — nothing to build`
    );
  }
  if (!rollupOnly && attempted && built / attempted < MIN_SUCCESS_RATE) {
    throw new Error(
      `only ${built}/${attempted} sets with ${languages.toName(code)} data could be indexed ` +
      `for ${game} (${failed} failed) — refusing to build a partial index`
    );
  }
  console.log(
    `[global ${tag(game, code)}] ${built} sets indexed, ` +
    `${absent} without ${languages.toName(code)} data, ${failed} failed`
  );
  if (!rollup) return { sets: sets.length, built, absent, failed };

  // The rollups cover every set that HAS an index, not just the ones this run
  // touched. Code-free scanning means "search everything indexed", so a build of
  // 3 sets must not throw away the 40 that were already there — it adds to them.
  const indexed = all.filter(s => setIndex.isReady(game, s, code));
  if (!indexed.length) throw new Error(`no ${game} (${code}) sets are indexed — nothing to search`);

  // Which sets could not be built and why — carried across runs, because most
  // runs do not walk the whole catalogue. A scoped build touches a handful of
  // sets and a rollup-only refresh walks none at all, so taking THIS run's list
  // as the whole truth would erase everything the last full build learned and
  // leave the panel reporting zero unavailable sets right after a refresh.
  //
  // Sets this run did walk get their fresh verdict either way: they are filtered
  // out of the carried-forward list first, so a set that has since gained images
  // stops being listed rather than lingering as a stale gap.
  const prevAbsent = ((rollupScope(game, code) || {}).absentSets) || [];
  const walked = new Set(sets.map(normSet));
  const absentSets = [
    ...prevAbsent.filter(a => !walked.has(normSet(a.set))),
    ...absentHere,
  ];

  // What the finished tables cover. Stored in both metas so scanMatch can tell an
  // out-of-scope scan apart from a genuine miss.
  const scope = {
    sets: indexed.slice(),
    covered: indexed.length,
    catalogue: all.length,
    excluded: all.length - indexed.length,
    absent,
    absentSets,
    filter: filter || null,
    builtAt: Date.now(),
  };

  const resolveSet = (set) => setIndex.paths(game, set, code);

  // The rollup iterates `indexed`, not the sets this run walked — a rollup-only
  // refresh walks nothing at all, and `total: 0` reads as a finished bar.
  update(game, code, { phase: 'orb', done: 0, total: indexed.length });
  const orbOut = {
    desc: path.join(staging, gpaths.names.orbDesc(game, code)),
    kp: path.join(staging, gpaths.names.orbKp(game, code)),
    meta: path.join(staging, gpaths.names.orbMeta(game, code)),
  };
  const orbStats = await orbUnion.unionSets({
    sets: indexed, resolveSet, outPaths: orbOut,
    cap: setIndex.CAP, refWidth: setIndex.REF_WIDTH, lang: code, scope,
    onSet: (i, total) => update(game, code, { done: i, total }),
  });
  orbUnion.verifyUnion(orbOut);
  console.log(`[global ${tag(game, code)}/orb] ${orbStats.cards} printings, ${orbStats.descriptors} descriptors ` +
    `(${orbStats.missing} sets missing, ${orbStats.skipped} rows skipped)`);

  // One of the two recall channels needs no pass at all — orbUnion wrote each
  // printing's perceptual hash into the rollup meta as it concatenated. The other
  // does: BoVW is derived from the rollup that was just STAGED, not from the live
  // one, which is a build behind and on a first build does not exist at all.
  update(game, code, { phase: 'recall', done: 0, total: orbStats.cards });
  const bovwStats = await buildBovw({
    game, lang: code,
    orbPaths: orbOut,
    outPath: path.join(staging, gpaths.names.bovw(game, code)),
    onProgress: (i, total) => update(game, code, { done: i, total }),
  });
  console.log(`[global ${tag(game, code)}/recall] BoVW over ${bovwStats.totalCards} printings, ` +
    `${bovwStats.numLeaves} visual words`);

  return { sets: sets.length, failed, orb: orbStats, bovw: bovwStats };
}

// How many of a game+language's sets are indexed, for the coverage display. The
// answer to "why can't I scan without a set code" is almost always this number.
async function coverage(game, lang = 'en') {
  const code = langOf(lang);
  const sets = await setIndex.listAllSets(game, code);
  const indexed = sets.filter(s => setIndex.isReady(game, s, code)).length;
  return { game, lang: code, total: sets.length, indexed };
}

// THE unified getter: everything the scan-index UI needs for one game+language in
// one payload — every buildable set, what state its index is in, the whole-game
// rollup status, and any in-flight build.
//
// It exists because this used to be three separate calls behind two separate
// panels (browse the sets, list the built indexes, check the global tables), which
// made the relationship between them invisible: the rollups are built FROM these
// set indexes, and a set list with no index state cannot show you that.
//
// `year` is null wherever the provider does not publish a release date — TCGdex's
// set briefs omit it for non-English Pokémon, and fetching it per set would be
// ~180 extra requests. Callers must treat null as "unknown", not as year zero,
// or year filtering silently hides every set in that language.
async function listSetIndexes(game, lang = 'en') {
  const code = langOf(lang);
  // Everything that is the same for every row is fetched once. The child-set map
  // in particular: asking per set cost a settings query plus a full scan of the
  // Scryfall catalogue each time, ~460 of each per request — and the admin panel
  // re-requests this every 1.5 s while a build runs.
  const [buildable, catalogue, childMap] = await Promise.all([
    setIndex.listAllSets(game, code),
    setCatalogue(game, code),
    game === 'mtg' ? setIndex.getMtgChildSetMap() : Promise.resolve(new Map()),
  ]);

  const match = setCatalogueMatch.matcher(catalogue);
  const rows = buildable.map((set) => {
    const info = match(set) || {};
    const state = setIndexState(game, set, code);
    const date = info.release_date || '';
    const year = /^(\d{4})/.test(date) ? Number(date.slice(0, 4)) : null;
    const children = childMap.get(normSet(set)) || [];
    const printings = info.printed_total || info.total || 0;
    const totalFamilyCount = printings + children.reduce((sum, c) => sum + c.cardCount, 0);
    return {
      set,
      name: info.name || set,
      series: info.series || '',
      digital: !!info.digital,
      year,
      printings,
      // What the provider says the set holds, secret rares included. `printings`
      // stays the printed total the table has always shown; this is the honest
      // denominator for card-level coverage, which is not the same number.
      claimed: Math.max(info.total || 0, info.printed_total || 0),
      totalFamilyCount,
      children,
      logo: info.logo_url || info.symbol_url || '',
      ...state,
    };
  });

  const indexed = rows.filter(r => r.indexed).length;
  const status = statusOf(game, code);
  const scope = rollupScope(game, code);
  return {
    game, lang: code,
    yearsAvailable: rows.some(r => r.year !== null),
    summary: {
      total: rows.length,
      indexed,
      bytes: rows.reduce((n, r) => n + r.bytes, 0),
      codeFreeReady: status.orb.present && (status.orb.hashed || status.bovw.present),
      rollup: status,
      scope,
      ...coverageBreakdown(rows, scope),
    },
    sets: rows,
  };
}

// Coverage in cards rather than sets, plus the detail behind it.
//
// Sets are the unit of WORK but a terrible unit of PROGRESS: they range from 12
// cards to 302, so "163 of 218 sets" read as 75% coverage when the same index
// actually held ~92% of the cards. Worse, the missing 55 were not missing at all
// — the provider has no art for them, so 163 was already everything buildable,
// and the panel kept showing a partial-coverage warning for a finished job.
//
// The numerator is measured (per-set index metas); the denominator is the
// provider's own claimed counts, which is why callers render it with a `~`. Sets
// that cannot be built at all are reported separately instead of being quietly
// folded into either side.
function coverageBreakdown(rows, scope) {
  const absentSets = (scope && Array.isArray(scope.absentSets)) ? scope.absentSets : [];
  const absentBySet = new Map(absentSets.map(a => [normSet(a.set), a]));
  const known = (r) => absentBySet.has(normSet(r.set));

  const buildable = rows.filter(r => !known(r));
  const unavailable = rows.filter(known);

  const sum = (list, pick) => list.reduce((n, r) => n + pick(r), 0);
  const cards = {
    indexed: sum(rows, r => r.cards),
    // Everything the catalogue claims, across every listed set.
    claimed: sum(rows, r => r.claimed),
    // Just the sets that DID build — the gap against `indexed` is art the
    // provider is missing inside sets that otherwise look complete.
    claimedBuilt: sum(rows.filter(r => r.indexed), r => r.claimed),
    unavailable: sum(unavailable, r => r.claimed),
  };
  cards.missingArt = Math.max(0, cards.claimedBuilt - cards.indexed);

  // Group by series so the physical/digital split is visible, since digital sets
  // are a whole series rather than a flag on individual cards.
  const bySeries = new Map();
  for (const r of rows) {
    const key = r.series || 'Other';
    const cur = bySeries.get(key) || { series: key, digital: r.digital, sets: 0, built: 0, cards: 0, claimed: 0 };
    cur.sets++;
    cur.claimed += r.claimed;
    if (r.indexed) { cur.built++; cur.cards += r.cards; }
    if (r.digital) cur.digital = true;
    bySeries.set(key, cur);
  }
  const series = [...bySeries.values()].sort((a, b) => b.cards - a.cards || b.claimed - a.claimed);

  // Why each unavailable set is unavailable, in the provider's own words, so the
  // panel can say "51 have no card images" rather than a bare excluded count.
  const reasons = new Map();
  for (const a of absentSets) {
    const key = a.reason || 'unknown';
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }

  return {
    cards,
    series,
    buildableSets: buildable.length,
    builtSets: buildable.filter(r => r.indexed).length,
    unavailableSets: unavailable.length,
    unavailableReasons: [...reasons].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    // Individual rows, so the expanded view can name them.
    unavailable: unavailable.map(r => ({
      set: r.set,
      name: r.name,
      claimed: r.claimed,
      reason: (absentBySet.get(normSet(r.set)) || {}).reason || 'unknown',
    })),
  };
}

// Per-set index state on disk. Cheap on purpose — stats and a cached meta
// summary, no provider calls and no index loading. This runs for every set in
// the catalogue on every poll, so anything that reads a whole file here is
// multiplied by ~460 and by the poll rate.
function setIndexState(game, set, lang) {
  const p = setIndex.paths(game, set, lang);
  let bytes = 0, builtAt = 0;
  for (const f of [p.desc, p.kp, p.meta]) {
    try { const st = fs.statSync(f); bytes += st.size; builtAt = Math.max(builtAt, st.mtimeMs); }
    catch { /* that part not written */ }
  }
  const cards = (setIndex.metaSummary(game, set, lang) || {}).cards || 0;
  return { indexed: setIndex.isReady(game, set, lang), cards, bytes, builtAt };
}

// The set list with display metadata (names, release dates, logos). Separate from
// listAllSets, which returns only the codes worth building.
//
// The catalogue MUST come from the same provider as the buildable list, or the
// two are joined on ids that were never meant to line up. That is not
// hypothetical: the local `sets` table is filled from pokemontcg.io
// (tcgApi.fetchAndCacheSets) while a TCGdex-provider build lists TCGdex ids, and
// 91 of TCGdex's 218 English sets — every Scarlet & Violet release, Crown Zenith,
// the whole Mega Evolution block — matched nothing. Those rows rendered as a bare
// set code with no year and no card count, which reads as a broken catalogue
// rather than as two providers numbering their sets differently.
//
// So TCGdex owns id, name and card counts wherever it owns the build, and the
// local table is demoted to enriching what TCGdex does not publish on a set brief:
// release dates and logos, joined through the fuzzier key in utils/setCatalogueMatch.
async function setCatalogue(game, lang) {
  const code = langOf(lang);
  if (game === 'pokemon' && await pokemonProvider.usesTcgdex(code)) {
    const tcgdexApi = require('./tcgdexApi');
    const [sets, series] = await Promise.all([
      tcgdexApi.listSets(code),
      // Best-effort: the breakdown loses its grouping without it, but a set list
      // with no series is still a usable set list.
      tcgdexApi.listSeries(code).catch(() => new Map()),
    ]);
    const withSeries = sets.map(s => {
      const serie = series.get(s.id);
      return {
        ...s,
        series: serie ? serie.name : '',
        seriesId: serie ? serie.id : '',
        digital: !!serie && serie.id === tcgdexApi.DIGITAL_SERIES,
      };
    });
    // Only English can borrow dates: the `sets` table holds pokemontcg.io's
    // English releases, and a Japanese set ships on its own date.
    if (code !== 'en') return withSeries;
    const match = setCatalogueMatch.matcher(await dbSetRows(game));
    return withSeries.map((s) => {
      const hit = match(s.id, s.name);
      if (!hit) return s;
      return {
        ...s,
        release_date: hit.release_date || '',
        symbol_url: hit.symbol_url || '',
        logo_url: hit.logo_url || '',
      };
    });
  }
  return await dbSetRows(game);
}

// Some older rows may have NULL game (defaults to 'pokemon'), and MTG ids are
// stored prefixed 'mtg-' while build codes are bare.
async function dbSetRows(game) {
  const db = require('./db');
  return await db.all(
    `SELECT id, name, series, printed_total, total, release_date, symbol_url, logo_url
     FROM sets WHERE game = ?1 OR (game IS NULL AND ?2 = 'pokemon')`,
    [game, game],
  );
}

// The same key utils/setCatalogueMatch joins on. It was a byte-identical copy
// here, which is the one duplication that cannot be caught by a test: the two
// would drift, and the symptom would be a set matching in one place and not the
// other — silently, on a subset of ids.
const normSet = setCatalogueMatch.normId;

// What a built rollup actually covers. A partial index must be able to say so —
// see scanMatch, which reports "outside your indexed range" rather than handing
// back the nearest indexed artwork as if it were the answer.
function rollupScope(game, lang) {
  return (rollupMeta(game, lang) || {}).scope || null;
}

// --- swap ---------------------------------------------------------------

// ponytail: reload() closes the live ORB file descriptors first — Windows can't
// rename over a file with an open handle. A scan starting in the tiny window
// before the rename may reopen the old file, so retry the rename briefly.
async function swapFile(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i >= 15) throw e; await sleep(300); }
  }
}

// Every staged file must exist and be non-empty before anything is swapped: a
// half-written staging dir must not be able to replace a working index piecemeal.
function checkStaged(game, lang, staging) {
  for (const kind of KINDS) {
    for (const name of FILES[kind](game, lang)) {
      const p = path.join(staging, name);
      if (!fs.existsSync(p)) throw new Error(`staged ${name} is missing — not swapping`);
      if (fs.statSync(p).size === 0) throw new Error(`staged ${name} is empty — not swapping`);
    }
  }
  const orbMeta = JSON.parse(fs.readFileSync(path.join(staging, gpaths.names.orbMeta(game, lang))));
  if (!orbMeta.cards.length) throw new Error('staged ORB index has no cards — not swapping');
}

// One job, two completeness targets.
//
//   rollup: true  — index every set AND build the whole-game tables, so scanning
//                   without a set code works. ("Rebuild global index")
//   rollup: false — index every set and stop. ("Index every set")
//
// They are the same walk, which is the point: the second used to be a separate
// button that fired one HTTP request per set with no queue — roughly 460
// concurrent set builds for MTG — while this path did the same work sequentially
// with progress, a failure floor and resume.
async function build(game, lang, { resume = false, rollup = true, only = null, filter = null } = {}) {
  const code = langOf(lang);
  const k = idKey(game, code);
  const staging = stagingDir(game, code);
  // A resume keeps whatever the last attempt staged; a fresh build does not.
  // Either way the per-set indexes on disk are reused — they are the expensive
  // part, and they live outside the staging dir.
  if (!resume) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  running[k] = { cancelled: false };
  update(game, code, {
    phase: 'sets', done: 0, total: 0, fail: 0, status: 'running', rollup,
    startedAt: Date.now(), error: null, lang: code, game,
    // Persisted so Resume continues THIS build. Without them a resume read as a
    // bare (game, lang) and silently escalated a five-set job into a walk over
    // the whole catalogue — hours of downloads nobody asked for.
    only: Array.isArray(only) && only.length ? only : null,
    filter: filter || null,
  });

  try {
    // Check the source before committing to hours of work, rather than leaving it
    // to the user to know they should. This is why issue #29 cost a whole build to
    // discover: a broken card source is detectable in seconds.
    update(game, code, { phase: 'check' });
    await preflight(game, code);
    if (running[k]?.cancelled) throw new Error('build stopped');

    await runWalk(game, code, staging, { rollup, only, filter });
    if (running[k]?.cancelled) throw new Error('build stopped');

    if (!rollup) {
      // Nothing to swap: the per-set indexes are already live where they were
      // written. Coverage is what changed.
      fs.rmSync(staging, { recursive: true, force: true });
      progress[k] = { ...progress[k], phase: 'done', status: 'done', finishedAt: Date.now() };
      console.log(`globalIndex: ${tag(game, code)} set indexes complete`);
      return;
    }

    update(game, code, { phase: 'verify' });
    checkStaged(game, code, staging);

    // Close every open handle on the live files before renaming over them.
    // Windows refuses to rename a file any process still holds open, and the pool
    // workers cache their own descriptors on the global .bin files — so evicting
    // only the main thread's caches would leave the swap failing.
    scanMatch.reload(game, code);
    try { await require('./scanPool').closeGlobalFiles(); }
    catch (e) { console.warn(`globalIndex: could not close pool file handles: ${e.message}`); }
    for (const kind of KINDS) {
      for (const name of FILES[kind](game, code)) {
        await swapFile(path.join(staging, name), path.join(DATA_DIR, name));
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    progress[k] = { ...progress[k], phase: 'done', status: 'done', finishedAt: Date.now() };
    console.log(`globalIndex: ${tag(game, code)} rebuilt`);
  } catch (e) {
    const cancelled = running[k]?.cancelled;
    // Keep the staging dir on failure so --resume has something to continue
    // from. It is cleaned up by the next fresh (non-resume) build.
    progress[k] = {
      ...progress[k],
      status: cancelled ? 'stopped' : 'error',
      error: cancelled ? null : e.message,
      resumable: true,
    };
    persist(game, code);
    if (!cancelled) console.error(`globalIndex: ${tag(game, code)} build failed: ${e.message}`);
  } finally {
    running[k] = null;
  }
}

// Check in seconds that a build could actually succeed, instead of discovering it
// an hour in — which is how issue #29 was found.
//
// It deliberately exercises THE PATH THE BUILD USES: the set list, then one real
// set's card list in the requested language. An earlier version checked a bulk
// card file that the build no longer reads, and which had no language dimension —
// so it would happily pass for Japanese Pokémon while the build itself queried an
// English-only API.
async function preflight(game, lang = 'en') {
  const code = langOf(lang);
  const detail = [];

  const sets = await setIndex.listAllSets(game, code);
  if (!sets.length) {
    throw new Error(`no sets listed for ${game} in ${languages.toName(code)} — this provider may not publish that language`);
  }
  detail.push(`set list OK: ${sets.length} sets`);

  // Sample EVENLY across the list, making no assumption about its order — the two
  // providers disagree: Scryfall's /sets comes back newest-first, TCGdex's
  // oldest-first. Picking "the last few" therefore means the oldest sets for MTG,
  // which are the 1993 core sets that predate non-English printings entirely, so
  // every probe 404s and a perfectly buildable language looks unsupported.
  //
  // Coverage is also genuinely patchy per language, so one miss proves nothing:
  // sample widely and only conclude "unsupported" when nothing at all has data.
  const PROBES = 10;
  const step = Math.max(1, Math.floor(sets.length / PROBES));
  const probeSets = [...new Set(
    Array.from({ length: Math.min(PROBES, sets.length) }, (_, i) => sets[i * step]).filter(Boolean)
  )];

  let probe = null;
  const probeErrors = [];
  for (const set of probeSets) {
    try {
      const count = await setIndex.previewSet(game, set, code);
      if (count > 0) { probe = { set, count }; break; }
      probeErrors.push(`${set}: lists no cards`);
    } catch (e) { probeErrors.push(`${set}: ${e.message}`); }
  }
  if (!probe) {
    throw new Error(
      `no card data for ${game} in ${languages.toName(code)} across ${probeSets.length} sampled sets — ` +
      `this provider may not publish that language. Tried: ${probeErrors.join('; ')}`
    );
  }
  detail.push(`card data OK: ${probe.count} printings in ${probe.set}`);
  if (probeErrors.length) {
    // Say so rather than implying full coverage: a partly-covered language builds
    // fine, it just will not cover every set.
    detail.push(`note: ${probeErrors.length} of ${probeSets.length} sampled sets have no ${languages.toName(code)} data — coverage will be partial`);
  }

  return { sets: sets.length, probeSet: probe.set, detail };
}

// --- folding newly-indexed sets in --------------------------------------
//
// A set indexed by the on-demand scan path is immediately eligible for the
// whole-game rollup: recall is derived from its ORB features, which that path
// already wrote. So there is nothing to top up — the rollup just has to be
// refreshed, which is now a plain concatenation.
//
// This used to be a whole background subsystem, because recall was CLIP: a
// scan-built set had ORB features but no vectors, so it was scannable by set
// code yet invisible to a code-free scan, and granting it vectors meant
// re-downloading every image in the set. Removing CLIP removed the problem
// rather than the workaround.

// Has code-free scanning been built for this game+language? Cheap: stats plus a
// cached meta summary, no provider calls.
//
// The gate matters: refreshing MAINTAINS code-free scanning, it does not create
// it. Building it is a deliberate multi-hour act with a confirmation and a
// progress bar, and a scan must not start one by side effect. The rollup files
// existing is the honest signal that someone already asked for it.
function hasRollup(game, lang) {
  const s = statusOf(game, lang);
  return s.orb.present && (s.orb.hashed || s.bovw.present);
}

// Fold sets indexed since the last rollup into it, once the churn stops.
//
// Debounced because a multi-set scan calls this once per set, and refreshing is
// not free: it rewrites the whole concatenated rollup.
// ponytail: one refresh rebuilds the whole index rather than adding the new set's
// postings to it. Incremental insertion is worth writing only if this shows up as
// a real cost — it runs in the background, 30s after the last set lands.
const refreshTimers = {};
const REFRESH_DEBOUNCE_MS = 30000;

function scheduleRollupRefresh(game, lang = 'en') {
  const code = langOf(lang);
  const k = idKey(game, code);
  if (!hasRollup(game, code)) return;   // maintains code-free scanning, never creates it
  if (refreshTimers[k]) clearTimeout(refreshTimers[k]);
  refreshTimers[k] = setTimeout(() => {
    delete refreshTimers[k];
    refreshRollups(game, code)
      .catch(e => console.warn(`globalIndex: rollup refresh for ${tag(game, code)} failed: ${e.message}`));
  }, REFRESH_DEBOUNCE_MS);
  if (refreshTimers[k].unref) refreshTimers[k].unref();
}

// Rebuild the whole-game tables from every set that is currently indexed.
// Cheap relative to a build: no downloads, no provider calls.
async function refreshRollups(game, lang = 'en') {
  const code = langOf(lang);
  const k = idKey(game, code);
  if (running[k]) return null;
  running[k] = { cancelled: false, rollupOnly: true };
  const staging = path.join(DATA_DIR, `.rollup-${tag(game, code)}`);
  // The progress slot belongs to user-started BUILDS. This refresh borrows it to
  // show activity and hands it back, whatever happens. Two things go wrong
  // otherwise: a refresh that throws leaves status:'running' with nothing left to
  // finish it, so the panel polls a build that does not exist forever; and one
  // that succeeds overwrites an interrupted build's resumable state with 'done',
  // taking the Resume button away from work that is still unfinished. The result
  // of the refresh is visible without any of this — the panel reads the rollup's
  // size and card count straight off the swapped-in files.
  const prev = progress[k];
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    update(game, code, { phase: 'recall', status: 'running', done: 0, total: 0, game, lang: code });
    const stats = await runWalk(game, code, staging, { rollup: true, only: [], rollupOnly: true });
    checkStaged(game, code, staging);
    scanMatch.reload(game, code);
    try { await require('./scanPool').closeGlobalFiles(); } catch { /* pool may be disabled */ }
    for (const kind of KINDS) {
      for (const name of FILES[kind](game, code)) {
        await swapFile(path.join(staging, name), path.join(DATA_DIR, name));
      }
    }
    console.log(`globalIndex: ${tag(game, code)} rollup refreshed (${stats.orb ? stats.orb.cards : '?'} printings)`);
    return stats;
  } finally {
    // On disk as well as in memory: update() mirrors progress into the BUILD's
    // staging dir, and pendingResume() is exactly "is there a progress file
    // there". Left behind, this refresh's borrowed status would have the app
    // offering Resume for a build that never ran.
    if (prev) {
      progress[k] = prev;
      persist(game, code);
    } else {
      delete progress[k];
      try { fs.rmSync(progressFile(game, code), { force: true }); } catch { /* nothing written */ }
      try { fs.rmdirSync(stagingDir(game, code)); } catch { /* not empty, or never created */ }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    running[k] = null;
  }
}

// Start a background (re)build for one game+language. No-op if one is running.
// `rollup: false` indexes every set without building the whole-game tables.
function startBuild(game, lang = 'en', { resume = false, rollup = true, only = null, filter = null } = {}) {
  if (!GAMES.includes(game)) throw new Error('invalid game');
  const k = idKey(game, lang);
  if (running[k]) return false;
  if (!resume && progress[k] && progress[k].status === 'error') {
    delete progress[k];
  }
  build(game, lang, { resume, rollup, only, filter });
  return true;
}

// Resume an interrupted build from whatever its staging dir still holds — and
// with the SAME shape it had. The scope and the rollup flag come back out of the
// saved progress (restoreInterrupted reloads it from disk after a restart), so
// resuming a scoped or rollup-free build cannot quietly turn into a full one.
function resumeBuild(game, lang = 'en') {
  const saved = progress[idKey(game, lang)] || {};
  return startBuild(game, lang, {
    resume: true,
    rollup: saved.rollup !== false,
    only: Array.isArray(saved.only) && saved.only.length ? saved.only : null,
    filter: saved.filter || null,
  });
}

// Is there a staging dir left over from a build that never finished?
function pendingResume(game, lang = 'en') {
  try { return fs.existsSync(progressFile(game, lang)); } catch { return false; }
}

// Kill an in-flight build. The live index is untouched; staged files are kept so
// the build can be resumed.
function stopBuild(game, lang = 'en') {
  const k = idKey(game, lang);
  const state = running[k];
  if (!state) return false;
  // The walk checks this flag between sets, so a stop lands within one set rather
  // than needing a process kill — and the set it was mid-way through is simply
  // rebuilt on resume.
  state.cancelled = true;
  return true;
}

// Upgrade path: a rollup written before orbUnion carried the perceptual-hash
// columns has no recall at all now that BoVW is gone, so code-free scanning reads
// as "not built" the moment the server restarts on the new version.
//
// Without this the only repair offered is Rebuild, which walks the whole
// catalogue — and while it re-downloads nothing (every set index is already
// complete), it still calls loadSet on ~460 sets, pulling each one's desc+kp
// pair into a cache that is never evicted. Hours of wall-clock and gigabytes of
// RAM to reproduce something the per-set metas already hold.
//
// A rollup refresh is that repair: it re-concatenates from those metas, copying
// their hash columns forward, with no provider calls. It cannot help a set index
// that itself predates the columns — that one genuinely needs rebuilding — so
// the refresh is attempted and the result speaks for itself.
async function backfillRecall(langs = ['en']) {
  for (const game of GAMES) {
    for (const lang of [...new Set(langs.map(langOf))]) {
      const k = idKey(game, lang);
      if (running[k]) continue;                       // a real build owns this target
      const s = statusOf(game, lang);
      if (!s.orb.present || s.orb.hashed) continue;
      console.log(`globalIndex: ${tag(game, lang)} rollup predates the hash columns — refreshing it from the per-set indexes`);
      try {
        await refreshRollups(game, lang);
        const after = statusOf(game, lang);
        console.log(after.orb.hashed
          ? `globalIndex: ${tag(game, lang)} recall restored — code-free scanning is back`
          : `globalIndex: ${tag(game, lang)} still has no hashes after refresh — its set indexes predate them and need rebuilding`);
      } catch (e) {
        console.warn(`globalIndex: could not refresh ${tag(game, lang)} rollup: ${e.message}`);
      }
    }
  }
}

// On boot, surface any build that a restart interrupted so the UI can offer
// Resume instead of pretending nothing was in flight.
function restoreInterrupted(langs = ['en']) {
  for (const game of GAMES) {
    for (const lang of [...new Set(langs.map(langOf))]) {
      if (!pendingResume(game, lang)) continue;
      try {
        const saved = JSON.parse(fs.readFileSync(progressFile(game, lang)));
        if (saved.status === 'running') {
          progress[idKey(game, lang)] = { ...saved, status: 'interrupted', resumable: true };
          console.log(`globalIndex: ${tag(game, lang)} build was interrupted — resumable`);
        } else {
          progress[idKey(game, lang)] = saved;
        }
      } catch { /* unreadable progress file: ignore */ }
    }
  }
}

module.exports = {
  listGlobals, getProgress, startBuild, stopBuild, resumeBuild, pendingResume,
  restoreInterrupted, backfillRecall, statusOf, preflight, coverage, listSetIndexes,
  refreshRollups, scheduleRollupRefresh, hasRollup,
  // test/absentsets.test.js: the absent-vs-failed classifier decides whether a
  // non-English build is allowed to finish, so it is worth pinning down.
  _isAbsentForTest: isAbsent,
  _isAbsentFailureForTest: isAbsentFailure,
  // test/indexstate.test.js: the reason buckets are what the coverage panel
  // groups by, so a misfiled message shows up as a wrong count, not an error.
  _absentReasonForTest: absentReason,
  _coverageBreakdownForTest: coverageBreakdown,
};
