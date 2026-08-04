// Card languages the UI can search, scan and record. Mirrors the backend list in
// backend/src/utils/languages.js — same codes, same display names, and the names
// are what get stored in collection.language. Provider-specific spellings
// (Scryfall's zht, TCGdex's zh-tw) stay on the backend; the UI only ever speaks
// the canonical code.
export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: 'Japanese' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh-tw', name: 'Chinese (Traditional)' },
  { code: 'zh-cn', name: 'Chinese (Simplified)' },
];

export const LANGUAGE_NAMES = LANGUAGES.map(l => l.name);

const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
const byCode = new Map(LANGUAGES.map(l => [l.code, l]));

// Display name -> code ('Japanese' -> 'ja'). The entry forms store names, the
// search/scan APIs want codes, so this is the bridge between them.
export const langCode = (name) => (byName.get(String(name || '').toLowerCase()) || LANGUAGES[0]).code;

// Code -> display name ('ja' -> 'Japanese').
export const langName = (code) => (byCode.get(String(code || '').toLowerCase()) || LANGUAGES[0]).name;

export const isEnglish = (nameOrCode) => {
  const key = String(nameOrCode || '').toLowerCase();
  return !key || key === 'en' || key === 'english';
};

// The card name to show: providers give us the localized name (printed_name) for
// a non-English printing and the English one is still there for searching, so
// prefer whatever the card itself was printed with.
export const displayName = (card) => (card && (card.printed_name || card.name)) || '';

// The English name to show ALONGSIDE the localized one, or null when there isn't a
// distinct one to show.
//
// This is free for Magic: Scryfall gives every printing an English `name` plus the
// localized `printed_name`, so a Japanese card already carries both. It is null for
// non-English Pokémon, where TCGdex has only the localized name — a Japan-only card
// has no English name anywhere, and the dexId that could give a species name is
// blank on exactly the ex/special cards, absent on Trainers and Energy.
export function translatedName(card) {
  if (!card) return null;
  const shown = displayName(card);
  const english = card.name || '';
  return english && english !== shown ? english : null;
}

// The set's code. Unlike its name this reads the same in every language, so it is
// what you can actually search for or quote. MTG set ids are stored prefixed.
//
// Casing is left exactly as the provider gives it: TCGdex codes are mixed-case
// ("SV8a", "sv03") and upper-casing them produces a code that does not resolve.
export function setCode(card) {
  const code = String(card?.set_id || '').replace(/^mtg-/, '');
  return code || null;
}

// Set code plus collector number, for places that don't already show the number.
export function setReference(card) {
  const code = setCode(card);
  if (!code) return null;
  return card.number ? `${code} #${card.number}` : code;
}
