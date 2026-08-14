// The scan-index panel joins two providers' set lists, and gets its coverage
// numbers from the result. Both halves fail quietly rather than loudly:
//
//   · a missed join shows a bare set code with no year and no card count, which
//     reads as a broken catalogue (91 of 218 English Pokémon sets did exactly
//     this, including every Scarlet & Violet release);
//   · a WRONG join is worse — one set's release date and card count rendered
//     under another set's name, with nothing to indicate it happened.
//
// So the fuzzier tiers are pinned down here, in both directions: what they must
// recover, and what they must refuse to guess at.
// No framework — plain node + assert. Run: `node test/setcatalogue.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-catalogue-${process.pid}.db`);
const { matcher, normId, unpadId, normName } = require('../src/utils/setCatalogueMatch');
const {
  _absentReasonForTest: absentReason,
  _coverageBreakdownForTest: coverageBreakdown,
} = require('../src/globalIndex');

// A cut-down stand-in for the `sets` table, which pokemontcg.io fills.
const PTCG = [
  { id: 'sv1', name: 'Scarlet & Violet', release_date: '2023-03-31' },
  { id: 'sv3pt5', name: '151', release_date: '2023-09-22' },
  { id: 'swsh9tg', name: 'Brilliant Stars Trainer Gallery', release_date: '2022-02-25' },
  { id: 'cel25c', name: 'Celebrations Classic Collection', release_date: '2021-10-08' },
  { id: 'mcd11', name: "McDonald's Collection 2011", release_date: '2011-06-01' },
  { id: 'base1', name: 'Base', release_date: '1999-01-09' },
];

function testKeys() {
  assert.strictEqual(normId('mtg-ecl'), 'ecl', 'the mtg- prefix is stripped');
  assert.strictEqual(normId('sv03.5'), 'sv035', 'punctuation goes');
  assert.strictEqual(normId('SWSH9.5TG'), 'swsh95tg', 'and case');

  // Only zeros between a letter and a digit. This is the whole reason unpadId is
  // not a plain /0+/ strip: "2011bw" would become "211bw" and could then collide
  // with a real set, inventing a join out of nothing.
  assert.strictEqual(unpadId('sv01'), 'sv1');
  assert.strictEqual(unpadId('me01'), 'me1');
  assert.strictEqual(unpadId('sv001'), 'sv1');
  assert.strictEqual(unpadId('2011bw'), '2011bw', 'a leading digit run is NOT unpadded');
  assert.strictEqual(unpadId('2024sv'), '2024sv');

  assert.strictEqual(normName('Scarlet & Violet'), 'scarletviolet');
  for (const junk of [null, undefined, '', 0, {}]) {
    assert.strictEqual(typeof normId(junk), 'string', `normId survives ${JSON.stringify(junk)}`);
    assert.strictEqual(typeof unpadId(junk), 'string', `unpadId survives ${JSON.stringify(junk)}`);
  }
}

function testMatcher() {
  const match = matcher(PTCG);

  // Tier 1: exact.
  assert.strictEqual(match('base1').id, 'base1');
  assert.strictEqual(match('sv1').id, 'sv1');

  // Tier 2: TCGdex zero-pads where pokemontcg.io does not. This tier alone
  // recovered 14 sets, the modern Scarlet & Violet block among them.
  assert.strictEqual(match('sv01').id, 'sv1', 'sv01 must reach sv1');

  // Tier 3: ids that diverge past repair, rescued by name. 32 sets came back
  // this way — the ".5" releases and the Trainer Galleries.
  assert.strictEqual(match('sv03.5', '151').id, 'sv3pt5', 'name rescues sv03.5 -> sv3pt5');
  assert.strictEqual(match('swsh9.5tg', 'Brilliant Stars Trainer Gallery').id, 'swsh9tg');
  assert.strictEqual(match('cel25cc', 'Celebrations Classic Collection').id, 'cel25c');

  // A name is optional, and no name means no tier 3 — never a stray match.
  assert.strictEqual(match('swsh9.5tg'), null, 'without a name there is nothing to fall back on');

  // Genuinely absent stays absent rather than landing on something close.
  assert.strictEqual(match('tk-xy-p', 'XY trainer Kit (Pikachu Libre)'), null);
  assert.strictEqual(match('2011bw'), null, 'unpadding must not invent a match for 2011bw');
  assert.strictEqual(match('2011bw', "McDonald's Collection 2011").id, 'mcd11', 'but its NAME still matches');

  // Ambiguity is refused, not guessed. Two rows claiming one key poison it.
  const ambiguous = matcher([
    { id: 'x1', name: 'Shared Name' },
    { id: 'x2', name: 'Shared Name' },
  ]);
  assert.strictEqual(ambiguous('x1').id, 'x1', 'unambiguous ids still resolve');
  assert.strictEqual(ambiguous('zz', 'Shared Name'), null, 'a contested name resolves to nothing');

  // Junk in, null out — this runs over every row of a ~460 set catalogue.
  const empty = matcher([]);
  assert.strictEqual(empty('anything'), null);
  assert.strictEqual(matcher(null)('anything'), null, 'a missing catalogue is not a crash');
}

function testAbsentReason() {
  // The real messages setIndex raises, each to its own bucket. "no card images"
  // is checked first on purpose: that message also states a card COUNT, so a
  // naive card-lessness test would misfile it as "no card records".
  assert.strictEqual(
    absentReason('TCGdex has 95 Korean cards for "SV4M" (sv4m) but no card images, and scanning matches on the art.'),
    'no card images',
  );
  assert.strictEqual(
    absentReason('TCGdex lists "Jumbo cards" (jumbo) in English but has no cards for it yet, so there is nothing to index.'),
    'no card records',
  );
  assert.strictEqual(absentReason('no cards for set sv2a'), 'no card records');
  assert.strictEqual(absentReason('set w15 lists no cards'), 'no card records');
  assert.strictEqual(
    absentReason('TCGdex has no Japanese set "sv2a". Set codes differ by language.'),
    'not published in this language',
  );
  assert.strictEqual(absentReason('Request failed with status code 404'), 'not published in this language');
  assert.strictEqual(absentReason('something nobody has seen before'), 'unavailable');
  for (const junk of [null, undefined, '', 0]) {
    assert.strictEqual(typeof absentReason(junk), 'string', `absentReason survives ${JSON.stringify(junk)}`);
  }
}

function testCoverageBreakdown() {
  const rows = [
    { set: 'sv1', series: 'Scarlet & Violet', digital: false, indexed: true, cards: 250, claimed: 258 },
    { set: 'sv2', series: 'Scarlet & Violet', digital: false, indexed: true, cards: 190, claimed: 193 },
    { set: 'A1', series: 'Pokémon TCG Pocket', digital: true, indexed: true, cards: 286, claimed: 286 },
    { set: 'jumbo', series: 'Other', digital: false, indexed: false, cards: 0, claimed: 160 },
    { set: 'sp', series: 'Other', digital: false, indexed: false, cards: 0, claimed: 10 },
  ];
  const scope = {
    absentSets: [
      { set: 'jumbo', reason: 'no card records' },
      { set: 'sp', reason: 'no card records' },
    ],
  };

  const b = coverageBreakdown(rows, scope);

  // Sets the provider cannot supply leave the denominator entirely: they are not
  // work left undone, and counting them as such is what kept a finished build
  // showing a partial-coverage warning forever.
  assert.strictEqual(b.buildableSets, 3, 'two absent sets drop out of buildable');
  assert.strictEqual(b.builtSets, 3, 'and everything buildable is built');
  assert.strictEqual(b.unavailableSets, 2);
  assert.strictEqual(b.cards.unavailable, 170, 'their claimed cards are reported separately');

  assert.strictEqual(b.cards.indexed, 726, '250 + 190 + 286');
  assert.strictEqual(b.cards.claimed, 907, 'every listed set, buildable or not');
  assert.strictEqual(b.cards.claimedBuilt, 737, 'only the sets that built');
  assert.strictEqual(b.cards.missingArt, 11, '737 claimed - 726 indexed, art the provider lacks');

  // Grouped by series, digital flagged, biggest first.
  const sv = b.series.find(s => s.series === 'Scarlet & Violet');
  assert.strictEqual(sv.sets, 2);
  assert.strictEqual(sv.cards, 440);
  assert.strictEqual(sv.digital, false);
  assert.strictEqual(b.series.find(s => s.series === 'Pokémon TCG Pocket').digital, true);

  assert.deepStrictEqual(b.unavailableReasons, [{ reason: 'no card records', count: 2 }]);
  assert.strictEqual(b.unavailable.length, 2);
  assert.strictEqual(b.unavailable[0].reason, 'no card records');

  // Before any build has recorded a scope, nothing is known to be unavailable —
  // so the panel must degrade to the old set-based numbers rather than claiming
  // full coverage of a catalogue it has not walked.
  const noScope = coverageBreakdown(rows, null);
  assert.strictEqual(noScope.buildableSets, 5, 'with no scope, every set still counts as buildable');
  assert.strictEqual(noScope.unavailableSets, 0);
  assert.strictEqual(noScope.cards.missingArt, 11, 'built-set art gap does not depend on scope');
}

function main() {
  testKeys();
  testMatcher();
  testAbsentReason();
  testCoverageBreakdown();
  console.log('setcatalogue.test.js: all assertions passed');
}

try { main(); process.exit(0); }
catch (err) { console.error(err); process.exit(1); }
