// Loose, forgiving text matching for filter pickers.
// Case/accent/punctuation-insensitive. A query matches when every word appears
// somewhere in the label (any order), or, failing that, when its letters
// appear in order (subsequence), so "mh3" finds "Modern Horizons 3" and
// "dsk" finds "Duskmourn: House of Horror".
export function normalizeLoose(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Returns a score (higher = better) or 0 for no match.
export function looseScore(label, query) {
  const q = normalizeLoose(query);
  if (!q) return 1;
  const l = normalizeLoose(label);
  if (l.startsWith(q)) return 4;
  if (l.includes(q)) return 3;
  const words = q.split(' ');
  if (words.every(w => l.includes(w))) return 2;
  const cq = q.replace(/ /g, '');
  const cl = l.replace(/ /g, '');
  let i = 0;
  for (const ch of cl) { if (ch === cq[i]) i++; if (i === cq.length) return 1; }
  return 0;
}

export function looseFilter(options, query, getLabel = o => o.label) {
  if (!normalizeLoose(query)) return options;
  return options
    .map((o, idx) => ({ o, idx, s: looseScore(getLabel(o), query) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map(x => x.o);
}

// Local calendar day (YYYY-MM-DD) for a stored added_at. SQLite
// CURRENT_TIMESTAMP is UTC without a zone ("2026-09-23 01:30:00"), so it is
// read as UTC and shown in the viewer's timezone.
export function localDayOf(addedAt) {
  if (!addedAt) return '';
  let s = String(addedAt).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Inclusive from/to (YYYY-MM-DD, either may be blank).
export function inDayRange(addedAt, from, to) {
  if (!from && !to) return true;
  const day = localDayOf(addedAt);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}
