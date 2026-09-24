// ManaBox sync: bring the collection (and ManaBox lists) in line with a
// ManaBox "Export collection" CSV. Pure planning lives here so it can be unit
// tested; routes/manaboxSync.js does the I/O.
//
// Rules (docs/manabox-sync.md):
// - Owned = rows whose Binder Type is binder or deck. Lists are never owned;
//   they become Scrybox lists instead.
// - Identity = exact printing (mtg-<Scryfall ID>) + printing + condition +
//   language. The CSV's set code, collector number and name must agree with
//   the card Scryfall returns for that id, or the row is rejected.
// - Only collection rows that came from ManaBox (collection.source =
//   'manabox') can be removed. Cards added in Scrybox itself are never
//   removed, and count as owned, so nothing is added twice.
// - ManaBox's "Added" date becomes the row's added_at.
// - Re-running the same file is a no-op.

const PRINTING = { normal: 'Normal', foil: 'Holofoil', etched: 'Holofoil' };
const CONDITION = {
  mint: 'Near Mint', near_mint: 'Near Mint', excellent: 'Lightly Played',
  good: 'Moderately Played', light_played: 'Lightly Played', played: 'Heavily Played', poor: 'Damaged',
};
const LANGUAGE = {
  en: 'English', ja: 'Japanese', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish',
  pt: 'Portuguese', ko: 'Korean', ru: 'Russian', zhs: 'Chinese Simplified', zht: 'Chinese Traditional',
  ph: 'Phyrexian',
};
const REQUIRED = ['Binder Name', 'Binder Type', 'Name', 'Set code', 'Collector number', 'Foil',
  'Quantity', 'Scryfall ID', 'Condition', 'Language', 'Added'];

// RFC 4180 CSV (quoted fields, doubled quotes, CRLF). ManaBox names contain commas.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function toSqlDate(iso) {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// CSV text -> { owned: [{key, card_id, printing, condition, language, dates[], ...}], lists, errors }
function parseManaboxExport(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'The file is empty.' };
  const missing = REQUIRED.filter(h => !(h in rows[0]));
  if (missing.length) return { error: `This is not a ManaBox collection export (missing ${missing.join(', ')}).` };
  const owned = new Map();
  const lists = new Map();
  const errors = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const sid = String(r['Scryfall ID'] || '').trim().toLowerCase();
    const qty = parseInt(r.Quantity, 10);
    if (!/^[0-9a-f-]{36}$/.test(sid)) return errors.push({ line, name: r.Name, reason: 'missing Scryfall ID' });
    if (!(qty > 0)) return errors.push({ line, name: r.Name, reason: 'bad quantity' });
    const expect = { set: String(r['Set code'] || '').toLowerCase(), number: String(r['Collector number'] || ''), name: r.Name };
    const cardId = `mtg-${sid}`;
    if (r['Binder Type'] === 'list') {
      const name = r['Binder Name'] || 'ManaBox list';
      if (!lists.has(name)) lists.set(name, new Map());
      const l = lists.get(name);
      const cur = l.get(cardId) || { card_id: cardId, quantity: 0, expect };
      cur.quantity += qty;
      l.set(cardId, cur);
      return;
    }
    const printing = PRINTING[r.Foil];
    const condition = CONDITION[r.Condition];
    const language = LANGUAGE[r.Language];
    if (!printing || !condition || !language) {
      return errors.push({ line, name: r.Name, reason: `unknown ${!printing ? 'foil' : !condition ? 'condition' : 'language'} "${!printing ? r.Foil : !condition ? r.Condition : r.Language}"` });
    }
    const key = `${cardId}|${printing}|${condition}|${language}`;
    const cur = owned.get(key) || { key, card_id: cardId, printing, condition, language, dates: [], quantity: 0, purchase_price: null, expect, binders: new Set() };
    cur.quantity += qty;
    const d = toSqlDate(r.Added);
    for (let n = 0; n < qty; n++) cur.dates.push(d);
    const price = parseFloat(r['Purchase price']);
    if (price > 0 && cur.purchase_price == null) cur.purchase_price = price;
    cur.binders.add(r['Binder Name']);
    owned.set(key, cur);
  });
  for (const o of owned.values()) o.dates.sort((a, b) => String(a || '').localeCompare(String(b || '')));
  return { rows: rows.length, owned: [...owned.values()], lists, errors };
}

// Normalise for the set/number/name check: Scryfall double-faced names are
// "Front // Back" where ManaBox often has just the front.
const face = s => String(s || '').split(' // ')[0].trim().toLowerCase();

// Does the CSV row agree with the card that id resolves to?
function identityMismatch(expect, card) {
  if (!card) return 'Scryfall has no card with this ID';
  const set = String(card.set_id || '').replace(/^mtg-/, '').toLowerCase();
  if (expect.set && set !== expect.set) return `set ${expect.set.toUpperCase()} vs ${set.toUpperCase()}`;
  if (expect.number && String(card.number) !== expect.number) return `collector number ${expect.number} vs ${card.number}`;
  if (expect.name && face(card.name) !== face(expect.name) && face(card.printed_name) !== face(expect.name)) return `name "${expect.name}" vs "${card.name}"`;
  return null;
}

// collection rows (this user) + parsed owned -> plan.
// rows: [{id, card_id, quantity, printing, condition, language, added_at, source}]
function planCollection(rows, owned) {
  const keyOf = c => `${c.card_id}|${c.printing}|${c.condition}|${c.language}`;
  const want = new Map(owned.map(o => [o.key, o]));
  const byKey = new Map();
  for (const c of rows) {
    const k = keyOf(c);
    if (!byKey.has(k)) byKey.set(k, { manabox: [], hand: 0, total: 0 });
    const g = byKey.get(k);
    g.total += c.quantity;
    if (c.source === 'manabox') g.manabox.push(c); else g.hand += c.quantity;
  }
  const remove = [];   // row ids to delete (ManaBox-origin rows beyond what is owned)
  const redate = [];   // [row id, date]
  const add = [];      // {card_id, printing, condition, language, purchase_price, added_at}
  const keys = new Set([...byKey.keys(), ...want.keys()]);
  for (const k of keys) {
    const g = byKey.get(k) || { manabox: [], hand: 0, total: 0 };
    const o = want.get(k);
    const ownedQty = o ? o.quantity : 0;
    const dates = o ? [...o.dates] : [];
    // ManaBox rows keep up to ownedQty copies, oldest first, and take ManaBox dates.
    let keep = ownedQty;
    for (const c of [...g.manabox].sort((a, b) => a.id - b.id)) {
      if (keep >= c.quantity) {
        keep -= c.quantity;
        const d = dates.splice(0, c.quantity)[0];
        if (d && d !== c.added_at) redate.push([c.id, d]);
      } else remove.push(c);
    }
    // Missing copies: owned minus everything already there (hand adds count).
    const kept = g.total - remove.filter(c => keyOf(c) === k).reduce((s, c) => s + c.quantity, 0);
    for (let n = kept; n < ownedQty; n++) {
      add.push({ card_id: o.card_id, printing: o.printing, condition: o.condition, language: o.language,
        purchase_price: o.purchase_price, added_at: dates.shift() || null, expect: o.expect });
    }
  }
  return { remove, redate, add };
}

// Existing list cards (listId -> Map(card_id -> qty)) + CSV lists -> plan.
// Lists are matched by name; a CSV list replaces the Scrybox list's contents
// only for lists previously created by sync (source = 'manabox'). A Scrybox
// list with the same name that sync did not create is left alone.
function planLists(existing, csvLists) {
  const create = [], update = [], skipped = [];
  for (const [name, cards] of csvLists) {
    const ex = existing.find(l => l.name === name);
    const entries = [...cards.values()];
    if (!ex) { create.push({ name, cards: entries }); continue; }
    if (ex.source !== 'manabox') { skipped.push(name); continue; }
    const same = ex.cards.size === entries.length && entries.every(e => ex.cards.get(e.card_id) === e.quantity);
    if (!same) update.push({ id: ex.id, name, cards: entries });
  }
  return { create, update, skipped };
}

module.exports = { parseCsv, parseManaboxExport, identityMismatch, planCollection, planLists, toSqlDate, PRINTING, CONDITION, LANGUAGE };
