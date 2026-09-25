import assert from 'node:assert';
import { buildBookmarklet, readTcgImportHash, scrapeTcgOrderPage, TCG_IMPORT_HASH } from './tcgBookmarklet.js';

// The bookmarklet must be one valid javascript: URL that parses as a program.
const bm = buildBookmarklet('http://192.168.4.37:3002/');
assert.ok(bm.startsWith('javascript:'));
const src = decodeURIComponent(bm.slice('javascript:'.length));
assert.doesNotThrow(() => new Function(src), 'bookmarklet body parses');
assert.ok(src.includes('"http://192.168.4.37:3002/#tcgimport="'), 'targets this Scrybox origin, trailing slash trimmed');

// Minimal DOM stub: enough surface for the scraper (querySelectorAll, parents, text).
function el(tag, text, attrs = {}, kids = []) {
  const node = { tagName: tag, attrs, children: kids, parentElement: null, _text: text };
  kids.forEach((k) => { k.parentElement = node; });
  node.getAttribute = (n) => attrs[n] ?? null;
  Object.defineProperty(node, 'innerText', { get() { return [node._text, ...node.children.map((c) => c.innerText)].filter(Boolean).join(' '); } });
  node.querySelectorAll = (sel) => {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (sel.includes('/product/') ? (c.tagName === 'A' && String(c.attrs.href || '').includes('/product/')) : false) out.push(c); walk(c); });
    walk(node);
    return out;
  };
  node.querySelector = (sel) => (sel === 'img' ? node.children.find((c) => c.tagName === 'IMG') || null : null);
  return node;
}
const row1 = el('TR', '', {}, [
  el('TD', '', {}, [el('A', 'Sol Ring', { href: 'https://www.tcgplayer.com/product/12345/magic-commander-sol-ring' })]),
  el('TD', 'Near Mint Foil'), el('TD', 'Qty: 2'), el('TD', '$1.50 $3.00'),
]);
const row2 = el('TR', '', {}, [
  el('TD', '', {}, [el('A', 'Arcane Signet', { href: '/product/67890?Language=English' })]),
  el('TD', 'Lightly Played'), el('TD', 'Qty: 1'), el('TD', '$0.40'),
]);
const table = el('TABLE', '', {}, [row1, row2]);
const body = el('DIV', 'Order Number 1A2B3C4D-5E6F7A-8B9C0', {}, [table]);
const doc = { body, querySelectorAll: (s) => body.querySelectorAll(s) };
const got = scrapeTcgOrderPage(doc);
assert.deepStrictEqual(got.orders, ['1A2B3C4D-5E6F7A-8B9C0']);
assert.strictEqual(got.lines.length, 2);
assert.deepStrictEqual(
  got.lines.map((l) => [l.tcgplayer_product_id, l.name, l.quantity, l.condition, l.is_foil, l.price_cents]),
  [['12345', 'Sol Ring', 2, 'Near Mint', true, 150], ['67890', 'Arcane Signet', 1, 'Lightly Played', false, 40]],
);

// The Scrybox side accepts only product-id lines and survives garbage.
const hash = TCG_IMPORT_HASH + encodeURIComponent(JSON.stringify({ orders: ['X'], lines: [{ tcgplayer_product_id: '12' }, { tcgplayer_product_id: 'nope' }] }));
assert.deepStrictEqual(readTcgImportHash(hash).lines, [{ tcgplayer_product_id: '12' }]);
assert.strictEqual(readTcgImportHash('#tcgimport=%7Bbad'), null);
assert.strictEqual(readTcgImportHash('#other'), null);
console.log('tcgBookmarklet ok');
