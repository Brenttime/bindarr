// Per-language coverage is patchy by nature: a language may only have printings
// for a fraction of a game's sets, and TCGdex lists sets whose images do not exist
// yet. A global build therefore has to tell "this set does not exist in this
// language" (expected — skip it) apart from "something went wrong" (a real
// failure that should stop the build).
//
// Getting this wrong is not subtle: classify absences as failures and EVERY
// non-English build trips the failure floor and refuses to finish; classify
// network errors as absences and a build silently produces a near-empty index
// while the provider is down.
// No framework — plain node + assert. Run: `node test/absentsets.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-absent-${process.pid}.db`);
const { _isAbsentForTest: isAbsent, _isAbsentFailureForTest: isAbsentFailure } = require('../src/globalIndex');
const setIndex = require('../src/setIndex');

function main() {
  assert.strictEqual(typeof isAbsent, 'function', 'globalIndex must expose the classifier for testing');
  assert.strictEqual(typeof isAbsentFailure, 'function', 'and the combined one the walk actually calls');

  // --- Expected absences: the set has no data in this language ---
  const absent = [
    'no cards for set sv2a',                                       // setIndex.buildSet
    'TCGdex has 116 Japanese cards for "インフェルノX" (M2) but no card images, and scanning matches on the art.',
    'TCGdex has no Japanese set "sv2a". Set codes differ by language — pick from the Japanese set list.',
    'TCGdex lists "Test Set" (ts1) in Japanese but has no cards for it yet, so there is nothing to index. Try another set or language.',
    'set w15 lists no cards',                                      // preflight probe
    'Request failed with status code 404',                         // Scryfall: no such printing
    'No Korean cards found for pokemon set "sv8a"',                // previewSet
  ];
  for (const m of absent) {
    assert.strictEqual(isAbsent(m), true, `should be treated as absent: ${m}`);
  }

  // --- Real failures: MUST NOT be swallowed as absences, or a build finishes
  //     with a near-empty index while the provider is broken. ---
  const failures = [
    'Request failed with status code 500',      // the exact error from the reported bug
    'Request failed with status code 502',
    'Request failed with status code 503',
    'Request failed with status code 429',      // rate limited
    'getaddrinfo ENOTFOUND api.scryfall.com',   // DNS
    'connect ECONNREFUSED 127.0.0.1:443',
    'socket hang up',
    'timeout of 30000ms exceeded',
    'Invalid URL',                              // issue #29's original symptom
    'SQLITE_ERROR: no such table: card_cache',
  ];
  for (const m of failures) {
    assert.strictEqual(isAbsent(m), false, `must NOT be treated as absent: ${m}`);
  }

  // --- Robustness: never throw on junk input, because this runs inside the
  //     per-set catch and throwing there would abort the whole walk. ---
  for (const m of [null, undefined, '', 0, {}, []]) {
    assert.strictEqual(typeof isAbsent(m), 'boolean', `must return a boolean for ${JSON.stringify(m)}`);
  }

  // Case-insensitive: provider messages are not consistently cased.
  assert.strictEqual(isAbsent('NO CARDS FOR SET xyz'), true);
  assert.strictEqual(isAbsent('Request Failed With Status Code 404'), true);

  // A 404 inside a longer sentence still counts, since callers wrap messages.
  assert.strictEqual(isAbsent('set list unavailable: Request failed with status code 404'), true);
  // But a 500 wrapped the same way does not.
  assert.strictEqual(isAbsent('set list unavailable: Request failed with status code 500'), false);

  // --- The typed signal: an error that says outright it is an absence --------
  // Phrase matching binds a build-stopping decision to the wording of a sentence
  // written for a human. The fetchers that KNOW they are reporting a gap now say
  // so on the error, so rewording one of those messages — or adding a fourth
  // kind of gap — cannot quietly start failing builds.
  assert.strictEqual(
    isAbsentFailure('TCGdex introduced some entirely new wording for this in 2027', true), true,
    'a flagged error is an absence whatever it says',
  );

  // The flag only ever ADDS absences. An unflagged error still gets the phrase
  // check, so nothing that used to be tolerated becomes a build-stopping failure.
  assert.strictEqual(isAbsentFailure('no cards for set sv2a', null), true, 'unflagged still falls back to the phrases');
  assert.strictEqual(isAbsentFailure('Request failed with status code 404', false), true,
    'an axios 404 carries no flag of its own and must still read as absent');

  // And a real failure stays a real failure however it arrives.
  assert.strictEqual(isAbsentFailure('Request failed with status code 500', null), false);
  assert.strictEqual(isAbsentFailure('Request failed with status code 500', false), false);
  assert.strictEqual(isAbsentFailure('socket hang up', undefined), false);

  // --- setIndex marks its own absences, and they survive the progress record --
  // ensureSet swallows the throw and returns false, so buildFailure is the only
  // thing the walk has left. If the flag does not make it through there, the
  // typed path above is decorative.
  assert.strictEqual(typeof setIndex.buildFailure, 'function', 'setIndex exposes the failure with its flag');
  assert.strictEqual(setIndex.buildFailure('mtg', 'neverbuilt', 'en'), null, 'no failure recorded for an untouched set');

  console.log('absentsets.test.js: all assertions passed');
}

try { main(); process.exit(0); }
catch (err) { console.error(err); process.exit(1); }
