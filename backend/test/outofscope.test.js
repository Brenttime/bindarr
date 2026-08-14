// A partial recall table — one built from a filtered set selection — cannot say
// "I don't know". CLIP always returns its nearest neighbour, so a card from an
// excluded set comes back as the closest artwork the table happens to hold, and
// ORB then verifies it weakly. Presented plainly that is a CONFIDENT WRONG ANSWER,
// which is worse than a miss: the user files the card under the wrong name and
// never finds out.
//
// So the rule is: disclaim only when the index is genuinely partial AND the match
// is weak. Both halves matter —
//   · disclaiming on a complete index would cry wolf on every genuine miss;
//   · not disclaiming on a strong match would undermine correct answers.
// No framework — plain node + assert. Run: `node test/outofscope.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.INDEX_DATA_DIR = path.join(os.tmpdir(), `bindarr-oos-${process.pid}`);
const scanMatch = require('../src/scanMatch');
const notice = scanMatch._outOfScopeNoticeForTest;
const GATE = scanMatch._outOfScopeInliersForTest;

// A partial index: 312 of 459 sets, built from a year filter.
const PARTIAL = { covered: 312, catalogue: 459, excluded: 147, filter: { yearFrom: 2015 } };
// A complete index covers everything, so it excludes nothing.
const COMPLETE = { covered: 459, catalogue: 459, excluded: 0, filter: null };

function main() {
  assert.strictEqual(typeof notice, 'function');
  assert.ok(Number.isFinite(GATE) && GATE > 0, `gate should be a positive number, got ${GATE}`);

  // 1. Partial index + weak match => disclaim, carrying the numbers the UI needs.
  const weak = notice(PARTIAL, GATE - 1);
  assert.ok(weak, 'a weak match against a partial index must be disclaimed');
  assert.strictEqual(weak.covered, 312);
  assert.strictEqual(weak.catalogue, 459);
  assert.strictEqual(weak.excluded, 147);
  assert.deepStrictEqual(weak.filter, { yearFrom: 2015 });

  // 2. Partial index + STRONG match => no disclaimer. The card was found; saying
  //    "this might be out of range" would undermine a correct answer.
  assert.strictEqual(notice(PARTIAL, GATE), null, 'exactly at the gate counts as confident');
  assert.strictEqual(notice(PARTIAL, GATE + 50), null);

  // 3. Complete index => never disclaim, however weak the match. A miss there is a
  //    real miss, and crying wolf on every one would train users to ignore it.
  assert.strictEqual(notice(COMPLETE, 0), null);
  assert.strictEqual(notice(COMPLETE, GATE - 1), null);

  // 4. No scope recorded (a full build, or an index built before scopes existed)
  //    behaves like a complete index rather than warning on every scan.
  assert.strictEqual(notice(null, 0), null);
  assert.strictEqual(notice(undefined, 0), null);

  // 5. Zero inliers against a partial index is the most important case to catch:
  //    nothing verified at all, so the CLIP top hit is pure nearest-neighbour.
  assert.ok(notice(PARTIAL, 0), 'zero inliers against a partial index must be disclaimed');

  // 6. Defensive: a malformed or partially-written scope must not throw inside the
  //    scan path, and must not disclaim when it cannot show a real exclusion count.
  assert.strictEqual(notice({}, 0), null);
  assert.strictEqual(notice({ excluded: 0 }, 0), null);
  assert.strictEqual(notice({ excluded: -1 }, 0), null, 'a negative count is not evidence of exclusion');
  const sparse = notice({ excluded: 5 }, 0);
  assert.ok(sparse, 'an exclusion count alone is enough to disclaim');
  assert.strictEqual(sparse.covered, 0, 'missing fields default rather than becoming undefined');
  assert.strictEqual(sparse.catalogue, 0);
  assert.strictEqual(sparse.filter, null);

  // 7. The gate matches the client's auto-fill threshold, so the server disclaims
  //    exactly when the client would decline to auto-fill. If these drift, a card
  //    can be auto-filled while the server considers the match unconvincing.
  assert.strictEqual(GATE, 12, 'gate should track the documented client confidence gate of 12 inliers');

  console.log('outofscope.test.js: all assertions passed');
}

try { main(); process.exit(0); }
catch (err) { console.error(err); process.exit(1); }
