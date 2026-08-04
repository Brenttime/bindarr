// Runnable checks for language-scoped set indexes (issue #25, phase 3).
//
// Two things must hold, and both are easy to break silently:
//   1. English indexes keep their ORIGINAL filenames. Suffixing them would
//      orphan every index built before languages existed — the app would look
//      like it had lost hours of build work and start rebuilding.
//   2. Every other language gets its own files and its own cache key, because
//      card art is language-specific: an English index cannot match a Japanese
//      print, so sharing a key would return "no match" forever.
// Run: `node test/setindexlang.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-setsdir-'));
process.env.SETS_DIR = SETS_DIR;
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-setindexlang-${process.pid}.db`);
process.env.SCAN_WORKERS = '0'; // no worker threads for a file-layout test

const setIndex = require('../src/setIndex');

// Write a fake built index for (game, set, lang) the way buildSet does.
function writeIndex(game, set, lang, cards) {
  const suffix = !lang || lang === 'en' ? '' : `-${lang}`;
  const norm = set.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = path.join(SETS_DIR, `${game}-${norm}${suffix}-orb`);
  fs.writeFileSync(`${base}-desc.bin`, Buffer.alloc(32));
  fs.writeFileSync(`${base}-kp.bin`, Buffer.alloc(8));
  fs.writeFileSync(`${base}-meta.json`, JSON.stringify({ set, lang: lang || 'en', hashed: true, cards }));
  return base;
}

// --- 1. English keeps the legacy, un-suffixed filenames -----------------------
// This is exactly what an index built by an older version looks like: no lang in
// the filename and no lang in the meta.
const legacyBase = path.join(SETS_DIR, 'mtg-mh3-orb');
fs.writeFileSync(`${legacyBase}-desc.bin`, Buffer.alloc(32));
fs.writeFileSync(`${legacyBase}-kp.bin`, Buffer.alloc(8));
fs.writeFileSync(`${legacyBase}-meta.json`, JSON.stringify({ set: 'mh3', hashed: true, cards: [['Card', 'mh3', '1', 0, 1, 0, 0]] }));

assert.ok(setIndex.isReady('mtg', 'mh3'), 'a pre-language index must still be found with no lang passed');
assert.ok(setIndex.isReady('mtg', 'mh3', 'en'), 'and when English is passed explicitly');
assert.ok(!setIndex.isReady('mtg', 'mh3', 'ja'), 'but it must NOT satisfy a Japanese scan');

// --- 2. Each language is its own index ---------------------------------------
writeIndex('mtg', 'mh3', 'ja', [['稲妻', 'mh3', '1', 0, 1, 0, 0]]);
assert.ok(setIndex.isReady('mtg', 'mh3', 'ja'), 'Japanese index found once built');
assert.ok(setIndex.isReady('mtg', 'mh3', 'en'), 'building Japanese must not disturb English');
assert.ok(!setIndex.isReady('mtg', 'mh3', 'de'), 'German is still unbuilt');

// Language spellings/aliases all land on the same index.
assert.ok(setIndex.isReady('mtg', 'mh3', 'Japanese'), 'display name resolves to the same index');
assert.ok(setIndex.isReady('mtg', 'MH3', 'ja'), 'set code is normalized');

// --- 3. listBuilds reports the language, and one set can appear per language ---
writeIndex('pokemon', 'sv2a', 'zh-tw', [['皮卡丘', 'SV2a', '025', 0, 1, 0, 0]]);
const builds = setIndex.listBuilds();
const byKey = new Map(builds.map(b => [b.key, b]));

assert.ok(byKey.has('mtg|mh3|en'), `English build listed: ${[...byKey.keys()]}`);
assert.ok(byKey.has('mtg|mh3|ja'), 'Japanese build listed separately');
assert.ok(byKey.has('pokemon|sv2a|zh-tw'), 'a two-part language code survives the filename round trip');
assert.strictEqual(byKey.get('mtg|mh3|en').lang, 'en', 'a legacy index with no lang in its meta reads as English');
assert.strictEqual(byKey.get('mtg|mh3|ja').lang, 'ja');
assert.strictEqual(byKey.get('pokemon|sv2a|zh-tw').lang, 'zh-tw');
assert.strictEqual(byKey.get('mtg|mh3|ja').set, 'mh3', 'the set code is not eaten by the language segment');
assert.strictEqual(byKey.get('mtg|mh3|ja').cardCount, 1);

// --- 4. deleteBuild removes only the language it was asked for ----------------
setIndex.deleteBuild('mtg', 'mh3', 'ja');
assert.ok(!setIndex.isReady('mtg', 'mh3', 'ja'), 'Japanese index gone');
assert.ok(setIndex.isReady('mtg', 'mh3', 'en'), 'English index untouched by deleting Japanese');
assert.ok(fs.existsSync(`${legacyBase}-desc.bin`), 'and its files are still on disk');

// Deleting with no language means English — the same default every other call has.
setIndex.deleteBuild('mtg', 'mh3');
assert.ok(!setIndex.isReady('mtg', 'mh3'), 'English index removed');

fs.rmSync(SETS_DIR, { recursive: true, force: true });
console.log('setindexlang.test.js: all assertions passed');
process.exit(0);
