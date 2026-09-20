import assert from 'node:assert';
import { buildTcgMassEntryUrl } from './tcgMassEntryUrl.js';

// Oracle vectors captured live: TCGplayer buttons' own exporter emits each
// list line already percent-encoded and joins them with literal `||`. These
// expectations come from observing a real share link for a real list (and
// the comma/apostrophe line matches what their loader accepts).

const url = buildTcgMassEntryUrl(['1 Lightning Bolt', '1 Counterspell']);
assert.equal(
  url,
  'https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Lightning%20Bolt||1%20Counterspell',
);

// Array and newline-string inputs agree (same contract as manapoolUrl).
assert.equal(buildTcgMassEntryUrl('1 Lightning Bolt\n1 Counterspell'), url);

// Blank input yields no link at all.
assert.equal(buildTcgMassEntryUrl(''), '');
assert.equal(buildTcgMassEntryUrl(['', '  ', '']), '');

// Comma and apostrophe names encode exactly like the live page parses them;
// encodeURIComponent leaves ' and , that need no escape alone, but commas in
// names must be escaped — assert the captured form.
assert.equal(
  buildTcgMassEntryUrl(["1 Glover, the Fist"]),
  'https://www.tcgplayer.com/massentry?productline=Magic&c=1%20Glover%2C%20the%20Fist',
);

// Accent survives as utf-8 percent-escapes (btoa would have thrown on it).
assert.ok(buildTcgMassEntryUrl(['1 Laur-\u00c9lie, the Telluric']).includes('%C3%89lie'));
