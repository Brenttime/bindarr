import assert from 'node:assert';
import { buildManapoolUrl } from './manapoolUrl.js';

// Node 22 ships TextEncoder/atob/btoa as globals, the same ones the browser
// provides, so the util is exercised directly. Buffer is used for the oracle
// decode only, via node:buffer, to keep off the property-form accessor that a
// token-flattening transit step has been observed to mangle.

const { Buffer } = await import('node:buffer');
const base64Of = (t) => Buffer.from(t, 'utf-8').toString('base64');
const decodeB64 = (b64) => {
  return new TextDecoder('utf-8').decode(Uint8Array.from(atob(decodeURIComponent(b64)), (c) => c.charCodeAt(0)));
};

const deckOf = (url) => {
  const start = url.indexOf('?deck=');
  if (start === -1) return null;
  const rest = url.slice(start + 6);
  const amp = rest.indexOf('&');
  return amp === -1 ? rest : rest.slice(0, amp);
};

// Hard oracle: the exact base64 ManaPool put on the wire for this list, taken
// from Brent's reference link. Reproducing it byte-for-byte is what proves
// Scrybox speaks ManaPool's dialect rather than merely a self-consistent one.
const ORACLE_LIST = [
  '1 Echocasting Symposium [SOS] 44',
  '1 The Legend of Yangchen // Avatar Yangchen [TLA] 27',
  '1 Frantic Search [TDC] 153',
  '1 Harmonized Trio // Brainstorm [SOS] 52',
  '1 Mister Fantastic, Reed Richards [MSH] 66',
  "1 River's Rebuke [FDN] 595",
  '1 Joined Researchers // Secret Rendezvous [SOS] 23',
  '1 Bident of Thassa [BLC] 162',
  '1 Distant Melody [ECC] 45',
  '1 Volcanic Torrent [SOC] 260',
  '1 Gallifrey Falls // No More [WHO] 131',
  '1 Daily Bugle Newspaper [MSC] 749',
  '1 Talisman of Progress [TDC] 333',
  '1 Ferrous Lake [SOC] 370',
];
const ORACLE_B64 = 'MSBFY2hvY2FzdGluZyBTeW1wb3NpdW0gW1NPU10gNDQKMSBUaGUgTGVnZW5kIG9mIFlhbmdjaGVuIC8vIEF2YXRhciBZYW5nY2hlbiBbVExBXSAyNwoxIEZyYW50aWMgU2VhcmNoIFtURENdIDE1MwoxIEhhcm1vbml6ZWQgVHJpbyAvLyBCcmFpbnN0b3JtIFtTT1NdIDUyCjEgTWlzdGVyIEZhbnRhc3RpYywgUmVlZCBSaWNoYXJkcyBbTVNIXSA2NgoxIFJpdmVyJ3MgUmVidWtlIFtGRE5dIDU5NQoxIEpvaW5lZCBSZXNlYXJjaGVycyAvLyBTZWNyZXQgUmVuZGV6dm91cyBbU09TXSAyMwoxIEJpZGVudCBvZiBUaGFzc2EgW0JMQ10gMTYyCjEgRGlzdGFudCBNZWxvZHkgW0VDQ10gNDUKMSBWb2xjYW5pYyBUb3JyZW50IFtTT0NdIDI2MAoxIEdhbGxpZnJleSBGYWxscyAvLyBObyBNb3JlIFtXSE9dIDEzMQoxIERhaWx5IEJ1Z2xlIE5ld3NwYXBlciBbTVNDXSA3NDkKMSBUYWxpc21hbiBvZiBQcm9ncmVzcyBbVERDXSAzMzMKMSBGZXJyb3VzIExha2UgW1NPQ10gMzcw';

const url = buildManapoolUrl(ORACLE_LIST);
const deck = deckOf(url);

assert.ok(url.indexOf('https://manapool.com/add-deck?deck=') === 0, 'base url and deck param');
assert.ok(url.indexOf('&ref=manabox') === url.length - 12, 'carries the manabox attribution tag');
assert.strictEqual(deck, ORACLE_B64, 'base64 must match the reference token byte for byte');
assert.strictEqual(decodeB64(deck), ORACLE_LIST.join('\n'), 'the token decodes to the same list');

// The reference token itself is the compatibility claim: it decodes cleanly.
assert.ok(decodeB64(ORACLE_B64).startsWith('1 Echocasting Symposium [SOS] 44'), 'oracle decodes');

// Accented and non-Latin names must survive the utf-8 detour.
const FANCY = ['1 Kambite, the Ascendant', '1 Guul Dazida, the Risen', '1 «Tarmogaf», Flower', '1 Llanowar, Spawn of Ambush'];
const fancyDeck = deckOf(buildManapoolUrl(FANCY));
assert.strictEqual(decodeB64(fancyDeck), FANCY.join('\n'), 'non-ascii round-trip');
assert.ok(fancyDeck.indexOf(' ') === -1 && encodeURIComponent(' ') !== ' ', 'no raw spaces in the token');

// A '+' in the payload is the corruption trap: it must never reach the query
// raw, or the receiving side reads it as a space.
// The '+' trap, with deterministic witnesses rather than a lucky-draw scan.
// base64 emits '+' (value 62) and '/' (63) only when two high bits land in
// one sextet, which seven-bit ASCII cannot produce -- so those tokens appear
// solely once a card name carries a non-ASCII code point, the same situation
// that would make a bare btoa throw. '¾' and '¿' below are proven witnesses:
// their base64 ends in '+' and '/' respectively.
const PLUS_WITNESS = '1 Card ¾';
const SLASH_WITNESS = '1 Card ¿';

for (const probe of [PLUS_WITNESS, SLASH_WITNESS]) {
  const raw = deckOf(buildManapoolUrl([probe]));
  assert.ok(raw.indexOf(' ') === -1, 'no literal space in the query token');
  assert.ok(raw.indexOf('+') === -1, "no literal '+' in the query token");
  assert.ok(raw.indexOf('/') === -1, "no literal '/' in the query token");
  assert.ok(raw.indexOf('&') === -1, 'no bare ampersand in the query token');
  assert.ok(raw.indexOf('=') === -1, 'padding is percent-encoded, never raw');
  assert.strictEqual(decodeB64(raw), probe, 'marker-bearing token still round-trips exactly');
}
assert.ok(deckOf(buildManapoolUrl([PLUS_WITNESS])).includes('%2B'), "the plus became %2B");
assert.ok(deckOf(buildManapoolUrl([SLASH_WITNESS])).includes('%2F'), "the slash became %2F");
assert.strictEqual(deckOf(buildManapoolUrl([PLUS_WITNESS])), encodeURIComponent(base64Of(PLUS_WITNESS)), 'witness token is percent-encoded base64');

// Empty input must not open a blank tab upstream.
assert.strictEqual(buildManapoolUrl(''), '', 'empty string');
assert.strictEqual(buildManapoolUrl('   \n \n '), '', 'whitespace only');
assert.strictEqual(buildManapoolUrl([]), '', 'empty array');
assert.strictEqual(buildManapoolUrl(['  ', '']), '', 'blank lines only');
assert.ok(buildManapoolUrl(['1 Island']).length > 40, 'a real deck produces a url');

// Array and pre-joined string must agree.
assert.strictEqual(
  deckOf(buildManapoolUrl(['1 Ancestor', '1 Island'])),
  deckOf(buildManapoolUrl('1 Ancestor\n1 Island')),
  'array and string forms agree',
);

// The base64 is real, not a stand-in: the decoded bytes are the deck itself.
const sample = decodeB64(ORACLE_B64);
assert.ok(sample.includes('1 Ferrous Lake [SOC] 370'), 'oracle text is the reference deck');
assert.ok(!sample.includes('\r'), 'no carriage leaks');
assert.ok(Buffer.from(ORACLE_B64, 'base64').length > 100, 'oracle decodes to real bytes');

console.log('manapoolUrl: all assertions passed');
