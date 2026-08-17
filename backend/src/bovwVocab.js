// Visual Vocabulary Tree for binary ORB descriptors.
//
// Quantizes 32-byte (256-bit) ORB descriptors into discrete visual word IDs.
// Uses a hierarchical tree with branching factor K and depth L (e.g. K=8, L=4 -> 4096 visual words).
// Fast Hamming distance with precomputed popcount lookup table.

const fs = require('fs');
const path = require('path');

const DESC_BYTES = 32;

// 256-entry lookup table for fast 8-bit popcount
const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = 0, n = i;
  while (n) { c += n & 1; n >>>= 1; }
  POPCOUNT_TABLE[i] = c;
}

// Hamming distance between two 32-byte descriptor slices
function hamming32(a, aOff, b, bOff) {
  let d = 0;
  for (let i = 0; i < DESC_BYTES; i++) {
    d += POPCOUNT_TABLE[a[aOff + i] ^ b[bOff + i]];
  }
  return d;
}

// Compute binary centroid by bitwise majority vote across assigned descriptors
function computeBinaryCentroid(descriptors, indices, outBuf, outOff) {
  const n = indices.length;
  if (n === 0) {
    outBuf.fill(0, outOff, outOff + DESC_BYTES);
    return;
  }
  const bitCounts = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const dOff = indices[i] * DESC_BYTES;
    for (let byte = 0; byte < 32; byte++) {
      const val = descriptors[dOff + byte];
      if (!val) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((val >>> bit) & 1) {
          bitCounts[byte * 8 + bit]++;
        }
      }
    }
  }
  const threshold = n / 2;
  for (let byte = 0; byte < 32; byte++) {
    let byteVal = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (bitCounts[byte * 8 + bit] > threshold) {
        byteVal |= (1 << bit);
      }
    }
    outBuf[outOff + byte] = byteVal;
  }
}

class VocabTree {
  constructor(k = 8, depth = 4) {
    this.k = k;
    this.depth = depth;
    this.numLeaves = Math.pow(k, depth);
    // Tree node centers stored in a flat Uint8Array
    // Total internal + leaf nodes = (k^(depth+1) - 1) / (k - 1)
    let totalNodes = 0;
    for (let l = 0; l <= depth; l++) totalNodes += Math.pow(k, l);
    this.totalNodes = totalNodes;
    this.nodes = new Uint8Array(totalNodes * DESC_BYTES);
  }

  // Get offset in bytes for node index
  nodeOffset(nodeIdx) {
    return nodeIdx * DESC_BYTES;
  }

  // Quantize a single 32-byte descriptor (given Uint8Array and byte offset) to a leaf word ID [0, numLeaves - 1]
  quantizeOne(descBuf, descOff = 0) {
    let currNode = 0; // root node at index 0
    let leafWordId = 0;

    for (let level = 1; level <= this.depth; level++) {
      const firstChild = currNode * this.k + 1;
      let bestChild = 0;
      let minD = Infinity;

      for (let c = 0; c < this.k; c++) {
        const childIdx = firstChild + c;
        const d = hamming32(descBuf, descOff, this.nodes, childIdx * DESC_BYTES);
        if (d < minD) {
          minD = d;
          bestChild = c;
        }
      }

      currNode = firstChild + bestChild;
      leafWordId = leafWordId * this.k + bestChild;
    }

    return leafWordId;
  }

  // Quantize an array of descriptors: descBuf of length N * 32. Returns Uint32Array of length N.
  quantizeAll(descBuf, count = descBuf.length / DESC_BYTES) {
    const wordIds = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      wordIds[i] = this.quantizeOne(descBuf, i * DESC_BYTES);
    }
    return wordIds;
  }

  // Train the vocabulary tree recursively from a training set of descriptors
  train(descBuf, maxIters = 8) {
    const numDescs = Math.floor(descBuf.length / DESC_BYTES);
    if (numDescs === 0) return;

    const allIndices = Array.from({ length: numDescs }, (_, i) => i);
    // Root centroid (node 0)
    computeBinaryCentroid(descBuf, allIndices, this.nodes, 0);

    const clusterRecursive = (nodeIdx, level, indices) => {
      if (level >= this.depth || indices.length === 0) return;

      const firstChild = nodeIdx * this.k + 1;
      // Initialize k cluster centers by evenly picking from indices
      const assignments = Array.from({ length: this.k }, () => []);
      for (let c = 0; c < this.k; c++) {
        const seedIdx = indices[(c * Math.floor(indices.length / this.k)) % indices.length];
        const srcOff = seedIdx * DESC_BYTES;
        const dstOff = (firstChild + c) * DESC_BYTES;
        this.nodes.set(descBuf.subarray(srcOff, srcOff + DESC_BYTES), dstOff);
      }

      // K-means iterations
      for (let iter = 0; iter < maxIters; iter++) {
        for (let c = 0; c < this.k; c++) assignments[c].length = 0;

        // Assign
        for (let i = 0; i < indices.length; i++) {
          const descIdx = indices[i];
          const descOff = descIdx * DESC_BYTES;
          let bestC = 0, minD = Infinity;
          for (let c = 0; c < this.k; c++) {
            const d = hamming32(descBuf, descOff, this.nodes, (firstChild + c) * DESC_BYTES);
            if (d < minD) { minD = d; bestC = c; }
          }
          assignments[bestC].push(descIdx);
        }

        // Update centers
        for (let c = 0; c < this.k; c++) {
          const dstOff = (firstChild + c) * DESC_BYTES;
          if (assignments[c].length > 0) {
            computeBinaryCentroid(descBuf, assignments[c], this.nodes, dstOff);
          } else {
            // Empty cluster: inherit parent centroid with perturbed byte
            const parentOff = nodeIdx * DESC_BYTES;
            this.nodes.set(this.nodes.subarray(parentOff, parentOff + DESC_BYTES), dstOff);
            this.nodes[dstOff + (c % DESC_BYTES)] ^= (1 << (c % 8));
          }
        }
      }

      // Recurse for each child
      for (let c = 0; c < this.k; c++) {
        clusterRecursive(firstChild + c, level + 1, assignments[c]);
      }
    };

    clusterRecursive(0, 0, allIndices);
  }

  // Serialize to Buffer
  serialize() {
    const meta = JSON.stringify({ k: this.k, depth: this.depth, numLeaves: this.numLeaves, totalNodes: this.totalNodes });
    const metaBuf = Buffer.from(meta, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0x424F5657, 0); // "BOVW" magic
    header.writeUInt32LE(metaBuf.length, 4);
    return Buffer.concat([header, metaBuf, Buffer.from(this.nodes.buffer, this.nodes.byteOffset, this.nodes.byteLength)]);
  }

  // Deserialize from Buffer
  static deserialize(buf) {
    const magic = buf.readUInt32LE(0);
    if (magic !== 0x424F5657) throw new Error('Invalid VocabTree binary buffer');
    const metaLen = buf.readUInt32LE(4);
    const meta = JSON.parse(buf.subarray(8, 8 + metaLen).toString('utf8'));
    const tree = new VocabTree(meta.k, meta.depth);
    const nodesOffset = 8 + metaLen;
    tree.nodes.set(buf.subarray(nodesOffset, nodesOffset + tree.nodes.byteLength));
    return tree;
  }

  save(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.serialize());
  }

  static load(filePath) {
    const buf = fs.readFileSync(filePath);
    return VocabTree.deserialize(buf);
  }
}

module.exports = {
  VocabTree,
  hamming32,
  computeBinaryCentroid,
  DESC_BYTES,
};
