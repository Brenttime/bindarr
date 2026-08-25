// The card languages Bindarr can search, scan and store — one table, because
// three different providers each spell them their own way.
//
// `name` is the display name, and it is deliberately the same string
// collection.language has held since v1.0 ('English', 'Japanese', ...) so
// existing rows keep meaning what they always meant.
//
// Scryfall serves every language below (Magic is printed in all of them), so
// there is one code per language. The table lives in shared/languages.json,
// alongside shared/cardOrder.json, because the frontend needs the same
// code->name pairs and used to keep its own copy of them: two lists meaning the
// same thing is one list that will disagree.
const LANGUAGES = require('../../../shared/languages.json');

const DEFAULT = LANGUAGES[0];

const byCode = new Map(LANGUAGES.map(l => [l.code, l]));
const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
// Scryfall spells the Chinese variants zht/zhs where the canonical codes are
// zh-tw/zh-cn, so its own spelling resolves back too — a stored 'zht' or a caller
// passing Scryfall's code still lands on the right language.
const byProvider = new Map(LANGUAGES.flatMap(l => (l.scryfall ? [[l.scryfall, l]] : [])));
// Resolve anything that might name a language — canonical code, display name, or
// Scryfall's own code — to one entry. Unknown input falls back to English rather
// than throwing: a bad `lang` query param should degrade, not 500.
function resolve(input) {
  if (!input) return DEFAULT;
  const raw = String(input).trim();
  const lower = raw.toLowerCase();
  return byCode.get(lower) || byName.get(lower) || byProvider.get(lower) || DEFAULT;
}

// Canonical code ('ja'). Used for cache ids, index filenames and API params.
const toCode = (input) => resolve(input).code;

// Display name ('Japanese'). This is what goes in collection.language.
const toName = (input) => resolve(input).name;

// True for anything that means English (including empty/unknown input).
const isEnglish = (input) => resolve(input).code === 'en';

module.exports = { LANGUAGES, DEFAULT, resolve, toCode, toName, isEnglish };
