// Reading the STATE of a set index must never cost what reading the index costs.
//
// isReady/metaSummary are called once per set across the whole catalogue —
// globalIndex.coverage walks every set, and the admin panel asks for every set's
// row every 1.5s while a build runs. isReady used to answer by calling loadSet,
// which pulls a set's whole desc+kp pair (~5 MB for a large MTG set) into a cache
// that is never evicted: ~460 of those, on a timer, to report two integers per
// set.
//
// So the properties worth pinning are that these two read only what they need,
// that a half-written index does not read as usable, and that one unreadable meta
// cannot take down an enumeration of the other 459.
// Run: `node test/indexstate.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-indexstate-'));
process.env.SETS_DIR = SETS_DIR;
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-indexstate-${process.pid}.db`);
process.env.SCAN_WORKERS = '0';

const setIndex = require('../src/setIndex');

const base = (game, set, lang) => {
  const suffix = !lang || lang === 'en' ? '' : `-${lang}`;
  return path.join(SETS_DIR, `${game}-${set}${suffix}-orb`);
};
const writeMeta = (b, obj) => fs.writeFileSync(`${b}-meta.json`, typeof obj === 'string' ? obj : JSON.stringify(obj));
const writeBins = (b) => {
  fs.writeFileSync(`${b}-desc.bin`, Buffer.alloc(32));
  fs.writeFileSync(`${b}-kp.bin`, Buffer.alloc(8));
};

// --- 1. A half-written index is not ready ------------------------------------
// A build that wrote its meta and died before the bins used to satisfy isReady,
// because loadSet only checked for the meta before reading all three. The scan
// then failed inside matchSet on a missing file instead of skipping the set.
const half = base('mtg', 'half');
writeMeta(half, { set: 'half', lang: 'en', hashed: true, cards: [['A', 'half', '1', 0, 1, 0, 0]] });
assert.ok(!setIndex.isReady('mtg', 'half'), 'meta without bins must not read as ready');

fs.writeFileSync(`${half}-desc.bin`, Buffer.alloc(32));
assert.ok(!setIndex.isReady('mtg', 'half'), 'still not ready with the keypoints missing');

fs.writeFileSync(`${half}-kp.bin`, Buffer.alloc(8));
assert.ok(setIndex.isReady('mtg', 'half'), 'ready once all three parts exist');

// An empty meta is not an index either, whatever the bins say.
const empty = base('mtg', 'empty');
writeBins(empty);
writeMeta(empty, '');
assert.ok(!setIndex.isReady('mtg', 'empty'), 'a zero-byte meta is not an index');

// --- 2. One unreadable meta must not break an enumeration --------------------
// Every caller of these three loops over the whole catalogue. Throwing on a
// single corrupt file turns "one set needs rebuilding" into a 500 for the entire
// scan-index panel, which is how you lose the screen that would have told you.
const bad = base('mtg', 'corrupt');
writeBins(bad);
writeMeta(bad, '{ this is not json');
assert.doesNotThrow(() => setIndex.isReady('mtg', 'corrupt'), 'isReady tolerates a corrupt meta');
assert.strictEqual(setIndex.metaSummary('mtg', 'corrupt'), null, 'and reports no summary for it');
assert.doesNotThrow(() => setIndex.listBuilds(), 'listBuilds skips it rather than aborting');
assert.ok(!setIndex.listBuilds().some(b => b.set === 'corrupt'), 'the corrupt index is not listed');

// A set nobody ever built has no summary — not a throw, not a zeroed one.
assert.strictEqual(setIndex.metaSummary('mtg', 'neverbuilt'), null);

// --- 3. metaSummary reports counts without handing back the rows -------------
// The rows are the expensive part (hundreds of KB per large set) and no caller
// wants them, so holding them would defeat the point of the summary.
const full = base('pokemon', 'sv1', 'ja');
writeBins(full);
writeMeta(full, {
  set: 'sv1', lang: 'ja', hashed: true,
  cards: [['A', 'sv1', '1', 0, 1, 0, 0], ['B', 'sv1', '2', 1, 1, 0, 0]],
});
let summary = setIndex.metaSummary('pokemon', 'sv1', 'ja');
assert.strictEqual(summary.cards, 2, 'card count');
assert.strictEqual(summary.set, 'sv1');
assert.strictEqual(summary.lang, 'ja');
assert.ok(!Array.isArray(summary.cards), 'the summary holds counts, not rows');

// The language is part of the identity: an English index must not answer for ja.
assert.strictEqual(setIndex.metaSummary('pokemon', 'sv1', 'en'), null);

// --- 4. A rebuilt index is re-read, not served stale --------------------------
// The summary is cached against the file's mtime+size, so the cache must not
// outlive the file it describes — a set rebuilt with more cards has to report
// the new count or the panel shows yesterday's numbers forever.
writeMeta(full, {
  set: 'sv1', lang: 'ja', hashed: true,
  cards: [['A', 'sv1', '1', 0, 1, 0, 0], ['B', 'sv1', '2', 1, 1, 0, 0], ['C', 'sv1', '3', 2, 1, 0, 0]],
});
summary = setIndex.metaSummary('pokemon', 'sv1', 'ja');
assert.strictEqual(summary.cards, 3, 'a rewritten meta is re-read');

// Deleting the build invalidates it rather than leaving a summary for a file
// that is gone.
setIndex.deleteBuild('pokemon', 'sv1', 'ja');
assert.strictEqual(setIndex.metaSummary('pokemon', 'sv1', 'ja'), null, 'deleted index has no summary');
assert.ok(!setIndex.isReady('pokemon', 'sv1', 'ja'), 'and is no longer ready');

fs.rmSync(SETS_DIR, { recursive: true, force: true });
console.log('indexstate.test.js: all assertions passed');
process.exit(0);
