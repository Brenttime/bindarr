// Assemble the whole-game CLIP recall table by concatenating the per-set embed
// files that setIndex writes (buildSet's `embed` option).
//
// This is the CLIP counterpart to src/orbUnion.js, and it exists for the same
// reason: the per-set walk has to download every card image anyway to build ORB
// features, so computing the CLIP vector from that same buffer costs one extra
// encode instead of an entire second pass over the corpus. It also makes the
// language dimension correct by construction — the per-set fetch already asks the
// right provider for the right language (Scryfall with a lang: term, TCGdex for
// non-English Pokémon), whereas the old bulk sources had no language dimension at
// all and silently produced an English table whatever was asked for.
//
// Dedupe by artwork, not by printing. Recall is a linear scan over every row, so
// twelve reprints of one illustration would cost twelve dot products to answer a
// question one of them already answers. ORB keeps all printings (it is keyed by
// set|number and read per candidate), which is what still lets verification name
// the exact printing.
const fs = require('fs');
const path = require('path');

// Read one per-set embed file plus its row identities. Returns null unless the
// two agree, so a half-written pass contributes nothing rather than garbage.
function readSetEmbeddings(p) {
  try {
    if (!fs.existsSync(p.embed) || !fs.existsSync(p.meta)) return null;
    const parsed = JSON.parse(fs.readFileSync(p.meta));
    const e = parsed.embed;
    if (!e || !Array.isArray(e.cards) || e.cards.length === 0) return null;
    const buf = fs.readFileSync(p.embed);
    if (buf.length !== e.cards.length * e.dim * 4) return null;
    return { rows: e.cards, vectors: buf, dim: e.dim, model: e.model, preprocess: e.preprocess };
  } catch { return null; }
}

// The dedupe key for one row: [name, set, number, illustrationId].
//
// Prefer the provider's illustration id — that is exactly "same artwork" and is
// stable across reprints, so two printings sharing one collapse to a single
// vector no matter which sets they came from. Scryfall supplies it.
//
// TCGdex and pokemontcg.io supply nothing of the kind, and there the key stays
// WITHIN a set. Collision is not hypothetical: card numbers are per-set, so
// "Pikachu #1" exists in a dozen Pokémon sets with a dozen unrelated
// illustrations, and a cross-set name+number key silently keeps whichever one
// the walk happened to reach first. The rest are then absent from recall — not
// ranked low, absent — so scanning them can never match, with nothing anywhere
// to say why. Dropping an artwork is unrecoverable; keeping a genuine duplicate
// costs one dot product per scan, so the doubt resolves toward keeping it.
//
// Within one set the pair is still safe (it collapses repeated rows for one
// printing) and is the only dedupe those providers can support.
function artworkKey(row) {
  const [name, set, number, illustrationId] = row;
  return illustrationId ? `ill:${illustrationId}` : `nn:${set}|${name}|${number}`;
}

// Build the recall table for `sets`, writing { bin, meta } into outPaths.
//
// `resolveSet(set)` returns one per-set index's paths — injected rather than
// imported so this module stays independent of setIndex and directly testable.
async function unionEmbeddings({ sets, resolveSet, outPaths, lang, scope = null, onSet = () => {} }) {
  fs.mkdirSync(path.dirname(outPaths.bin), { recursive: true });
  const fd = fs.openSync(outPaths.bin, 'w');
  const cards = [];
  const seen = new Set();
  let dim = null, model = null, preprocess = null;
  let missing = 0, duplicates = 0;

  try {
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i];
      const src = readSetEmbeddings(resolveSet(set));
      if (!src) {
        missing++;
        onSet(i + 1, sets.length, set, { rows: 0, missing: true });
        continue;
      }
      // Every row in one table must come from the same model and recipe, or the
      // dot products between them are meaningless.
      if (dim === null) { dim = src.dim; model = src.model; preprocess = src.preprocess; }
      else if (src.dim !== dim || src.model !== model || src.preprocess !== preprocess) {
        throw new Error(
          `set ${set} was embedded with ${src.model}/${src.preprocess} (dim ${src.dim}) but the table ` +
          `is ${model}/${preprocess} (dim ${dim}) — rebuild the affected sets`
        );
      }

      let added = 0;
      for (let r = 0; r < src.rows.length; r++) {
        const row = src.rows[r];
        const k = artworkKey(row);
        if (seen.has(k)) { duplicates++; continue; }
        seen.add(k);
        const vec = src.vectors.subarray(r * dim * 4, (r + 1) * dim * 4);
        fs.writeSync(fd, vec, 0, vec.length, cards.length * dim * 4);
        cards.push([row[0], row[1], row[2]]);   // the reader needs only the identity
        added++;
      }
      onSet(i + 1, sets.length, set, { rows: added, missing: false });
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!cards.length) throw new Error('recall table is empty — no set contributed any embeddings');
  // `scope` records which sets this table covers. A partial table that cannot say
  // what it excludes would answer an out-of-scope scan with the nearest artwork it
  // happens to hold, presented with full confidence — worse than no answer.
  fs.writeFileSync(outPaths.meta, JSON.stringify({ model, dim, preprocess, lang, scope, cards }));
  return { cards: cards.length, sets: sets.length, missing, duplicates, dim, model, preprocess };
}

// Cross-check a finished table before it replaces a live one. The failure this
// catches — a .bin whose length disagrees with its meta — loads without error and
// then matches every query against misaligned vectors.
function verifyUnion(outPaths) {
  const meta = JSON.parse(fs.readFileSync(outPaths.meta));
  if (!meta.cards.length) throw new Error('recall table has no cards');
  if (!meta.dim) throw new Error('recall table meta has no dim');
  const expected = meta.cards.length * meta.dim * 4;
  const actual = fs.statSync(outPaths.bin).size;
  if (actual !== expected) {
    throw new Error(`recall table bin is ${actual} bytes, meta describes ${expected}`);
  }
  return { cards: meta.cards.length, dim: meta.dim };
}

module.exports = { readSetEmbeddings, artworkKey, unionEmbeddings, verifyUnion };
