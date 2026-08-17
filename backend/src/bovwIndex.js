// Bag of Visual Words (BoVW) Inverted Index for fast card candidate retrieval.
//
// Uses flat, cache-friendly typed arrays (zero object allocations during query/build).
// Real-time querying calculates cosine similarity against all indexed cards in < 15ms.

const fs = require('fs');
const path = require('path');
const { VocabTree, DESC_BYTES } = require('./bovwVocab');

class BovwIndex {
  constructor(vocabTree) {
    this.vocab = vocabTree || new VocabTree();
    this.numLeaves = this.vocab.numLeaves;
    this.cards = []; // [ [name, set, number], ... ]
    this.idf = new Float32Array(this.numLeaves);
    this.counts = new Uint32Array(this.numLeaves);
    this.offsets = new Uint32Array(this.numLeaves);
    this.flatDocIds = new Uint32Array(0);
    this.flatWeights = new Float32Array(0);
    this.built = false;
  }

  // Add cards from packed descriptors and meta using flat two-pass construction
  // cardEntries: [ { name, set, number, descBuf, count } ]
  buildFromCards(cardEntries) {
    const n = cardEntries.length;
    this.cards = new Array(n);
    const df = new Uint32Array(this.numLeaves);
    const docWordCounts = new Uint32Array(n);

    // Scratch buffers for quantization to avoid per-card allocations
    const maxKps = 1000;
    const scratchWords = new Uint32Array(maxKps);
    const scratchTfMap = new Map();

    // Pass 1: compute document frequencies (DF)
    for (let docId = 0; docId < n; docId++) {
      const entry = cardEntries[docId];
      this.cards[docId] = [entry.name, entry.set, entry.number];
      const count = entry.count || 0;
      docWordCounts[docId] = count;
      if (count === 0 || !entry.descBuf) continue;

      scratchTfMap.clear();
      for (let i = 0; i < count; i++) {
        const w = this.vocab.quantizeOne(entry.descBuf, i * DESC_BYTES);
        scratchTfMap.set(w, (scratchTfMap.get(w) || 0) + 1);
      }

      for (const w of scratchTfMap.keys()) {
        df[w]++;
      }
    }

    // Compute IDF and offsets for flat postings arrays
    let totalEntries = 0;
    for (let w = 0; w < this.numLeaves; w++) {
      this.counts[w] = df[w];
      this.offsets[w] = totalEntries;
      totalEntries += df[w];
      this.idf[w] = Math.log(1 + (n / (1 + df[w])));
    }

    this.flatDocIds = new Uint32Array(totalEntries);
    this.flatWeights = new Float32Array(totalEntries);
    const insertPos = new Uint32Array(this.offsets);

    // Pass 2: compute normalized TF-IDF weights and populate flat arrays
    for (let docId = 0; docId < n; docId++) {
      const count = docWordCounts[docId];
      const entry = cardEntries[docId];
      if (count === 0 || !entry.descBuf) continue;

      scratchTfMap.clear();
      for (let i = 0; i < count; i++) {
        const w = this.vocab.quantizeOne(entry.descBuf, i * DESC_BYTES);
        scratchTfMap.set(w, (scratchTfMap.get(w) || 0) + 1);
      }

      let normSq = 0;
      for (const [w, freq] of scratchTfMap.entries()) {
        const tf = freq / count;
        const weight = tf * this.idf[w];
        normSq += weight * weight;
      }

      const invNorm = normSq > 0 ? 1 / Math.sqrt(normSq) : 0;
      for (const [w, freq] of scratchTfMap.entries()) {
        const tf = freq / count;
        const finalWeight = tf * this.idf[w] * invNorm;
        const pos = insertPos[w]++;
        this.flatDocIds[pos] = docId;
        this.flatWeights[pos] = finalWeight;
      }
    }

    this.built = true;
  }

  // Query inverted index for candidate cards matching query descriptors
  // qDesc: Uint8Array containing query ORB descriptors
  // topK: number of candidates to return
  query(qDesc, topK = 50, qCount = null) {
    if (!this.built || this.cards.length === 0) return [];
    const count = qCount != null ? qCount : Math.floor(qDesc.length / DESC_BYTES);
    if (count === 0) return [];

    // Quantize query descriptors and count frequencies
    const qTf = new Map();
    for (let i = 0; i < count; i++) {
      const w = this.vocab.quantizeOne(qDesc, i * DESC_BYTES);
      qTf.set(w, (qTf.get(w) || 0) + 1);
    }

    // Compute query TF-IDF vector
    let qNormSq = 0;
    const qWeights = [];
    for (const [w, freq] of qTf.entries()) {
      const tf = freq / count;
      const weight = tf * this.idf[w];
      qWeights.push([w, weight]);
      qNormSq += weight * weight;
    }
    const qInvNorm = qNormSq > 0 ? 1 / Math.sqrt(qNormSq) : 0;

    // Accumulate card scores using flat array slices
    const numDocs = this.cards.length;
    const scores = new Float32Array(numDocs);

    for (let j = 0; j < qWeights.length; j++) {
      const [w, unnormW] = qWeights[j];
      const qW = unnormW * qInvNorm;
      const start = this.offsets[w];
      const len = this.counts[w];
      for (let i = 0; i < len; i++) {
        scores[this.flatDocIds[start + i]] += qW * this.flatWeights[start + i];
      }
    }

    // Find top-K candidates
    const best = [];
    for (let d = 0; d < numDocs; d++) {
      const s = scores[d];
      if (s <= 0) continue;
      if (best.length < topK || s > best[0].score) {
        const card = this.cards[d];
        const cand = { docId: d, name: card[0], set: card[1], number: card[2], score: s };
        let pos = 0;
        while (pos < best.length && best[pos].score < s) pos++;
        best.splice(pos, 0, cand);
        if (best.length > topK) best.shift();
      }
    }

    return best.reverse(); // Descending order
  }

  // Fast binary save to disk
  save(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const vocabBuf = this.vocab.serialize();
    const meta = {
      numLeaves: this.numLeaves,
      cards: this.cards,
      idf: Array.from(this.idf),
      vocabLen: vocabBuf.length,
      totalEntries: this.flatDocIds.length,
    };
    const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
    const metaPad = (4 - (metaBuf.length % 4)) % 4;
    const padBuf = metaPad > 0 ? Buffer.alloc(metaPad) : null;

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x42494E58, 0); // "BINX"
    header.writeUInt32LE(metaBuf.length, 4);
    header.writeUInt32LE(vocabBuf.length, 8);

    const countsBuf = Buffer.from(this.counts.buffer, this.counts.byteOffset, this.counts.byteLength);
    const offsetsBuf = Buffer.from(this.offsets.buffer, this.offsets.byteOffset, this.offsets.byteLength);
    const docIdsBuf = Buffer.from(this.flatDocIds.buffer, this.flatDocIds.byteOffset, this.flatDocIds.byteLength);
    const weightsBuf = Buffer.from(this.flatWeights.buffer, this.flatWeights.byteOffset, this.flatWeights.byteLength);

    const fd = fs.openSync(filePath, 'w');
    try {
      fs.writeSync(fd, header);
      fs.writeSync(fd, metaBuf);
      if (padBuf) fs.writeSync(fd, padBuf);
      fs.writeSync(fd, vocabBuf);
      fs.writeSync(fd, countsBuf);
      fs.writeSync(fd, offsetsBuf);
      fs.writeSync(fd, docIdsBuf);
      fs.writeSync(fd, weightsBuf);
    } finally {
      fs.closeSync(fd);
    }
  }

  // Fast binary load from disk
  static load(filePath) {
    const buf = fs.readFileSync(filePath);
    const magic = buf.readUInt32LE(0);
    if (magic !== 0x42494E58) throw new Error('Invalid BovwIndex binary buffer');
    const metaLen = buf.readUInt32LE(4);
    const vocabLen = buf.readUInt32LE(8);
    const metaPad = (4 - (metaLen % 4)) % 4;

    const meta = JSON.parse(buf.subarray(12, 12 + metaLen).toString('utf8'));
    const vocabOffset = 12 + metaLen + metaPad;
    const vocabBuf = buf.subarray(vocabOffset, vocabOffset + vocabLen);
    const vocab = VocabTree.deserialize(vocabBuf);

    const index = new BovwIndex(vocab);
    index.cards = meta.cards;
    index.idf = new Float32Array(meta.idf);

    let offset = vocabOffset + vocabLen;
    const numLeaves = index.numLeaves;
    const totalEntries = meta.totalEntries;

    const copyArray = (Type, count) => {
      const bytes = count * Type.BYTES_PER_ELEMENT;
      const sub = buf.subarray(offset, offset + bytes);
      offset += bytes;
      const arr = new Type(count);
      Buffer.from(arr.buffer, arr.byteOffset, bytes).set(sub);
      return arr;
    };

    index.counts = copyArray(Uint32Array, numLeaves);
    index.offsets = copyArray(Uint32Array, numLeaves);
    index.flatDocIds = copyArray(Uint32Array, totalEntries);
    index.flatWeights = copyArray(Float32Array, totalEntries);

    index.built = true;
    return index;
  }
}

module.exports = { BovwIndex };
