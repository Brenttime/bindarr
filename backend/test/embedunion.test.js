// The CLIP recall table is the concatenation of the per-set embed files
// (src/embedUnion.js), deduped by artwork. Two things have to hold or scanning
// breaks silently:
//
//   1. Row i of the .bin must be card i of the meta. A misalignment loads fine and
//      then matches every query against the wrong card's vector.
//   2. Dedupe must collapse reprints of one illustration but never two DIFFERENT
//      illustrations of the same card — dropping an artwork makes it permanently
//      unscannable, with nothing to indicate why.
//
// No framework — plain node + assert. Run: `node test/embedunion.test.js`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const embedUnion = require('../src/embedUnion');

const DIM = 4;                 // tiny, so vectors are readable in a failure message
const MODEL = 'test/model';
const PRE = 'test-v1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-embedunion-'));
const setPaths = (name) => ({
  embed: path.join(tmp, `${name}-embed.bin`),
  meta: path.join(tmp, `${name}-meta.json`),
});

// Each card's vector is [seed, seed, seed, seed], so which row landed where is
// obvious from the bytes.
function writeSet(name, rows, opts = {}) {
  const p = setPaths(name);
  const buf = Buffer.alloc(rows.length * DIM * 4);
  const f = new Float32Array(buf.buffer, buf.byteOffset, rows.length * DIM);
  rows.forEach((r, i) => { for (let d = 0; d < DIM; d++) f[i * DIM + d] = r.seed; });
  fs.writeFileSync(p.embed, buf);
  fs.writeFileSync(p.meta, JSON.stringify({
    set: name, lang: 'en', hashed: true, cards: [],
    embed: {
      model: opts.model || MODEL,
      dim: opts.dim || DIM,
      preprocess: opts.preprocess || PRE,
      cards: rows.map(r => [r.name, r.set, r.number, r.ill]),
    },
  }));
  return p;
}

function readVec(binPath, index) {
  const buf = Buffer.alloc(DIM * 4);
  const fd = fs.openSync(binPath, 'r');
  fs.readSync(fd, buf, 0, buf.length, index * DIM * 4);
  fs.closeSync(fd);
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, DIM));
}

async function main() {
  // alpha: Bolt has two DIFFERENT illustrations (must both survive) and a third
  // row that reprints the first illustration (must be dropped).
  writeSet('alpha', [
    { name: 'Lightning Bolt', set: 'lea', number: '161', ill: 'ill-A', seed: 11 },
    { name: 'Lightning Bolt', set: 'lea', number: '162', ill: 'ill-B', seed: 12 },
    { name: 'Lightning Bolt', set: 'lea', number: '163', ill: 'ill-A', seed: 99 },  // dup artwork
    { name: 'Opt', set: 'lea', number: '58', ill: 'ill-C', seed: 13 },
  ]);
  // beta: a reprint of ill-A from another set (dropped) plus a new artwork.
  writeSet('beta', [
    { name: 'Lightning Bolt', set: 'm10', number: '146', ill: 'ill-A', seed: 98 },  // dup artwork
    { name: 'Shock', set: 'm10', number: '147', ill: 'ill-D', seed: 14 },
  ]);
  // gamma: no illustration ids at all, as TCGdex/pokemontcg supply. With nothing
  // that means "same artwork", dedupe must not reach ACROSS sets: Pokémon card
  // numbers are per-set, so base1 #58 and base3 #58 are two unrelated
  // illustrations and collapsing them makes one permanently unscannable.
  writeSet('gamma', [
    { name: 'Pikachu', set: 'base1', number: '58', ill: null, seed: 21 },
    { name: 'Pikachu', set: 'base2', number: '60', ill: null, seed: 22 },
    { name: 'Pikachu', set: 'base3', number: '58', ill: null, seed: 23 },  // different set, different art
  ]);
  // delta: a repeated row for ONE printing (the only duplicate an id-less
  // provider can actually prove), which must still collapse.
  writeSet('delta', [
    { name: 'Eevee', set: 'base4', number: '51', ill: null, seed: 24 },
    { name: 'Eevee', set: 'base4', number: '51', ill: null, seed: 96 },  // same printing, repeated
  ]);

  const out = { bin: path.join(tmp, 'g-embed.bin'), meta: path.join(tmp, 'g-embed-meta.json') };
  const resolve = (s) => setPaths(s);

  const seen = [];
  let stats = await embedUnion.unionEmbeddings({
    sets: ['alpha', 'beta', 'gamma', 'delta'], resolveSet: resolve, outPaths: out, lang: 'en',
    onSet: (i, total, set, info) => seen.push(`${set}:${info.rows}`),
  });

  // 1. Reprints of a known artwork are dropped; distinct artworks all survive.
  assert.strictEqual(stats.cards, 8, `expected 8 unique artworks, got ${stats.cards}`);
  assert.strictEqual(stats.duplicates, 3, 'three reprints collapsed');
  assert.strictEqual(stats.missing, 0);
  assert.deepStrictEqual(seen, ['alpha:3', 'beta:1', 'gamma:3', 'delta:1'], 'per-set contribution');

  const meta = JSON.parse(fs.readFileSync(out.meta));
  assert.strictEqual(meta.dim, DIM);
  assert.strictEqual(meta.model, MODEL);
  assert.strictEqual(meta.preprocess, PRE);
  assert.strictEqual(meta.lang, 'en');
  assert.strictEqual(meta.cards.length, 8);

  // 2. Row i of the bin is card i of the meta — checked by the seed baked into
  //    every component of each vector.
  const expected = [
    ['Lightning Bolt', 'lea', '161', 11],
    ['Lightning Bolt', 'lea', '162', 12],
    ['Opt', 'lea', '58', 13],
    ['Shock', 'm10', '147', 14],
    ['Pikachu', 'base1', '58', 21],
    ['Pikachu', 'base2', '60', 22],
    ['Pikachu', 'base3', '58', 23],
    ['Eevee', 'base4', '51', 24],
  ];
  expected.forEach(([name, set, number, seed], i) => {
    assert.deepStrictEqual(meta.cards[i], [name, set, number], `meta row ${i}`);
    assert.deepStrictEqual(readVec(out.bin, i), [seed, seed, seed, seed], `vector for row ${i} (${name})`);
  });

  // 3. Both distinct illustrations of Lightning Bolt are present. Losing one would
  //    make that printing unscannable forever.
  const bolts = meta.cards.filter(c => c[0] === 'Lightning Bolt');
  assert.strictEqual(bolts.length, 2, 'both artworks of the same card survive dedupe');

  // 3b. And both Pikachus numbered 58 — different sets, so nothing proves they
  //     share art, and the one dropped by a cross-set key could never be scanned.
  const p58 = meta.cards.filter(c => c[0] === 'Pikachu' && c[2] === '58');
  assert.strictEqual(p58.length, 2, 'same name+number in two sets stays two artworks');

  // 4. The file has no slack, and verifyUnion agrees with the meta.
  assert.strictEqual(fs.statSync(out.bin).size, 8 * DIM * 4);
  assert.deepStrictEqual(embedUnion.verifyUnion(out), { cards: 8, dim: DIM });

  // 5. A set with no embed pass yet is counted as missing, not fatal — a global
  //    build should report the gap and carry on.
  const out2 = { bin: path.join(tmp, 'g2.bin'), meta: path.join(tmp, 'g2.json') };
  stats = await embedUnion.unionEmbeddings({ sets: ['alpha', 'nope'], resolveSet: resolve, outPaths: out2, lang: 'en' });
  assert.strictEqual(stats.missing, 1);
  assert.strictEqual(stats.cards, 3);
  embedUnion.verifyUnion(out2);

  // 6. Mixing recipes is refused rather than silently producing a table whose
  //    rows are not comparable to each other.
  writeSet('other', [{ name: 'X', set: 'x', number: '1', ill: 'ill-X', seed: 31 }], { preprocess: 'different-v2' });
  const out3 = { bin: path.join(tmp, 'g3.bin'), meta: path.join(tmp, 'g3.json') };
  await assert.rejects(
    () => embedUnion.unionEmbeddings({ sets: ['alpha', 'other'], resolveSet: resolve, outPaths: out3, lang: 'en' }),
    /rebuild the affected sets/,
  );

  // 7. A per-set file whose length disagrees with its row count contributes
  //    nothing (treated as a half-written pass) rather than misaligned vectors.
  const truncated = writeSet('trunc', [
    { name: 'A', set: 't', number: '1', ill: 'ill-T1', seed: 41 },
    { name: 'B', set: 't', number: '2', ill: 'ill-T2', seed: 42 },
  ]);
  fs.writeFileSync(truncated.embed, fs.readFileSync(truncated.embed).subarray(0, DIM * 4));  // drop a row
  assert.strictEqual(embedUnion.readSetEmbeddings(truncated), null, 'length/row mismatch rejected');

  // 8. An entirely empty union is an error, not a silently-swapped empty table.
  const out4 = { bin: path.join(tmp, 'g4.bin'), meta: path.join(tmp, 'g4.json') };
  await assert.rejects(
    () => embedUnion.unionEmbeddings({ sets: ['nope'], resolveSet: resolve, outPaths: out4, lang: 'en' }),
    /no set contributed/,
  );

  // 9. artworkKey: illustration id wins; without one, set+name+number; and a
  //    missing id must not collapse two different cards together.
  assert.strictEqual(embedUnion.artworkKey(['N', 's', '1', 'abc']), 'ill:abc');
  assert.strictEqual(embedUnion.artworkKey(['N', 's', '1', null]), 'nn:s|N|1');
  assert.notStrictEqual(embedUnion.artworkKey(['N', 's', '1', null]), embedUnion.artworkKey(['N', 's', '2', null]));
  // Same artwork id from different sets is one key (that is the point).
  assert.strictEqual(embedUnion.artworkKey(['N', 'a', '1', 'x']), embedUnion.artworkKey(['N', 'b', '9', 'x']));
  // Without an id, a different set is a different key — nothing has established
  // that the two illustrations are the same one.
  assert.notStrictEqual(embedUnion.artworkKey(['N', 'a', '1', null]), embedUnion.artworkKey(['N', 'b', '1', null]));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('embedunion.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave it */ }
  console.error(err);
  process.exit(1);
});
