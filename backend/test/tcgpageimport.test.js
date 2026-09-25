// TCGplayer bookmarklet import: product-id lines resolve by identity only.
const assert = require('assert');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-tcgpage-${process.pid}.db`);
const { cleanTcgPageLines, resolveTcgPageLines } = require('../src/utils/marketplaceOrders');

(async () => {
  const clean = cleanTcgPageLines([
    { tcgplayer_product_id: '111', name: 'Sol Ring', quantity: 3, condition: 'Lightly Played', is_foil: true, price_cents: 150 },
    { tcgplayer_product_id: 'abc', name: 'bad id' },
    { tcgplayer_product_id: 222, quantity: -4, price_cents: 'x' },
    null,
  ]);
  assert.strictEqual(clean.length, 2);
  assert.deepStrictEqual(clean[0], { tcgplayer_product_id: '111', name: 'Sol Ring', quantity: 3, price_cents: 150, is_foil: true, condition: 'Lightly Played', order: null });
  assert.strictEqual(clean[1].quantity, 1, 'nonsense quantity falls back to 1');
  assert.strictEqual(clean[1].price_cents, null);
  assert.strictEqual(clean[1].condition, null, 'no condition is not invented');

  const asked = [];
  const db = { all: async (sql, params) => { assert.deepStrictEqual(params, [111, 222, 333]); return [{ id: 'mtg-aaaa', pid: 111, language: 'English' }]; } };
  const scryGet = async (url) => {
    asked.push(url);
    if (url.endsWith('/222')) return { data: { id: 'bbbb' } };
    const e = new Error('nf'); e.response = { status: 404 }; throw e;
  };
  const lines = await resolveTcgPageLines([
    { tcgplayer_product_id: '111', name: 'Sol Ring', quantity: 2 },
    { tcgplayer_product_id: '222', name: 'Signet' },
    { tcgplayer_product_id: '333', name: 'Booster Box' },
    { tcgplayer_product_id: '111', name: 'Sol Ring', quantity: 1 },
  ], { db, scryGet });
  assert.deepStrictEqual(asked, ['/cards/tcgplayer/222', '/cards/tcgplayer/333'], 'cached ids never hit Scryfall');
  assert.deepStrictEqual(lines.map((l) => [l.scryfall_id, l.junk]), [['aaaa', false], ['bbbb', false], [null, true], ['aaaa', false]]);
  assert.strictEqual(lines.__cardCopies, 4);
  assert.deepStrictEqual(lines.__unmatched, ['Booster Box']);
  console.log('tcgpageimport ok');
})().catch((e) => { console.error(e); process.exit(1); });
