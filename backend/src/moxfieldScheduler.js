// Moxfield sync scheduler: one 20-second tick drives both sync jobs.
//
// The two cadences are instance settings (app_settings, editable from the
// Moxfield tab in the UI):
//
//   moxfield_decklist_interval_min — how often each author's deck list is
//     re-listed (default 60 = hourly). Catches new decks, removed decks,
//     author-profile changes.
//
//   moxfield_content_interval_min  — how often each tracked deck's contents are
//     checked for changes (default 1). The check itself is one summary call
//     per author; only decks whose Moxfield stamp moved are pulled in full.
//
// Per-author timestamps live in memory, so a newly added author never drags the
// others' schedules with it, and changing an interval takes effect on the next
// tick without a restart. Everything is fire-and-forget with its own
// in-flight guard: a hung Moxfield response must never block the next tick, and
// overlapping runs of one author would double-pull (and double-pay) the cards.
const db = require('./db');
const moxfieldSync = require('./moxfieldSync');

const TICK_MS = 20 * 1000;
const DEFAULT_DECKLIST_MIN = 60;
const DEFAULT_CONTENT_MIN = 1;
const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 24 * 60; // a week is plenty for a decklist

const lastDecklistAt = new Map(); // authorId -> epoch ms
const lastContentAt = new Map(); //  authorId -> epoch ms
const inFlight = new Set(); //      author ids with a sync running

function clampInterval(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MIN) return fallback;
  return Math.min(n, MAX_INTERVAL_MIN);
}

async function readIntervals() {
  const row = await db.get(
    `SELECT moxfield_decklist_interval_min, moxfield_content_interval_min FROM app_settings WHERE id = 1`
  );
  return {
    decklistMin: clampInterval(row ? row.moxfield_decklist_interval_min : null, DEFAULT_DECKLIST_MIN),
    contentMin: clampInterval(row ? row.moxfield_content_interval_min : null, DEFAULT_CONTENT_MIN)
  };
}

async function tick() {
  let authors;
  try {
    authors = await db.all(`SELECT id, user_id, moxfield_user FROM moxfield_authors ORDER BY id`);
  } catch (err) {
    console.warn(`Moxfield scheduler: could not list authors (${err.message})`);
    return;
  }
  if (authors.length === 0) return; // nobody tracks Moxfield — nothing to do

  const { decklistMin, contentMin } = await readIntervals();
  const now = Date.now();

  for (const author of authors) {
    if (inFlight.has(author.id)) continue; // one sync per author at a time

    // Decklist first: it is what creates the tracking rows the content check
    // needs, and it also retires deleted decks.
    const decklistDue = now - (lastDecklistAt.get(author.id) || 0) >= decklistMin * 60 * 1000;
    const contentDue = now - (lastContentAt.get(author.id) || 0) >= contentMin * 60 * 1000;

    // Only one of the two should run per tick: the slower one wins when both
    // are due, because a decklist pass already refreshes every stamp — running
    // the content check a moment later would re-fetch the same summaries.
    let job = null;
    let mark = null;
    if (decklistDue) { job = 'decklist'; mark = lastDecklistAt; }
    else if (contentDue) { job = 'content'; mark = lastContentAt; }
    if (!job) continue;

    mark.set(author.id, now);
    inFlight.add(author.id);
    try {
      if (job === 'decklist') {
        const report = await moxfieldSync.syncDecklist(author.id, { user: { id: author.user_id } });
        console.log(`Moxfield sync: decklist for ${author.moxfield_user} — ${report.decks_created} new, ${report.decks_removed} removed, ${report.decks_on_moxfield} total`);
      } else {
        const report = await moxfieldSync.runContentSync(author.id, { user: { id: author.user_id } });
        if (report.updated > 0) {
          console.log(`Moxfield sync: ${report.updated} of ${report.checked} decks for ${author.moxfield_user} changed on Moxfield — mirrored`);
        }
      }
    } catch (err) {
      // Record it on the author row so the UI can show what went wrong, and
      // back off this tick only — the next due tick retries.
      console.warn(`Moxfield sync (${job}) for ${author.moxfield_user} failed: ${err.message}`);
      db.run(`UPDATE moxfield_authors SET last_error = ? WHERE id = ?`, [err.message, author.id])
        .catch(() => {});
    } finally {
      inFlight.delete(author.id);
    }
  }
}

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC — normalize to a
// parseable ISO form before the age math.
function parseSqliteUtc(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  return Number.isFinite(ms) ? ms : 0;
}

// Boot catch-up: an author added before the restart owes both jobs. Everything
// else runs on its normal clock — a restart must not mean a full re-pull of
// every deck (the price sweeps solve this same problem the same way: check the
// persisted stamp before acting).
async function bootCatchUp() {
  const authors = await db.all(
    `SELECT a.id, a.user_id, a.moxfield_user, a.last_decklist_sync_at
     FROM moxfield_authors a`
  );
  const { decklistMin } = await readIntervals();
  const now = Date.now();
  for (const a of authors) {
    // A never-synced author (NULL stamp) or one whose last decklist is older
    // than the interval runs the full decklist, which pulls new decks'
    // contents on the way.
    const last = parseSqliteUtc(a.last_decklist_sync_at);
    const decklistStale = last === 0 || now - last >= decklistMin * 60 * 1000;
    if (decklistStale && !inFlight.has(a.id)) {
      inFlight.add(a.id);
      lastDecklistAt.set(a.id, now);
      moxfieldSync.syncDecklist(a.id, { user: { id: a.user_id } })
        .then(() => console.log(`Moxfield sync: boot decklist for ${a.moxfield_user} complete`))
        .catch(err => console.warn(`Moxfield sync: boot decklist for ${a.moxfield_user} failed: ${err.message}`))
        .finally(() => inFlight.delete(a.id));
    }
  }
}

function startMoxfieldScheduler() {
  bootCatchUp().catch(err => console.warn(`Moxfield sync boot catch-up failed: ${err.message}`));
  const timer = setInterval(() => { tick().catch(err => console.warn(`Moxfield scheduler tick failed: ${err.message}`)); }, TICK_MS);
  // Never keep the event loop alive on this timer alone (tests, `node --check`).
  timer.unref();
  return timer;
}

module.exports = { startMoxfieldScheduler, clampInterval, tick, readIntervals };
