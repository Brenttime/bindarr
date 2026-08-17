// Build a Bag of Visual Words (BoVW) index from an existing ORB index.
//
// 1. Samples a subset of descriptors to train the VocabTree.
// 2. Quantizes every card's descriptors into the trained vocabulary.
// 3. Serializes to data/{game}-bovw.bin.
//
// NOTE: this file was reconstructed after being deleted, from its call sites in
// globalIndex.js and scripts/build-bovw-index.mjs plus the on-disk format that
// bovwIndex.js reads. The index it produces is verified by loading it back and
// checking the card count; if you have the original in a backup, prefer that.
const fs = require('fs');
const path = require('path');
const { VocabTree, DESC_BYTES } = require('./bovwVocab');
const { BovwIndex } = require('./bovwIndex');
const gpaths = require('./utils/globalIndexPaths');

// Descriptors are read straight out of the ORB rollup's desc file by byte range,
// exactly as scanMatch.readOrb does — the rollup meta's [name, set, number,
// offset, count] rows are the index into it.
async function buildBovw({
  game = 'mtg', lang = 'en', k = 16, depth = 4, sampleCount = 60000,
  orbPaths = null, outPath = null, onProgress = null,
} = {}) {
  const paths = orbPaths || gpaths.orb(game, lang);
  const meta = JSON.parse(fs.readFileSync(paths.meta));
  const rows = meta.cards || [];
  const totalCards = rows.length;
  if (!totalCards) throw new Error(`buildBovw: ${paths.meta} holds no cards`);

  const descFd = fs.openSync(paths.desc, 'r');
  try {
    const readDesc = (offset, count) => {
      const buf = Buffer.alloc(count * DESC_BYTES);
      fs.readSync(descFd, buf, 0, buf.length, offset * DESC_BYTES);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    };

    // 1. Collect sample descriptors for training VocabTree. Strided across the
    // whole catalogue rather than taken from the first N cards, so the
    // vocabulary is not trained on one alphabetical corner of one set.
    console.log(`buildBovw: sampling descriptors from ${totalCards} cards...`);
    const perCard = Math.max(1, Math.ceil(sampleCount / totalCards));
    const sample = [];
    let sampled = 0;
    for (let i = 0; i < totalCards && sampled < sampleCount; i++) {
      const count = rows[i][4];
      if (!count) continue;
      const take = Math.min(perCard, count, sampleCount - sampled);
      const d = readDesc(rows[i][3], count);
      sample.push(d.subarray(0, take * DESC_BYTES));
      sampled += take;
    }
    const trainingData = new Uint8Array(sampled * DESC_BYTES);
    let at = 0;
    for (const s of sample) { trainingData.set(s, at); at += s.length; }

    console.log(`buildBovw: training VocabTree (K=${k}, depth=${depth}, leaves=${Math.pow(k, depth)}) on ${Math.floor(trainingData.length / DESC_BYTES)} descriptors...`);
    const tree = new VocabTree(k, depth);
    tree.train(trainingData);

    // 2. Quantize every card into the trained vocabulary.
    console.log(`buildBovw: indexing ${totalCards} cards into BoVW Inverted Index...`);
    const index = new BovwIndex(tree);
    const entries = new Array(totalCards);
    for (let i = 0; i < totalCards; i++) {
      const [name, set, number, offset, count] = rows[i];
      entries[i] = { name, set, number, count, descBuf: count ? readDesc(offset, count) : null };
      if (onProgress && (i % 500 === 0 || i === totalCards - 1)) onProgress(i + 1, totalCards);
    }
    index.buildFromCards(entries);

    // 3. Serialize.
    const dest = outPath || gpaths.bovw(game, lang);
    console.log(`buildBovw: saving index to ${dest}...`);
    index.save(dest);
    console.log(`buildBovw: done. Indexed ${totalCards} cards.`);
    return { outPath: dest, totalCards, numLeaves: index.numLeaves };
  } finally {
    fs.closeSync(descFd);
  }
}

module.exports = { buildBovw };
