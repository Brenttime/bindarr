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

  console.log('scanlang.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
