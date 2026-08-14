// Assemble a whole-game (global) ORB index by concatenating the per-set indexes.
//
// Why this exists instead of a second builder: the per-set index and the global
// index are the SAME format. Same 32-byte descriptors, same [x,y] float pairs,
// same `set|number` key, same REF_WIDTH, same cap. The only differences are that
// per-set meta rows carry two extra dHash columns (which the global reader
// ignores) and that each set's descriptor offsets are relative to its own file.
//
// So a global index is the concatenation of every per-set index with the offsets
// rebased. That replaces scripts/build-card-orb.mjs, which re-downloaded and
// re-extracted every card image the CLIP build had already downloaded, in a
// single un-resumable pass. Building from the per-set indexes instead makes the
// work chunked (interruption costs one set, not hours) and reuses any set the
// user already built for set-scoped scanning.
//
// Row layout (must stay in step with scanMatch.loadOrbDb):
//   per-set: [name, set, number, offset, count, hashHi, hashLo]
//   global:  [name, set, number, offset, count]
const fs = require('fs');
const path = require('path');

const DESC_BYTES = 32;   // one ORB descriptor; matches setIndex + scanMatch
const KP_BYTES = 8;      // one keypoint: two float32s (x, y)

// Bytes each row occupies in the two bins.
const descLen = (count) => count * DESC_BYTES;
const kpLen = (count) => count * KP_BYTES;

// Read one per-set index off disk. Returns null when any part is missing, so a
// half-written set is skipped rather than silently contributing garbage.
function readSetIndex(p) {
  try {
    if (!fs.existsSync(p.meta) || !fs.existsSync(p.desc) || !fs.existsSync(p.kp)) return null;
    const parsed = JSON.parse(fs.readFileSync(p.meta));
    const rows = parsed.cards;
    if (!Array.isArray(rows)) return null;
    return { rows, desc: fs.readFileSync(p.desc), kp: fs.readFileSync(p.kp), set: parsed.set, lang: parsed.lang };
  } catch { return null; }
}

// Append one per-set index's rows to the open global bins.
//
// Copies row by row rather than blitting the whole file and shifting a base
// offset. That costs one extra copy but cannot be wrong: it makes no assumption
// that a set's rows are contiguous, in ascending offset order, or that the file
// contains nothing else. A skipped card in the source leaves a gap, and a gap
// silently shifts every subsequent card's descriptors onto the wrong name — the
// kind of corruption that produces a plausible-looking index that just never
// matches anything.
//
// Returns { rows, nextOffset, skipped } where rows are the rebased global rows.
function appendSetIndex(descFd, kpFd, startOffset, src) {
  const rows = [];
  let offset = startOffset;
  let skipped = 0;

  for (const row of src.rows) {
    const [name, set, number, srcOffset, count] = row;
    // Reject rows whose byte ranges fall outside the files they point into.
    const dEnd = descLen(srcOffset + count);
    const kEnd = kpLen(srcOffset + count);
    if (!Number.isInteger(srcOffset) || !Number.isInteger(count) || count < 0 ||
        srcOffset < 0 || dEnd > src.desc.length || kEnd > src.kp.length) {
      skipped++;
      continue;
    }
    if (count === 0) { skipped++; continue; } // nothing to verify against

    const d = src.desc.subarray(descLen(srcOffset), dEnd);
    const k = src.kp.subarray(kpLen(srcOffset), kEnd);
    fs.writeSync(descFd, d, 0, d.length, descLen(offset));
    fs.writeSync(kpFd, k, 0, k.length, kpLen(offset));
    // Drop the dHash columns: they are a per-set recall pre-filter and the
    // global path recalls with CLIP instead.
    rows.push([name, set, number, offset, count]);
    offset += count;
  }
  return { rows, nextOffset: offset, skipped };
}

// Build the global ORB index for `game`/`lang` from the per-set indexes named by
// `sets`, writing into `outPaths` ({ desc, kp, meta }).
//
// `resolveSet(set)` returns the { desc, kp, meta } paths of one per-set index —
// injected rather than imported so this module stays independent of setIndex
// (and directly testable with fixtures).
//
// `onSet(i, total, set, info)` is called after each set, for progress reporting.
async function unionSets({ sets, resolveSet, outPaths, cap, refWidth, lang, scope = null, onSet = () => {} }) {
  fs.mkdirSync(path.dirname(outPaths.desc), { recursive: true });
  const descFd = fs.openSync(outPaths.desc, 'w');
  const kpFd = fs.openSync(outPaths.kp, 'w');
  const meta = [];
  let offset = 0;
  let missing = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i];
      const src = readSetIndex(resolveSet(set));
      if (!src) {
        missing++;
        onSet(i + 1, sets.length, set, { rows: 0, missing: true });
        continue;
      }
      const r = appendSetIndex(descFd, kpFd, offset, src);
      meta.push(...r.rows);
      offset = r.nextOffset;
      skipped += r.skipped;
      onSet(i + 1, sets.length, set, { rows: r.rows.length, missing: false });
    }
  } finally {
    fs.closeSync(descFd);
    fs.closeSync(kpFd);
  }

  fs.writeFileSync(outPaths.meta, JSON.stringify({ cap, refWidth, lang, scope, cards: meta }));
  return { cards: meta.length, descriptors: offset, sets: sets.length, missing, skipped };
}

// Cross-check a finished global index against the meta that describes it. Called
// before the staged files are swapped over the live ones, because the failure
// this catches — bins that disagree with their meta — produces an index that
// loads fine and matches nothing.
function verifyUnion(outPaths) {
  const meta = JSON.parse(fs.readFileSync(outPaths.meta));
  const rows = meta.cards;
  if (!rows.length) throw new Error('global ORB index has no cards');

  let expected = 0;
  for (const [, , , offset, count] of rows) {
    // Rows are written back to back in emission order, so each row's offset must
    // be exactly the running total. Anything else means a rebasing bug.
    if (offset !== expected) {
      throw new Error(`global ORB meta is not contiguous: row at offset ${offset} expected ${expected}`);
    }
    expected += count;
  }

  const descSize = fs.statSync(outPaths.desc).size;
  const kpSize = fs.statSync(outPaths.kp).size;
  if (descSize !== descLen(expected)) {
    throw new Error(`global ORB desc.bin is ${descSize} bytes, meta describes ${descLen(expected)}`);
  }
  if (kpSize !== kpLen(expected)) {
    throw new Error(`global ORB kp.bin is ${kpSize} bytes, meta describes ${kpLen(expected)}`);
  }
  return { cards: rows.length, descriptors: expected };
}

module.exports = { DESC_BYTES, KP_BYTES, readSetIndex, appendSetIndex, unionSets, verifyUnion };
