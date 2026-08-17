// Which Pokémon provider serves a given language. The ONLY place that decides.
//
// This exists because the decision was made inline at five separate call sites and
// four of them got it wrong the same way — by branching on the LANGUAGE:
//
//   if (lang === 'en') pokemontcg.io else TCGdex
//
// That reads as obviously correct, because pokemontcg.io really is English-only.
// The half it misses is that TCGdex serves English too, and when it is the
// selected provider it is the one that built the data. The two number the same
// sets differently — TCGdex sv01 / swsh10.5 / me01 against pokemontcg.io
// sv1 / pgo / me1 — so a language-based branch sends TCGdex set ids to a provider
// that has never heard of them. The failures were quiet and varied:
//
//   · setCatalogue     — 91 of 218 sets showed a bare code, no year, no card count
//   · buildSet caching — 21,828 rows cached with no image_url and no number, so a
//                        scan matched, added the card, and displayed nothing
//   · /api/search      — exact set+number found nothing, the client retried by
//                        name, and returned an unrelated printing of the card
//   · previewSet       — asked pokemontcg.io to count a set it does not have
//
// None of them threw. Each produced plausible-looking output that was wrong in a
// different place, which is why they were found one at a time over hours.
//
// So the rule lives here once. Call sites ask; they do not decide.
const db = require('../db');
const languages = require('./languages');

const TCGDEX = 'tcgdex';
const POKEMONTCG = 'pokemontcg';

// The rule itself, pure and synchronous so it can be tested without a database.
//
// Language is a VETO, not the choice: pokemontcg.io genuinely has no non-English
// cards, so anything but English must use TCGdex whatever the setting says. For
// English, the setting decides — and the setting is what built the indexes, the
// caches and the set lists, so following it is what keeps them consistent.
function decide(setting, lang) {
  if (!languages.isEnglish(lang)) return TCGDEX;
  return setting === TCGDEX ? TCGDEX : POKEMONTCG;
}

// The configured provider for English. Unreadable settings fall back to
// pokemontcg.io, which is the column default and the historical behaviour.
async function configured() {
  try {
    const row = await db.get(`SELECT pokemon_provider FROM app_settings WHERE id = 1`);
    return (row && row.pokemon_provider) === TCGDEX ? TCGDEX : POKEMONTCG;
  } catch {
    return POKEMONTCG;
  }
}

async function providerFor(lang) {
  return decide(await configured(), lang);
}

// The form nearly every call site wants: "am I talking to TCGdex?"
async function usesTcgdex(lang) {
  return (await providerFor(lang)) === TCGDEX;
}

module.exports = { decide, configured, providerFor, usesTcgdex, TCGDEX, POKEMONTCG };
