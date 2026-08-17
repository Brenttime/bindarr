// In-memory matcher for Bag of Visual Words (BoVW) candidate recall.
//
// Loads backend/data/{game}-bovw.bin and performs instant visual-word inverted index retrieval.

const fs = require('fs');
const gpaths = require('./utils/globalIndexPaths');
const { BovwIndex } = require('./bovwIndex');

const dbs = {}; // "game|lang" -> BovwIndex | null

function loadDb(game, lang = 'en') {
  const k = gpaths.key(game, lang);
  if (k in dbs) return dbs[k];
  const filePath = gpaths.bovw(game, lang);
  if (!fs.existsSync(filePath)) {
    dbs[k] = null;
    return null;
  }
  try {
    dbs[k] = BovwIndex.load(filePath);
    console.log(`bovwMatch: loaded ${gpaths.tag(game, lang)} BoVW index (${dbs[k].cards.length} cards, ${dbs[k].numLeaves} visual words)`);
  } catch (e) {
    console.warn(`bovwMatch: failed to load ${filePath}: ${e.message}`);
    dbs[k] = null;
  }
  return dbs[k];
}

// Match query descriptors against BoVW index
// descBuf: Uint8Array containing 32-byte ORB descriptors
// count: number of descriptors in descBuf
function match(descBuf, game, topK = 50, lang = 'en', count = null) {
  const db = loadDb(game, lang);
  if (!db) return [];
  return db.query(descBuf, topK, count);
}

function isBuilt(game, lang = 'en') {
  return fs.existsSync(gpaths.bovw(game, lang));
}

function reload(game, lang) {
  if (lang === undefined) {
    for (const k of Object.keys(dbs)) if (k.startsWith(`${game}|`)) delete dbs[k];
    return;
  }
  delete dbs[gpaths.key(game, lang)];
}

module.exports = {
  loadDb,
  match,
  isBuilt,
  reload,
};
