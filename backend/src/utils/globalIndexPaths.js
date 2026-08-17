// Where the global (whole-game) scan indexes live on disk.
//
// One definition, used by the modules that touch these files — globalIndex.js
// (writes them) and scanMatch.js (reads them). A disagreement about a filename
// here means a freshly built index is simply never found, and the scanner falls
// back to "not built yet" with nothing in the logs to explain why.
//
// English deliberately keeps the original un-suffixed names — every index built
// before languages existed must still be found rather than silently rebuilt.
// This is the same back-compat rule setIndex.paths() applies to per-set indexes.
const path = require('path');
const languages = require('./languages');

const DATA_DIR = process.env.INDEX_DATA_DIR || path.join(__dirname, '..', '..', 'data');

const langOf = (lang) => languages.toCode(lang);

// 'mtg' for English, 'mtg-ja' for Japanese.
const tag = (game, lang) => (langOf(lang) === 'en' ? game : `${game}-${langOf(lang)}`);

// Cache/progress key for one (game, language) pair.
const key = (game, lang) => `${game}|${langOf(lang)}`;

const names = {
  orbDesc: (g, l) => `${tag(g, l)}-orb-desc.bin`,
  orbKp: (g, l) => `${tag(g, l)}-orb-kp.bin`,
  orbMeta: (g, l) => `${tag(g, l)}-orb-meta.json`,
  bovw: (g, l) => `${tag(g, l)}-bovw.bin`,
};

// Filenames per kind, in the order they should be checked/swapped.
const filesOf = {
  orb: (g, l) => [names.orbDesc(g, l), names.orbKp(g, l), names.orbMeta(g, l)],
  bovw: (g, l) => [names.bovw(g, l)],
};

// Absolute paths under the live data dir.
const at = (name) => path.join(DATA_DIR, name);
const orb = (g, l) => ({ desc: at(names.orbDesc(g, l)), kp: at(names.orbKp(g, l)), meta: at(names.orbMeta(g, l)) });
const bovw = (g, l) => at(names.bovw(g, l));

module.exports = { DATA_DIR, langOf, tag, key, names, filesOf, at, orb, bovw };
