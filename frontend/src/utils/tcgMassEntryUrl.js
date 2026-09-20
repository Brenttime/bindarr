// Build a TCGplayer "Mass Entry" deep link that arrives already prefilled.
//
// This is the exact shape TCGplayer's own Mass Entry "Create a Shareable
// Link" button emits - read off their shipped bundle, not guessed. The page
// reads a `c` query param, splits it on the literal delimiter `||` (their
// MassEntryQueryDelimiter), then parses each segment against
//   ^(?<quantity>\d+)(\s+(?<productName>\S.*)|-(?<productId>\d+))$
// optionally with " [SET] number" appended. A "QTY-PRODUCT-ID" segment
// resolves straight to a product row; a name segment is searched like typing
// it, and unknown names stay as "not found" placeholders rather than being
// dropped - same as a hand-entered Mass Entry.
//
// Encoding mirrors their exporter byte-for-byte: each line is
// encodeURIComponent'd individually, then the pieces are joined with raw
// `||` markers that stay literal in the query string (their parser splits
// before decoding each segment). encodeURIComponent leaves -_.!~*'()
// unescaped and turns spaces into %20, so plain "N Card Name" lines match
// what the share button builds for them.
//
// `loaddata` links (what site-shared deck lists use) point at a
// server-stored list by GUID and cannot be minted from here; the `c=` form
// is strictly better - the whole list rides in the URL, nothing is stored.
// Verified live against the real site: populated entries resolve to product
// rows, comma/apostrophe names survive, and unknown entries show not-found.

const TCG_MASSENTRY = 'https://www.tcgplayer.com/massentry';

// `lines` is the plain "N Card Name" body the shared card-list formatter
// produces - one line per card, exactly what the parser above eats. Blank
// input yields '' so the caller can skip opening a tab that would only
// show an empty box.
export function buildTcgMassEntryUrl(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const entries = list.map((l) => String(l ?? '').trim()).filter((l) => l !== '');
  if (!entries.length) return '';
  const c = entries.map((l) => encodeURIComponent(l)).join('||');
  return `${TCG_MASSENTRY}?productline=Magic&c=${c}`;
}
