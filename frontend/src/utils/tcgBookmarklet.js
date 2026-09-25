// TCGplayer "Send to Scrybox" bookmarklet.
//
// TCGplayer has no buyer API, and a pasted session cookie expires (and order
// history additionally demands a fresh password re-check). The bookmarklet
// sidesteps both: it runs INSIDE the user's own logged-in TCGplayer tab, reads
// the order off the page they are looking at, and opens Scrybox with the lines
// in the URL fragment. Nothing is stored and no credential ever leaves
// TCGplayer; the fragment is never sent to any server.
//
// The reader is deliberately structure-agnostic: TCGplayer reshuffles its markup
// often, so it keys on the one thing every order row carries, a link to
// /product/<id>. That product id is the same TCGplayer id Scryfall indexes,
// which makes the server-side match exact (printing included) rather than a
// name guess. Quantity, condition and price are read from the row's text.
//
// scrapeTcgOrderPage must stay SELF-CONTAINED (no imports, no closures): it is
// serialised with Function#toString into the bookmarklet.

export function scrapeTcgOrderPage(doc) {
  var ORDER_RE = /\b([0-9A-F]{8}-[0-9A-F]{6}-[0-9A-F]{5})\b/i;
  var COND_RE = /(Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged)(\s+(?:Holo)?Foil|\s+Etched(?:\s+Foil)?)?/i;
  var links = Array.prototype.slice.call(doc.querySelectorAll('a[href*="/product/"]'));
  var seenRow = [];
  var lines = [];
  var orders = {};

  function rowOf(a) {
    // Climb to the smallest ancestor that holds this product and no other.
    var el = a;
    for (var i = 0; i < 8 && el.parentElement; i++) {
      var p = el.parentElement;
      var ids = {};
      var inner = p.querySelectorAll('a[href*="/product/"]');
      for (var j = 0; j < inner.length; j++) {
        var mm = (inner[j].getAttribute('href') || '').match(/\/product\/(\d+)/);
        if (mm) ids[mm[1]] = 1;
      }
      if (Object.keys(ids).length > 1) break;
      el = p;
      if (el.tagName === 'TR' || el.tagName === 'LI') break;
    }
    return el;
  }
  function orderOf(el) {
    for (var n = el; n; n = n.parentElement) {
      var t = (n.innerText || n.textContent || '');
      var m = t.match(ORDER_RE);
      if (m) return m[1].toUpperCase();
    }
    var whole = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
    var w = whole.match(ORDER_RE);
    return w ? w[1].toUpperCase() : null;
  }

  for (var k = 0; k < links.length; k++) {
    var a = links[k];
    var m = (a.getAttribute('href') || '').match(/\/product\/(\d+)/);
    if (!m) continue;
    var row = rowOf(a);
    if (seenRow.indexOf(row) !== -1) continue;
    seenRow.push(row);
    var text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
    var name = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      var img = a.querySelector('img');
      name = img ? (img.getAttribute('alt') || '') : '';
    }
    var qm = text.match(/(?:Qty|Quantity)\s*:?\s*(\d+)/i) || text.match(/\b(\d+)\s*[x×]\s/i) || text.match(/\s[x×]\s*(\d+)\b/i);
    var cm = text.match(COND_RE);
    var prices = text.match(/\$\s?\d[\d,]*\.\d{2}/g) || [];
    var qty = qm ? parseInt(qm[1], 10) : 1;
    // A row usually shows unit price then line total; the smallest is the unit.
    var cents = null;
    for (var q = 0; q < prices.length; q++) {
      var c = Math.round(parseFloat(prices[q].replace(/[$,\s]/g, '')) * 100);
      if (cents === null || c < cents) cents = c;
    }
    var order = orderOf(row);
    if (order) orders[order] = 1;
    lines.push({
      tcgplayer_product_id: m[1],
      name: name.slice(0, 200),
      quantity: qty > 0 && qty < 1000 ? qty : 1,
      condition: cm ? cm[1] : null,
      is_foil: !!(cm && cm[2]) || /\bfoil\b/i.test(text) && !/non-?foil/i.test(text),
      price_cents: cents,
      order: order,
    });
  }
  var list = Object.keys(orders);
  return { orders: list, lines: lines };
}

// Runs in the TCGplayer tab. Kept tiny: scrape, then hand off by navigation
// (window.open), which works from an https page to an http LAN Scrybox where a
// fetch would be blocked as mixed content.
export function buildBookmarklet(scryboxOrigin) {
  var body =
    '(function(){' +
    'var s=(' + scrapeTcgOrderPage.toString() + ')(document);' +
    'if(!s.lines.length){alert("Scrybox: no cards found on this page. Open a TCGplayer order (Order History or an order detail page) and try again.");return;}' +
    'var p=encodeURIComponent(JSON.stringify({v:1,source:"tcgplayer",page:location.href.split("?")[0],orders:s.orders,lines:s.lines}));' +
    'var u=' + JSON.stringify(String(scryboxOrigin).replace(/\/+$/, '') + '/#tcgimport=') + '+p;' +
    // Phones often block or swallow popups from bookmarks: fall back to
    // navigating this tab (Back returns to TCGplayer).
    'var w=null;try{w=window.open(u,"_blank");}catch(e){}if(!w)location.href=u;' +
    '})()';
  return 'javascript:' + encodeURIComponent(body);
}

// Scrybox side: read (and forget) a payload the bookmarklet put in the URL.
export const TCG_IMPORT_HASH = '#tcgimport=';
export const TCG_IMPORT_KEY = 'scrybox_tcg_import';

export function takePendingTcgImport() {
  try {
    const raw = sessionStorage.getItem(TCG_IMPORT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(TCG_IMPORT_KEY);
    const data = JSON.parse(raw);
    return data && Array.isArray(data.lines) && data.lines.length ? data : null;
  } catch { return null; }
}
export function hasPendingTcgImport() {
  try { return !!sessionStorage.getItem(TCG_IMPORT_KEY); } catch { return false; }
}

export function readTcgImportHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(TCG_IMPORT_HASH)) return null;
  try {
    const data = JSON.parse(decodeURIComponent(hash.slice(TCG_IMPORT_HASH.length)));
    if (!data || !Array.isArray(data.lines)) return null;
    const lines = data.lines
      .filter((l) => l && /^\d{1,10}$/.test(String(l.tcgplayer_product_id || '')))
      .slice(0, 1000);
    if (!lines.length) return null;
    return { orders: Array.isArray(data.orders) ? data.orders.map(String).slice(0, 50) : [], lines };
  } catch {
    return null;
  }
}
