// The pokemontcg.io-vs-TCGdex decision, which was made inline at five call sites
// and got made wrong at four of them — always the same way, by branching on the
// language instead of on the configured provider.
//
// That branch looks right: pokemontcg.io really is English-only. What it misses is
// that TCGdex serves English too, and when it does it is the provider that built
// the indexes, the caches and the set lists. The two number the same sets
// differently (sv01/sv1, swsh10.5/pgo, me01/me1), so a language-based branch hands
// TCGdex set ids to a provider that has never heard of them — and nothing throws.
// It just returns the wrong card, or no card, or a card with no picture.
//
// So the rule is pinned here, in both directions.
// No framework — plain node + assert. Run: `node test/pokemonprovider.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-provider-${process.pid}.db`);
const cardSets = require('../src/cardSets');
const { decide, TCGDEX, POKEMONTCG } = require('../src/utils/pokemonProvider');

function testLanguageVeto() {
  // pokemontcg.io has no non-English cards at all, so the SETTING CANNOT WIN here.
  // This is the half the buggy call sites got right.
  // Canonical codes only — these are what the UI sends (frontend/src/utils/
  // languages.js is kept in step with the backend list). Chinese is zh-tw/zh-cn
  // here; zh-Hans/zh-Hant are UI-locale filenames on a different axis entirely.
  for (const lang of ['ja', 'de', 'fr', 'es', 'it', 'pt', 'ko', 'ru', 'zh-tw', 'zh-cn']) {
    assert.strictEqual(decide(POKEMONTCG, lang), TCGDEX, `${lang} must use TCGdex even when pokemontcg.io is configured`);
    assert.strictEqual(decide(TCGDEX, lang), TCGDEX, `${lang} uses TCGdex`);
  }
  // Provider spellings resolve too, so a stored TCGdex/Scryfall code still routes.
  for (const lang of ['Japanese', 'zht', 'zhs']) {
    assert.strictEqual(decide(POKEMONTCG, lang), TCGDEX, `${lang} resolves to a non-English language`);
  }
}

// languages.resolve falls back to English for anything it does not recognise —
// deliberate, so a bad `lang` query param degrades instead of 500ing. That means
// an unknown code lands on the SETTING rather than being forced to TCGdex, which
// is the safe direction: it uses whichever provider actually holds the data.
function testUnknownLanguageDegradesToEnglish() {
  assert.strictEqual(decide(TCGDEX, 'kl'), TCGDEX, 'unknown code + TCGdex configured uses TCGdex');
  assert.strictEqual(decide(POKEMONTCG, 'kl'), POKEMONTCG, 'unknown code + pokemontcg.io configured uses pokemontcg.io');
}

function testEnglishFollowsTheSetting() {
  // And this is the half they got wrong: English is NOT automatically
  // pokemontcg.io. Every one of the four bugs was this assertion being false.
  assert.strictEqual(decide(TCGDEX, 'en'), TCGDEX, 'English + TCGdex configured must use TCGdex');
  assert.strictEqual(decide(POKEMONTCG, 'en'), POKEMONTCG, 'English + pokemontcg.io configured uses pokemontcg.io');

  // Language spellings the app actually passes around must not change the answer.
  for (const en of ['en', 'EN', 'English', undefined, null, '']) {
    assert.strictEqual(decide(TCGDEX, en), TCGDEX, `English as ${JSON.stringify(en)} must follow the setting`);
  }
}

function testUnknownSettingIsSafe() {
  // An unrecognised or missing setting falls back to the column default rather
  // than to "whatever isn't TCGdex" by accident.
  for (const junk of [undefined, null, '', 'nonsense', 0, {}]) {
    assert.strictEqual(decide(junk, 'en'), POKEMONTCG, `English + ${JSON.stringify(junk)} falls back to pokemontcg.io`);
    // ...but the language veto still overrides the fallback.
    assert.strictEqual(decide(junk, 'ja'), TCGDEX, `Japanese + ${JSON.stringify(junk)} still uses TCGdex`);
  }
}

function testNoSecondSourceOfTruth() {
  // getScanExclusions used to hand out `pokemonProvider`, and callers then made
  // this decision themselves from it. Removing that field is what makes the bug
  // class structurally impossible rather than merely fixed, so it stays gone.
  return cardSets.getScanExclusions().then((ex) => {
    assert.ok(ex && typeof ex === 'object', 'getScanExclusions still returns the exclusions');
    assert.strictEqual('pokemonProvider' in ex, false,
      'getScanExclusions must NOT expose the provider — utils/pokemonProvider owns that decision');
    for (const k of ['tokens', 'artCards', 'jumpstart', 'promos', 'digital']) {
      assert.strictEqual(typeof ex[k], 'boolean', `${k} is still reported`);
    }
    // Digital defaults ON: Pokémon TCG Pocket cards have no physical printing.
    assert.strictEqual(ex.digital, true, 'digital exclusion defaults on');
  });
}

// The OTHER provider question, kept beside this one on purpose: they look alike
// and are not.
//
//   utils/pokemonProvider — which provider should SERVE this language? Policy,
//                           follows a setting, can change tomorrow.
//   utils/cardApi         — which provider MINTED this id? A fact about a row
//                           that already exists; no setting changes it.
//
// A 'tcgdex-en-sv01-001' card belongs to TCGdex even on an install configured for
// pokemontcg.io. Answering it from the setting instead of the id would reintroduce
// the same class of bug from the opposite direction.
function testIdDispatchIsAboutTheIdNotTheSetting() {
  const cardApi = require('../src/utils/cardApi');

  assert.strictEqual(cardApi.isMtgId('mtg-abc-123'), true);
  assert.strictEqual(cardApi.isMtgId('basep-50'), false);
  assert.strictEqual(cardApi.isTcgdexId('tcgdex-en-sv01-001'), true);
  assert.strictEqual(cardApi.isTcgdexId('tcgdex-ja-sv2a-004'), true);
  assert.strictEqual(cardApi.isTcgdexId('basep-50'), false);

  // Game follows the id...
  assert.strictEqual(cardApi.gameOf('mtg-abc-123'), 'mtg');
  assert.strictEqual(cardApi.gameOf('tcgdex-en-sv01-001'), 'pokemon');
  assert.strictEqual(cardApi.gameOf('basep-50'), 'pokemon');
  // ...unless the caller explicitly says MTG, which the add route relies on.
  assert.strictEqual(cardApi.gameOf('whatever', 'mtg'), 'mtg');
  // But 'pokemon' must never override an mtg- id, or an MTG card is filed as a
  // Pokémon one purely because the request defaulted.
  assert.strictEqual(cardApi.gameOf('mtg-abc-123', 'pokemon'), 'mtg');

  for (const junk of [null, undefined, '', 0]) {
    assert.strictEqual(cardApi.isMtgId(junk), false, `isMtgId survives ${JSON.stringify(junk)}`);
    assert.strictEqual(cardApi.gameOf(junk), 'pokemon', `gameOf survives ${JSON.stringify(junk)}`);
  }
}

async function main() {
  testIdDispatchIsAboutTheIdNotTheSetting();
  testLanguageVeto();
  testUnknownLanguageDegradesToEnglish();
  testEnglishFollowsTheSetting();
  testUnknownSettingIsSafe();
  await testNoSecondSourceOfTruth();
  console.log('pokemonprovider.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
