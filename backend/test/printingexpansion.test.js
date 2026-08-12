// Printing disambiguation (scanMatch, GLOBAL_PRINTING_EXPANSION=1).
//
// The CLIP index holds one printing per artwork, so a scanned reprint resolves to
// whichever printing Scryfall chose — right card, wrong set/number. The union ORB
// index holds every printing, so verification can pick the real one. These cover
// the parts that need no model and no network: that the name index is built only
// when the feature is on, that it groups every printing of a name, and that the
// expansion respects its bounds.
//
// The bounds matter: unbounded expansion would multiply ORB verifies per scan and
// turn an accuracy win into a latency regression.
// No framework — plain node + assert. Run: `node test/printingexpansion.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-expand-'));
process.env.INDEX_DATA_DIR = tmp;

const orbUnion = require('../src/orbUnion');
const { DESC_BYTES, KP_BYTES } = orbUnion;

// A global ORB index where "Lightning Bolt" has three printings (one of them
// double-faced, so two rows share a set|number) and "Opt" has one.
const ROWS = [
  ['Lightning Bolt', 'lea', '161'],
  ['Lightning Bolt', 'm10', '146'],
  ['Lightning Bolt', 'a25', '141'],
  ['Lightning Bolt', 'a25', '141'],   // second face: same printing, extra row
  ['Opt', 'dmu', '58'],
];
const COUNT = 4;

function writeIndex() {
  const cards = [];
  let offset = 0;
  for (const [name, set, number] of ROWS) {
    cards.push([name, set, number, offset, COUNT]);
    offset += COUNT;
  }
  fs.writeFileSync(path.join(tmp, 'mtg-orb-desc.bin'), Buffer.alloc(offset * DESC_BYTES, 7));
  fs.writeFileSync(path.join(tmp, 'mtg-orb-kp.bin'), Buffer.alloc(offset * KP_BYTES));
  fs.writeFileSync(path.join(tmp, 'mtg-orb-meta.json'), JSON.stringify({ cap: 500, refWidth: 500, lang: 'en', cards }));
  return offset;
}

// loadOrbDb is module-private, so reach it the way a scan does: through a fresh
// require of scanMatch with the env already set.
function freshScanMatch() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('scanMatch') || k.includes('globalIndexPaths')) delete require.cache[k];
  }
  return require('../src/scanMatch');
}

function main() {
  const descriptors = writeIndex();
  assert.strictEqual(descriptors, ROWS.length * COUNT);
  // The fixture must itself be a valid union, or nothing below means anything.
  orbUnion.verifyUnion({
    desc: path.join(tmp, 'mtg-orb-desc.bin'),
    kp: path.join(tmp, 'mtg-orb-kp.bin'),
    meta: path.join(tmp, 'mtg-orb-meta.json'),
  });

  // 1. Off by default: no name index is built, so the feature costs nothing.
  delete process.env.GLOBAL_PRINTING_EXPANSION;
  let sm = freshScanMatch();
  let db = sm._loadOrbDbForTest('mtg', 'en');
  assert.ok(db, 'index should load');
  assert.strictEqual(db.byName, null, 'no name index unless expansion is enabled');
  assert.strictEqual(db.map.size, 4, 'four distinct set|number keys');
  assert.strictEqual(db.map.get('a25|141').length, 2, 'both faces kept under one key');

  // 2. On: every printing of a name is grouped, deduped per printing.
  process.env.GLOBAL_PRINTING_EXPANSION = '1';
  sm = freshScanMatch();
  db = sm._loadOrbDbForTest('mtg', 'en');
  assert.ok(db.byName, 'name index built when enabled');
  assert.strictEqual(db.byName.size, 2, 'two distinct card names');

  const bolts = db.byName.get('Lightning Bolt');
  assert.strictEqual(bolts.length, 3, 'three printings, not four rows — DFC faces collapse');
  assert.deepStrictEqual(
    bolts.map(b => `${b.set}|${b.number}`).sort(),
    ['a25|141', 'lea|161', 'm10|146'],
    'every printing of the name is reachable',
  );
  // Each entry's key must resolve in the offset map, or expansion would verify
  // against nothing and silently score 0.
  for (const b of bolts) assert.ok(db.map.has(b.k), `${b.k} resolves to descriptors`);

  assert.strictEqual(db.byName.get('Opt').length, 1, 'a single-printing card expands to itself only');
  assert.strictEqual(db.byName.get('Nonexistent'), undefined);

  // 3. The bounds are read from the environment, so a latency regression can be
  //    dialled back without a code change.
  assert.strictEqual(sm._expansionConfigForTest().enabled, true);
  process.env.GLOBAL_PRINTING_EXPANSION_TOP = '3';
  process.env.GLOBAL_PRINTING_EXPANSION_MAX = '7';
  sm = freshScanMatch();
  const cfg = sm._expansionConfigForTest();
  assert.strictEqual(cfg.top, 3);
  assert.strictEqual(cfg.max, 7);

  // A garbage value must not disable the bound entirely (NaN would compare false
  // against every budget check and expand without limit).
  process.env.GLOBAL_PRINTING_EXPANSION_TOP = 'not-a-number';
  sm = freshScanMatch();
  assert.ok(Number.isFinite(sm._expansionConfigForTest().top), 'bound stays finite on bad input');
  assert.ok(sm._expansionConfigForTest().top >= 1, 'bound stays at least 1');

  delete process.env.GLOBAL_PRINTING_EXPANSION;
  delete process.env.GLOBAL_PRINTING_EXPANSION_TOP;
  delete process.env.GLOBAL_PRINTING_EXPANSION_MAX;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('printingexpansion.test.js: all assertions passed');
}

try { main(); process.exit(0); }
catch (err) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave it */ }
  console.error(err);
  process.exit(1);
}
