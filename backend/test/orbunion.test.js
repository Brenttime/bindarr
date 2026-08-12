// The global ORB index is assembled by concatenating the per-set indexes and
// rebasing their descriptor offsets (src/orbUnion.js). That rebasing is the
// load-bearing claim of the whole approach: if a row's offset is off by even one
// descriptor, the index still loads, still reports a healthy card count, and
// silently verifies every query against the wrong card's features. There is no
// error to notice — matching just stops working.
//
// So these assert byte-identity: every descriptor and keypoint reachable through
// the global meta must be the exact bytes reachable through the per-set meta it
// came from. No framework — plain node + assert.
// Run: `node test/orbunion.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orbUnion = require('../src/orbUnion');
const { DESC_BYTES, KP_BYTES } = orbUnion;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-orbunion-'));
const setPaths = (name) => ({
  desc: path.join(tmp, `${name}-desc.bin`),
  kp: path.join(tmp, `${name}-kp.bin`),
  meta: path.join(tmp, `${name}-meta.json`),
});

// Deterministic, per-card-unique descriptor bytes so a mix-up is detectable:
// every byte of card `seed`'s descriptors encodes `seed`.
function fakeCard(seed, count) {
  const desc = Buffer.alloc(count * DESC_BYTES);
  for (let i = 0; i < desc.length; i++) desc[i] = (seed * 7 + i) % 256;
  const kp = Buffer.alloc(count * KP_BYTES);
  const f = new Float32Array(kp.buffer, kp.byteOffset, count * 2);
  for (let i = 0; i < count * 2; i++) f[i] = seed * 1000 + i + 0.5;
  return { desc, kp };
}

// Write a per-set index whose cards are [name, set, number, count] tuples.
// `hashed: true` rows carry the two extra dHash columns real per-set builds have.
function writeSetIndex(name, set, lang, cards) {
  const p = setPaths(name);
  const descChunks = [], kpChunks = [], rows = [];
  let offset = 0;
  cards.forEach((c, i) => {
    const { desc, kp } = fakeCard(c.seed, c.count);
    descChunks.push(desc); kpChunks.push(kp);
    // hi/lo dHash columns present, exactly as setIndex.buildSet writes them.
    rows.push([c.name, set, c.number, offset, c.count, 1000 + i, 2000 + i]);
    offset += c.count;
  });
  fs.writeFileSync(p.desc, Buffer.concat(descChunks));
  fs.writeFileSync(p.kp, Buffer.concat(kpChunks));
  fs.writeFileSync(p.meta, JSON.stringify({ set, lang, hashed: true, cards: rows }));
  return { paths: p, rows };
}

// Read back what the GLOBAL index says card `row` looks like.
function readGlobal(out, row) {
  const [, , , offset, count] = row;
  const desc = Buffer.alloc(count * DESC_BYTES);
  const kp = Buffer.alloc(count * KP_BYTES);
  const dFd = fs.openSync(out.desc, 'r'), kFd = fs.openSync(out.kp, 'r');
  fs.readSync(dFd, desc, 0, desc.length, offset * DESC_BYTES);
  fs.readSync(kFd, kp, 0, kp.length, offset * KP_BYTES);
  fs.closeSync(dFd); fs.closeSync(kFd);
  return { desc, kp };
}

async function main() {
  // Two sets. `alpha` has a double-faced card (two rows, same set|number, which
  // scanMatch collapses to its best face) and varying descriptor counts so any
  // fixed-stride assumption in the rebasing would show up.
  const alpha = writeSetIndex('mtg-alpha', 'alpha', 'en', [
    { name: 'Sol Ring', number: '1', seed: 11, count: 3 },
    { name: 'Brutal Cathar', number: '7', seed: 12, count: 5 },   // face A
    { name: 'Moonrage Brute', number: '7', seed: 13, count: 2 },   // face B, same number
    { name: 'Opt', number: '58', seed: 14, count: 500 },           // at the cap
  ]);
  const beta = writeSetIndex('mtg-beta', 'beta', 'en', [
    { name: 'Llanowar Elves', number: '3', seed: 21, count: 1 },   // minimum useful
    { name: 'Shock', number: '9', seed: 22, count: 47 },
  ]);

  const out = {
    desc: path.join(tmp, 'global-desc.bin'),
    kp: path.join(tmp, 'global-kp.bin'),
    meta: path.join(tmp, 'global-meta.json'),
  };
  const resolveSet = (s) => (s === 'alpha' ? alpha.paths : s === 'beta' ? beta.paths : setPaths(`mtg-${s}`));

  const seen = [];
  let stats = await orbUnion.unionSets({
    sets: ['alpha', 'beta'], resolveSet, outPaths: out,
    cap: 500, refWidth: 500, lang: 'en',
    onSet: (i, total, set, info) => seen.push(`${i}/${total} ${set} rows=${info.rows}`),
  });

  // 1. Every row from both sets survives, and the descriptor total is the sum.
  assert.strictEqual(stats.cards, 6, 'all six rows carried over');
  assert.strictEqual(stats.descriptors, 3 + 5 + 2 + 500 + 1 + 47);
  assert.strictEqual(stats.missing, 0);
  assert.strictEqual(stats.skipped, 0);
  assert.deepStrictEqual(seen, ['1/2 alpha rows=4', '2/2 beta rows=2'], 'progress reported per set');

  const globalMeta = JSON.parse(fs.readFileSync(out.meta));
  assert.strictEqual(globalMeta.cards.length, 6);
  assert.strictEqual(globalMeta.cap, 500);
  assert.strictEqual(globalMeta.lang, 'en');

  // 2. THE load-bearing assertion: the bytes the global index serves for each
  //    card are byte-identical to the bytes its per-set index served.
  const sources = [...alpha.rows, ...beta.rows];
  assert.strictEqual(globalMeta.cards.length, sources.length);
  for (let i = 0; i < sources.length; i++) {
    const srcRow = sources[i];
    const gRow = globalMeta.cards[i];
    const [name, set, number, , count] = srcRow;

    assert.strictEqual(gRow[0], name, `row ${i} name`);
    assert.strictEqual(gRow[1], set, `row ${i} set`);
    assert.strictEqual(gRow[2], number, `row ${i} number`);
    assert.strictEqual(gRow[4], count, `row ${i} descriptor count`);

    const expected = fakeCard(
      // recover the seed from the source fixture rather than trusting order
      i < alpha.rows.length ? [11, 12, 13, 14][i] : [21, 22][i - alpha.rows.length],
      count,
    );
    const actual = readGlobal(out, gRow);
    assert.ok(actual.desc.equals(expected.desc), `row ${i} (${name}) descriptors are byte-identical`);
    assert.ok(actual.kp.equals(expected.kp), `row ${i} (${name}) keypoints are byte-identical`);
  }

  // 3. The dHash columns are dropped — the global reader recalls with CLIP.
  for (const row of globalMeta.cards) {
    assert.strictEqual(row.length, 5, `global rows are 5 columns, got ${row.length}`);
  }

  // 4. Offsets are contiguous, ascending, and non-overlapping.
  let expect = 0;
  for (const [, , , offset, count] of globalMeta.cards) {
    assert.strictEqual(offset, expect, 'each row starts where the previous ended');
    expect += count;
  }
  assert.strictEqual(fs.statSync(out.desc).size, expect * DESC_BYTES, 'desc.bin has no slack');
  assert.strictEqual(fs.statSync(out.kp).size, expect * KP_BYTES, 'kp.bin has no slack');

  // 5. verifyUnion accepts a well-formed index and reports the same totals.
  const v = orbUnion.verifyUnion(out);
  assert.strictEqual(v.cards, 6);
  assert.strictEqual(v.descriptors, stats.descriptors);

  // 6. A set that was never built is counted as missing, not fatal — a global
  //    build should report the gap and carry on rather than abort at set 900.
  const out2 = { desc: path.join(tmp, 'g2-desc.bin'), kp: path.join(tmp, 'g2-kp.bin'), meta: path.join(tmp, 'g2-meta.json') };
  stats = await orbUnion.unionSets({
    sets: ['alpha', 'nope', 'beta'], resolveSet, outPaths: out2, cap: 500, refWidth: 500, lang: 'en',
  });
  assert.strictEqual(stats.missing, 1);
  assert.strictEqual(stats.cards, 6, 'the two real sets still contributed everything');
  orbUnion.verifyUnion(out2);

  // 7. A source row pointing past the end of its own bin is skipped, not copied
  //    as truncated garbage. This is the corruption case worth being strict about.
  const bad = writeSetIndex('mtg-bad', 'bad', 'en', [{ name: 'Good', number: '1', seed: 31, count: 2 }]);
  const badMeta = JSON.parse(fs.readFileSync(bad.paths.meta));
  badMeta.cards.push(['Truncated', 'bad', '2', 900, 10]);  // offset past EOF
  badMeta.cards.push(['NegOffset', 'bad', '3', -1, 4]);    // negative offset
  badMeta.cards.push(['ZeroCount', 'bad', '4', 0, 0]);     // nothing to verify against
  fs.writeFileSync(bad.paths.meta, JSON.stringify(badMeta));

  const out3 = { desc: path.join(tmp, 'g3-desc.bin'), kp: path.join(tmp, 'g3-kp.bin'), meta: path.join(tmp, 'g3-meta.json') };
  stats = await orbUnion.unionSets({
    sets: ['bad'], resolveSet: (s) => (s === 'bad' ? bad.paths : setPaths(s)), outPaths: out3,
    cap: 500, refWidth: 500, lang: 'en',
  });
  assert.strictEqual(stats.cards, 1, 'only the valid row survives');
  assert.strictEqual(stats.skipped, 3, 'truncated, negative and empty rows all skipped');
  const g3 = JSON.parse(fs.readFileSync(out3.meta));
  assert.deepStrictEqual(g3.cards.map(r => r[0]), ['Good']);
  assert.ok(readGlobal(out3, g3.cards[0]).desc.equals(fakeCard(31, 2).desc), 'the survivor is still exact');
  orbUnion.verifyUnion(out3);

  // 8. verifyUnion rejects a meta whose offsets do not match its bins — the
  //    check that stops a corrupt staged index from being swapped over a good one.
  const g3bad = JSON.parse(fs.readFileSync(out3.meta));
  g3bad.cards[0][4] = 99; // claim 99 descriptors where 2 were written
  fs.writeFileSync(out3.meta, JSON.stringify(g3bad));
  assert.throws(() => orbUnion.verifyUnion(out3), /desc\.bin is \d+ bytes, meta describes/);

  // 9. And rejects a non-contiguous meta.
  const out4 = { desc: out3.desc, kp: out3.kp, meta: path.join(tmp, 'g4-meta.json') };
  fs.writeFileSync(out4.meta, JSON.stringify({ cards: [['A', 's', '1', 5, 2]] })); // starts at 5, not 0
  assert.throws(() => orbUnion.verifyUnion(out4), /not contiguous/);

  // 10. An empty union is an error, not a silently-swapped empty index.
  fs.writeFileSync(out4.meta, JSON.stringify({ cards: [] }));
  assert.throws(() => orbUnion.verifyUnion(out4), /no cards/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('orbunion.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave it */ }
  console.error(err);
  process.exit(1);
});
