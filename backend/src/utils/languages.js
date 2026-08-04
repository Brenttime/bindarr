// The card languages Bindarr can search, scan and store — one table, because
// three different providers each spell them their own way.
//
// `name` is the display name, and it is deliberately the same string
// collection.language has held since v1.0 ('English', 'Japanese', ...) so
// existing rows keep meaning what they always meant.
//
// Provider coverage:
//   scryfall - every language below (Magic is printed in all of them).
//   tcgdex   - every language below (Pokémon; row counts vary wildly, ru has 9
//              sets to en's 218 — an empty result is normal, not a bug).
//   pokemontcg.io is ENGLISH ONLY. Its 174 sets are the Western releases; JP
//   exclusives like sv2a (ポケモンカード151) are simply absent. That is why a
//   non-English Pokémon lookup routes to TCGdex instead (see tcgdexApi.js).
const LANGUAGES = [
  { code: 'en', name: 'English', scryfall: 'en', tcgdex: 'en' },
  { code: 'ja', name: 'Japanese', scryfall: 'ja', tcgdex: 'ja' },
  { code: 'de', name: 'German', scryfall: 'de', tcgdex: 'de' },
  { code: 'fr', name: 'French', scryfall: 'fr', tcgdex: 'fr' },
  { code: 'es', name: 'Spanish', scryfall: 'es', tcgdex: 'es' },
  { code: 'it', name: 'Italian', scryfall: 'it', tcgdex: 'it' },
  { code: 'pt', name: 'Portuguese', scryfall: 'pt', tcgdex: 'pt' },
  { code: 'ko', name: 'Korean', scryfall: 'ko', tcgdex: 'ko' },
  { code: 'ru', name: 'Russian', scryfall: 'ru', tcgdex: 'ru' },
  // Scryfall spells the Chinese variants zht/zhs; TCGdex uses zh-tw/zh-cn.
  { code: 'zh-tw', name: 'Chinese (Traditional)', scryfall: 'zht', tcgdex: 'zh-tw' },
  { code: 'zh-cn', name: 'Chinese (Simplified)', scryfall: 'zhs', tcgdex: 'zh-cn' },
];

const DEFAULT = LANGUAGES[0];

const byCode = new Map(LANGUAGES.map(l => [l.code, l]));
const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
// Provider codes resolve back too, so a stored 'zht' or a legacy caller passing
// Scryfall's own spelling still lands on the right language.
const byProvider = new Map(LANGUAGES.flatMap(l => [[l.scryfall, l], [l.tcgdex, l]]));

// Resolve anything that might name a language — canonical code, display name, or
// a provider's own code — to one entry. Unknown input falls back to English
// rather than throwing: a bad `lang` query param should degrade, not 500.
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

// True for anything that means English (including empty/unknown input). The
// English paths are the existing pokemontcg.io/cached ones, so this is the test
// for "can we use what we already had".
const isEnglish = (input) => resolve(input).code === 'en';

module.exports = { LANGUAGES, DEFAULT, resolve, toCode, toName, isEnglish };
