// In-app management of the GLOBAL scan indexes (whole-game CLIP + ORB DBs used
// when a scan has no set hint).
//
// A build has two halves, and they are built very differently on purpose:
//
//   CLIP embeddings — one vector per card, the recall stage. Genuinely global:
//     every card must live in one flat array to be ranked against a query. Built
//     by spawning scripts/build-card-embeddings.mjs, which streams the card list
//     and encodes images concurrently.
//
//   ORB descriptors — the verification stage, keyed by `set|number` and read
//     lazily per candidate. NOT built here at all: it is the concatenation of
//     the per-set indexes setIndex already builds (see src/orbUnion.js). That
//     makes it chunked and resumable — an interrupted build costs one set, not
//     hours — and reuses any set the user already built for set-scoped scanning.
//
// Output is written to a staging dir and swapped over the live files at the end,
// so scans keep using the previous index until a build actually finishes.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const scanMatch = require('./scanMatch');
const embedMatch = require('./embedMatch');
const setIndex = require('./setIndex');
const orbUnion = require('./orbUnion');
const languages = require('./utils/languages');

// INDEX_DATA_DIR points the scan indexes at a persisted, writable location in
// Docker (the named volume); defaults to backend/data for local dev.
const DATA_DIR = process.env.INDEX_DATA_DIR || path.join(__dirname, '..', 'data');
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const GAMES = ['mtg', 'pokemon'];

// A build whose success rate falls below this is refused rather than swapped in.
// Before this existed, a build that failed every single download exited 0 and
// clobbered a working index with an empty one.
const MIN_SUCCESS_RATE = 0.95;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// English keeps the original un-suffixed filenames so every index built before
// languages existed is still found instead of silently rebuilt — the same
// back-compat trick setIndex.paths() uses for per-set indexes.
const langOf = (lang) => languages.toCode(lang);
const tag = (game, lang) => (langOf(lang) === 'en' ? game : `${game}-${langOf(lang)}`);
const idKey = (game, lang) => `${game}|${langOf(lang)}`;

const FILES = {
  embed: (game, lang) => [`${tag(game, lang)}-embed.bin`, `${tag(game, lang)}-embed-meta.json`],
  orb: (game, lang) => [`${tag(game, lang)}-orb-desc.bin`, `${tag(game, lang)}-orb-kp.bin`, `${tag(game, lang)}-orb-meta.json`],
};
const metaName = (game, lang, kind) => `${tag(game, lang)}-${kind}-meta.json`;

const progress = {};   // "game|lang" -> { phase, done, total, status, error?, ... }
const running = {};    // "game|lang" -> { child?: ChildProcess, cancelled?: boolean }

function statOf(name) {
  try { const st = fs.statSync(path.join(DATA_DIR, name)); return { size: st.size, mtime: st.mtimeMs }; }
  catch { return null; }
}

function stagingDir(game, lang) { return path.join(DATA_DIR, `.staging-${tag(game, lang)}`); }
function progressFile(game, lang) { return path.join(stagingDir(game, lang), 'progress.json'); }

// On-disk status for one (game, language): for each kind, whether it's built,
// byte size, card/row count and build time. Drives the admin table.
function statusOf(game, lang) {
  const kinds = {};
  for (const kind of ['embed', 'orb']) {
    const stats = FILES[kind](game, lang).map(statOf);
    const present = stats.every(Boolean);
    const bytes = stats.reduce((s, x) => s + (x ? x.size : 0), 0);
    const builtAt = stats.reduce((m, x) => Math.max(m, x ? x.mtime : 0), 0);
    let cards = 0;
    try { cards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, metaName(game, lang, kind)))).cards.length; }
    catch { /* not built yet */ }
    kinds[kind] = { present, bytes, builtAt, cards };
  }
  return { game, lang: langOf(lang), embed: kinds.embed, orb: kinds.orb };
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

// --- CLIP half: spawn the builder and read its progress ------------------

// The builder reports structured events as NDJSON on fd 3, keeping stdout free
// for human-readable logs. Parsing stdout with regexes (which is what this used
// to do) broke silently whenever a log line was reworded, and could not express
// anything but a card counter — so the several minutes spent fetching the card
// list showed as a frozen 0%, which is exactly what issue #29's reporter saw and
// had no way to interpret.
function runEmbedBuild(game, lang, staging, { resume }) {
  return new Promise((resolve, reject) => {
    const args = [path.join(SCRIPTS_DIR, 'build-card-embeddings.mjs'), '--game', game, '--lang', langOf(lang)];
    if (resume) args.push('--resume');
    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, INDEX_OUT_DIR: staging },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],   // fd 3 = the event channel
    });
    running[idKey(game, lang)] = { ...running[idKey(game, lang)], child };

    let evBuf = '';
    child.stdio[3].on('data', (d) => {
      evBuf += d.toString();
      const lines = evBuf.split('\n');
      evBuf = lines.pop();
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try {
          const ev = JSON.parse(ln);
          if (ev.ev === 'progress') {
            update(game, lang, {
              phase: ev.phase, done: ev.done || 0, total: ev.total || 0,
              fail: ev.fail || 0, rate: ev.rate || 0, eta: ev.eta || 0,
            });
          } else if (ev.ev === 'error') {
            update(game, lang, { lastErr: ev.message });
          }
        } catch { /* a partial line is not worth failing the build over */ }
      }
    });
    child.stdout.on('data', (d) => {
      for (const ln of d.toString().split('\n')) if (ln.trim()) console.log(`[global ${tag(game, lang)}/embed] ${ln}`);
    });
    child.stderr.on('data', (d) => { update(game, lang, { lastErr: d.toString().slice(-800) }); });
    child.on('error', reject);
    child.on('close', (code) => {
      const state = running[idKey(game, lang)];
      if (state) state.child = null;
      if (code === 0) return resolve();
      const err = progress[idKey(game, lang)]?.lastErr || '';
      reject(new Error(`build-card-embeddings.mjs exited ${code}${err ? `: ${err}` : ''}`));
    });
  });
}

// --- ORB half: union of the per-set indexes ------------------------------

// Build (or reuse) every set's ORB index, then concatenate them. Sets already on
// disk are reused as-is, so a rerun after an interruption only pays for the sets
// it had not reached.
async function runOrbUnion(game, lang, staging) {
  const code = langOf(lang);
  update(game, lang, { phase: 'sets', done: 0, total: 0, fail: 0 });
  const sets = await setIndex.listAllSets(game, code);
  if (!sets.length) throw new Error(`no sets listed for ${game} (${code}) — nothing to index`);
  update(game, lang, { total: sets.length });

  let failed = 0;
  for (let i = 0; i < sets.length; i++) {
    if (running[idKey(game, lang)]?.cancelled) throw new Error('build stopped');
    const set = sets[i];
    try {
      const ok = await setIndex.ensureSet(game, set, code);
      if (!ok) failed++;
    } catch { failed++; }
    update(game, lang, { done: i + 1, fail: failed, currentSet: set });
  }

  // A handful of sets legitimately have no card data in a given language, so a
  // few failures are expected. Wholesale failure means something systemic.
  const built = sets.length - failed;
  if (built / sets.length < MIN_SUCCESS_RATE) {
    throw new Error(`only ${built}/${sets.length} sets indexed for ${game} (${code}) — refusing to build a partial global index`);
  }

  update(game, lang, { phase: 'orb', done: 0, total: sets.length });
  const outPaths = {
    desc: path.join(staging, `${tag(game, code)}-orb-desc.bin`),
    kp: path.join(staging, `${tag(game, code)}-orb-kp.bin`),
    meta: path.join(staging, `${tag(game, code)}-orb-meta.json`),
  };
  const stats = await orbUnion.unionSets({
    sets,
    resolveSet: (set) => setIndex.paths(game, set, code),
    outPaths,
    cap: setIndex.CAP,
    refWidth: setIndex.REF_WIDTH,
    lang: code,
    onSet: (i, total) => update(game, lang, { done: i, total }),
  });
  orbUnion.verifyUnion(outPaths);
  console.log(`[global ${tag(game, code)}/orb] ${stats.cards} cards, ${stats.descriptors} descriptors ` +
    `(${stats.missing} sets missing, ${stats.skipped} rows skipped)`);
  return stats;
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
  for (const kind of ['embed', 'orb']) {
    for (const name of FILES[kind](game, lang)) {
      const p = path.join(staging, name);
      if (!fs.existsSync(p)) throw new Error(`staged ${name} is missing — not swapping`);
      if (fs.statSync(p).size === 0) throw new Error(`staged ${name} is empty — not swapping`);
    }
  }
  const embedMeta = JSON.parse(fs.readFileSync(path.join(staging, metaName(game, lang, 'embed'))));
  const embedBytes = fs.statSync(path.join(staging, FILES.embed(game, lang)[0])).size;
  const expected = embedMeta.cards.length * embedMeta.dim * 4;
  if (embedBytes !== expected) {
    throw new Error(`staged embed.bin is ${embedBytes} bytes, meta describes ${expected} — not swapping`);
  }
  if (!embedMeta.cards.length) throw new Error('staged embed index has no cards — not swapping');
}

async function build(game, lang, { resume = false } = {}) {
  const code = langOf(lang);
  const k = idKey(game, code);
  const staging = stagingDir(game, code);
  // A resume keeps whatever the last attempt staged; a fresh build does not.
  if (!resume) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  running[k] = { cancelled: false, child: null };
  update(game, code, {
    phase: 'gather', done: 0, total: 0, fail: 0, status: 'running',
    startedAt: Date.now(), error: null, lang: code, game,
  });

  try {
    await runEmbedBuild(game, code, staging, { resume });
    if (running[k]?.cancelled) throw new Error('build stopped');
    await runOrbUnion(game, code, staging);

    update(game, code, { phase: 'verify' });
    checkStaged(game, code, staging);

    // Close every open handle on the live files before renaming over them.
    // Windows refuses to rename a file any process still holds open, and the pool
    // workers cache their own descriptors on the global .bin files — so evicting
    // only the main thread's caches would leave the swap failing.
    embedMatch.reload(game, code);
    scanMatch.reload(game, code);
    try { await require('./scanPool').closeGlobalFiles(); }
    catch (e) { console.warn(`globalIndex: could not close pool file handles: ${e.message}`); }
    for (const kind of ['embed', 'orb']) {
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

// Check that a build could actually succeed: the card source resolves, sample
// images download, the encoder loads, and the set list is reachable. Runs in
// seconds. Delegates the first three to the builder's own --preflight so there is
// one definition of "is the source usable".
function preflight(game, lang = 'en') {
  const code = langOf(lang);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, 'build-card-embeddings.mjs'), '--game', game, '--lang', code, '--preflight'],
      { cwd: path.join(__dirname, '..') },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', async (codeExit) => {
      if (codeExit !== 0) {
        // The builder prints the actionable message; prefer it over an exit code.
        const lines = (err || out).trim().split('\n').filter(Boolean);
        return reject(new Error(lines[lines.length - 1] || `preflight exited ${codeExit}`));
      }
      // The ORB half comes from per-set builds, so a global build also needs the
      // set list — worth checking here rather than 40 minutes in.
      try {
        const sets = await setIndex.listAllSets(game, code);
        if (!sets.length) return reject(new Error(`no sets listed for ${game} (${code})`));
        resolve({ sets: sets.length, detail: out.trim().split('\n').slice(-4) });
      } catch (e) {
        reject(new Error(`set list unavailable: ${e.message}`));
      }
    });
  });
}

// Start a background (re)build for one game+language. No-op if one is running.
function startBuild(game, lang = 'en', { resume = false } = {}) {
  if (!GAMES.includes(game)) throw new Error('invalid game');
  const k = idKey(game, lang);
  if (running[k]) return false;
  build(game, lang, { resume });
  return true;
}

// Resume an interrupted build from whatever its staging dir still holds.
function resumeBuild(game, lang = 'en') { return startBuild(game, lang, { resume: true }); }

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
  state.cancelled = true;
  if (state.child) state.child.kill();
  return true;
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
  restoreInterrupted, statusOf, preflight,
};
