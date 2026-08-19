// A scanned card must come back in the language being scanned.
//
// Card ART is identical in every language, so the scanner matches a Japanese card
// against whatever catalog exists (English, for most installs) and gets the
// ENGLISH printing back. The scan route re-expresses that answer via
// getPrintingInLang; without it a Japanese scan filed an English printing, with
// English art and an English name, no matter what Card Language was set to.
//
// Scryfall is stubbed: this checks the lookup asks for the right thing and
// classifies the answer correctly, not that Scryfall is up.
const assert = require('assert');

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `bindarr-scanlang-${process.pid}.db`
);

(async () => {
  const scryfall = require('../src/scryfallApi');
  const db = require('../src/db');
  await db.initDb();

  const requested = [];
  // The card endpoint's language form: /cards/:code/:number/:lang.
  scryfall.client.get = async (url) => {
    requested.push(url);
    const m = url.match(/^\/cards\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, set, number, lang] = m;
    // Alpha was never printed outside English — the real 404 case.
    if (set === 'lea') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: `${set}-${number}-${lang}`, lang,
        name: 'Ancestral Katana', printed_name: lang === 'ja' ? '祖先の刀' : 'Katana der Ahnen',
        set, set_name: 'Kamigawa: Neon Dynasty', collector_number: number,
        image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` },
        rarity: 'common', prices: {},
      },
    };
  };

  const ja = await scryfall.getPrintingInLang('neo', '1', 'Japanese');
  assert.ok(ja, 'a Japanese printing should resolve');
  assert.strictEqual(ja.language, 'Japanese', 'row must be tagged Japanese');
  assert.strictEqual(ja.printed_name, '祖先の刀', 'printed_name carries the localized name');
  assert.match(ja.image_url, /ja\.jpg$/, 'art must be the Japanese printing');
  assert.strictEqual(requested[0], '/cards/neo/1/ja', 'asks Scryfall by set+number+lang');

  // English is already what the catalog returns: no request, nothing to switch to.
  const before = requested.length;
  assert.strictEqual(await scryfall.getPrintingInLang('neo', '1', 'English'), null);
  assert.strictEqual(requested.length, before, 'English must not cost a request');

  // Never printed in that language: null, so the caller keeps the English card
  // rather than showing nothing.
  assert.strictEqual(await scryfall.getPrintingInLang('lea', '1', 'Japanese'), null);

  // Second call for the same printing is served from card_cache.
  const cachedAt = requested.length;
  const again = await scryfall.getPrintingInLang('neo', '1', 'Japanese');
  assert.strictEqual(again.printed_name, '祖先の刀');
  assert.strictEqual(requested.length, cachedAt, 'cached printing must not re-request');

  // ---- Pokémon ----------------------------------------------------------
  //
  // Same defect, different mapping. A TCGdex id carries its language
  // (tcgdex-<lang>-<set>-<number>) and Western sets share one set id across
  // languages, so the localized card is addressed by swapping that segment.
  const tcgdex = require('../src/tcgdexApi');
  const asked = [];
  tcgdex.client.get = async (url) => {
    asked.push(url);
    const m = url.match(/^\/([a-z-]+)\/cards\/(.+)$/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, lang, id] = m;
    // Japanese Pokémon sets are their own releases (S12, SV2a), not localized
    // editions of sv03 — so an English set id does not exist in Japanese.
    if (lang === 'ja') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id, localId: id.split('-').pop(), category: 'Pokemon',
        name: lang === 'fr' ? 'Scovilain' : 'Halupenjo',
        set: { id: id.split('-')[0], name: 'Obsidian Flames' },
        image: `https://assets.tcgdex.net/${lang}/sv/sv03/025`,
        rarity: 'Rare', pricing: {},
      },
    };
  };

  const fr = await tcgdex.getPrintingInLang('tcgdex-en-sv03-025', 'French');
  assert.ok(fr, 'a French printing should resolve');
  assert.strictEqual(fr.id, 'tcgdex-fr-sv03-025', 'id swaps only the language segment');
  assert.strictEqual(fr.language, 'French');
  assert.strictEqual(fr.printed_name, 'Scovilain', 'localized name is what the card says');
  assert.match(fr.image_url, /\/fr\//, 'art must be the French printing');

  // Set does not exist in the target language: keep what the caller had.
  assert.strictEqual(await tcgdex.getPrintingInLang('tcgdex-en-sv03-025', 'Japanese'), null);
  // A pokemontcg.io id has no language segment, and its set numbering disagrees
  // with TCGdex's — no honest translation, so no guess.
  const beforePtcg = asked.length;
  assert.strictEqual(await tcgdex.getPrintingInLang('basep-50', 'French'), null);
  assert.strictEqual(asked.length, beforePtcg, 'a pokemontcg.io id must not be requested');
  // Already in the requested language (a catalog built in it): nothing to do.
  const beforeSame = asked.length;
  assert.strictEqual(await tcgdex.getPrintingInLang('tcgdex-ja-S12-001', 'Japanese'), null);
  assert.strictEqual(asked.length, beforeSame, 'same-language id must not be requested');

  // ---- Korean (and Japanese, and Chinese) --------------------------------
  //
  // getPrintingInLang can only ever return null for these: their sets are their
  // own releases (SM1M, S12, SV2a), not localised editions of the English ones, so
  // there is no id to swap to. The scan therefore has to answer with the English
  // card — and the two things that must be true of that answer are checked here
  // against the real route, because both used to be false:
  //
  //   · it has to BE an answer. The candidate was resolved by set + collector
  //     number through the provider for the SCANNED language, and the set id came
  //     from TCGplayer's English catalogue, so a Korean scan asked TCGdex/ko about
  //     'base6' and got nothing — every candidate unresolvable, "no confident
  //     match", while the same photo scanned as English named the card at once.
  //   · it has to say it is English art. An unmarked English row is exactly what a
  //     genuine English printing looks like.
  const router = require('../src/routes/collection');
  const scanLayer = router.stack.find(l => l.route && l.route.path === '/scan-match');
  const scanMatch = scanLayer.route.stack[scanLayer.route.stack.length - 1].handle;

  // Pinned, because the English retry goes through the CONFIGURED English provider
  // rather than a hardcoded one (utils/pokemonProvider): with pokemontcg.io set,
  // the two lookups land on two different modules, which is the arrangement worth
  // checking. TCGdex-configured installs differ only in that both calls are TCGdex,
  // one per language.
  await db.run(`UPDATE app_settings SET pokemon_provider = 'pokemontcg' WHERE id = 1`);

  const cvScan = require('../src/cvScan');
  const tcgplayerCatalog = require('../src/tcgplayerCatalog');
  const tcgApi = require('../src/tcgApi');
  cvScan.isBuilt = () => true;
  cvScan.match = async () => ({ verified: false, candidates: [{ productId: 42, score: 0.91 }] });
  // The published Pokémon catalog is TCGplayer's ENGLISH products, whatever
  // language is being scanned.
  tcgplayerCatalog.lookup = async () => ({ name: 'Charizard', set_id: 'base6', number: '96' });
  const koAsked = [];
  tcgdex.searchCards = async ({ set, lang }) => {
    koAsked.push({ set, lang });
    return { cards: [], total: null };   // 'base6' does not exist in Korean
  };
  tcgApi.searchCards = async ({ number, set }) => ({
    cards: set === 'base6' && number === '96'
      ? [{ id: 'base6-96', name: 'Charizard', number: '96', set_id: 'base6', set_name: 'Legendary Collection', language: 'English', image_url: 'https://img/en.png' }]
      : [],
    total: null,
  });

  const scan = async (lang) => {
    let body = null;
    await scanMatch(
      { body: { game: 'pokemon', image: 'x'.repeat(200), lang }, user: { tcg_api_key: '' }, query: {} },
      { json: (b) => { body = b; }, status() { return this; } },
    );
    return body;
  };

  const ko = await scan('ko');
  const kCard = ko.candidates[0].card;
  assert.ok(kCard, 'a Korean scan must resolve the candidate, not drop it');
  assert.strictEqual(kCard.id, 'base6-96', 'the English printing is the only one that exists');
  assert.strictEqual(kCard.langFallback, 'Korean', 'and it must be marked as standing in for Korean');
  assert.deepStrictEqual(koAsked, [{ set: 'base6', lang: 'ko' }], 'Korean is asked first, and only once');

  // English asks once and carries no marker — there is nothing to disclaim.
  const en = await scan('en');
  assert.strictEqual(en.candidates[0].card.id, 'base6-96');
  assert.strictEqual(en.candidates[0].card.langFallback, undefined, 'an English scan must not be marked');
  assert.strictEqual(koAsked.length, 1, 'an English scan must not consult TCGdex');

  console.log('scanlang.test.js: all 25 assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
