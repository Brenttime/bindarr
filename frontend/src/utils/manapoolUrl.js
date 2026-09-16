// Build a ManaPool "Mass Entry" deep link that arrives already prefilled.
//
// ManaPool's /add-deck page reads a base64 `deck` query param and drops the
// decoded list straight into its paste box — verified live against the real
// endpoint, where the box populates and the rows parse. So rather than copy
// to the clipboard and hope the user pastes, we encode the list and open the
// URL with the deck in place. `ref` is ManaPool's own attribution tag, the
// same value the ManaBox share links send.
//
// Two traps this handles, both learned from real card names:
//   - Names are not ASCII ("Kambite, the Ascendant", "Gisela, the Ascendant",
//     accented and apostrophe'd names throughout). A bare btoa throws on any
//     code point above 255, so the text goes through TextEncoder to utf-8
//     bytes first and only then to btoa.
//   - base64 can contain '+', '/' and '='. Sent raw in a query string a '+'
//     arrives as a space and mangles the list, so the token is
//     percent-encoded, which also takes care of '/' and '='.

const MANAPOOL_ADD_DECK = 'https://manapool.com/add-deck';
const MANAPOOL_REF = 'manabox';

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// `lines` is the plain "N Card Name" body the shared card-list formatter
// produces, one line per card; an array is joined with newlines. Blank input
// yields '' so the caller can skip opening a tab that would only show an empty
// box. TextEncoder is a browser and Node global, so this needs no dependency.
export function buildManapoolUrl(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const body = list.map((l) => String(l ?? '').trim()).filter((l) => l !== '').join('\n');
  if (!body) return '';
  return `${MANAPOOL_ADD_DECK}?deck=${encodeURIComponent(toBase64(body))}&ref=${MANAPOOL_REF}`;
}
