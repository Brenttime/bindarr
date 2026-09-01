import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const collectionSource = readFileSync(
  new URL('../components/CollectionList.jsx', import.meta.url),
  'utf8',
);

function loadStandaloneHelper(name) {
  const start = collectionSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain a named standalone helper`);
  const end = collectionSource.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1, `${name} must be followed by another named helper`);
  return Function(`"use strict"; ${collectionSource.slice(start, end)}; return ${name};`)();
}

test('collection rendering uses a viewport-bounded range instead of append-only slicing', () => {
  assert.match(collectionSource, /function computeVirtualRange\s*\(/,
    'the collection must calculate a start and end row from the viewport');
  assert.match(collectionSource, /data-collection-virtual-spacer/,
    'the collection must retain full scroll height while only mounting a window');
  assert.match(collectionSource, /ResizeObserver/,
    'responsive grid geometry must be recalculated when its container resizes');
  assert.doesNotMatch(collectionSource, /visibleCount|LOAD_MORE_RENDER_COUNT|sentinelRef/,
    'append-only visible-count batching is not true virtualization');
});

test('view anchors preserve clipped-row progress when row heights change', () => {
  const translateAnchorViewportOffset = loadStandaloneHelper('translateAnchorViewportOffset');

  assert.equal(translateAnchorViewportOffset(24, 360, 82), 24,
    'an anchor below the viewport top should keep its exact pixel offset');
  assert.equal(translateAnchorViewportOffset(0, 360, 82), 0,
    'a row aligned to the viewport top should remain aligned');

  const galleryOffset = -315;
  const listOffset = translateAnchorViewportOffset(galleryOffset, 360, 82);
  assert.ok(listOffset > -82 && listOffset < 0,
    'a clipped gallery row must remain partially visible in the shorter list layout');
  assert.ok(Math.abs((listOffset / 82) - (galleryOffset / 360)) < 1e-12,
    'the destination layout should preserve the fraction of the row that was clipped');
  assert.ok(Math.abs(translateAnchorViewportOffset(listOffset, 82, 360) - galleryOffset) < 1e-12,
    'switching back should restore the original clipped-row offset');

  const barelyVisible = translateAnchorViewportOffset(-81.9, 82, 343.34375, 900, 1);
  assert.ok(barelyVisible + 343.34375 >= 1,
    'clipped progress must retain at least one device pixel of destination intersection');

  assert.match(collectionSource,
    /translateAnchorViewportOffset\(\s*anchor\.sourceViewportOffset,\s*anchor\.sourceEntryHeight,\s*destinationRect\.height,/,
    'final restoration must translate clipping with measured source and destination heights');
});

test('view switches select an actually intersecting source entry', () => {
  const findVisibleCollectionAnchor = loadStandaloneHelper('findVisibleCollectionAnchor');
  const element = (entryId, top, height) => ({
    dataset: { collectionEntryId: entryId },
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  });
  const root = {
    querySelectorAll: () => [
      element('calculated-but-clipped', -343.75, 343),
      element('measured-visible', -0.75, 343),
      element('later-in-row', -0.75, 343),
    ],
  };

  assert.deepEqual(findVisibleCollectionAnchor(root, 900), {
    entryId: 'measured-visible',
    viewportOffset: -0.75,
    entryHeight: 343,
  }, 'row-stride mismatch must advance past a theoretically visible entry that is actually clipped out');

  assert.match(collectionSource, /data-collection-entry-id=\{item\.entry_id\}/,
    'both destination layouts need a stable entry marker for measured restoration');
  assert.match(collectionSource, /const measuredAnchor = findVisibleCollectionAnchor\(root, window\.innerHeight\)/,
    'the switch path must capture source identity from rendered geometry');
});

test('measured correction removes calculated row-stride miss after spacer commit', () => {
  const translateAnchorViewportOffset = loadStandaloneHelper('translateAnchorViewportOffset');
  const measuredAnchorScrollTarget = loadStandaloneHelper('measuredAnchorScrollTarget');
  const sourceTop = -67.140625;
  const sourceHeight = 82;
  const destinationHeight = 343.34375;
  const calculatedDestinationTop = -344.09375;
  const desiredTop = translateAnchorViewportOffset(
    sourceTop,
    sourceHeight,
    destinationHeight,
    900,
    1,
  );
  const currentScrollTop = 303356;
  const targetScrollTop = measuredAnchorScrollTarget(
    currentScrollTop,
    calculatedDestinationTop,
    desiredTop,
    605185,
  );
  const correctedTop = calculatedDestinationTop - (targetScrollTop - currentScrollTop);

  assert.ok(calculatedDestinationTop + destinationHeight < 0,
    'fixture must reproduce the sub-pixel calculated-geometry miss');
  assert.ok(Math.abs(correctedTop - desiredTop) < 1e-9,
    'measured rect delta must place the destination at the translated source progress');
  assert.ok(correctedTop + destinationHeight >= 1,
    'measured correction must leave positive device-pixel intersection');
  assert.match(collectionSource,
    /measuredAnchorScrollTarget\(\s*window\.scrollY,\s*destinationRect\.top,\s*desiredViewportOffset,/,
    'production restoration must correct from the destination DOM rect');
});

test('near-end restoration waits for corrected destination spacer geometry to commit', () => {
  const virtualWindowsMatch = loadStandaloneHelper('virtualWindowsMatch');
  const viewportHeight = 667;
  const rootTop = 240;
  const provisionalWindow = {
    startIndex: 9948,
    endIndex: 9980,
    startRow: 4974,
    endRow: 4990,
    rowCount: 5000,
    columns: 2,
    rowStride: 291.618,
    gap: 12,
    totalSize: 1458078,
  };
  const destinationWindow = {
    ...provisionalWindow,
    startIndex: 9968,
    endIndex: 10000,
    startRow: 4984,
    endRow: 5000,
    rowStride: 297.095,
    totalSize: 1485463,
  };
  const targetScrollTop = rootTop + 4994 * destinationWindow.rowStride + 120;
  const clampToCommittedSpacer = (requested, committed) => Math.min(
    requested,
    rootTop + committed.totalSize - viewportHeight,
  );

  // This is the failed one-effect sequence: React has only queued the taller
  // spacer, so the browser clamps the requested scroll against old geometry.
  const prematurelySettled = clampToCommittedSpacer(targetScrollTop, provisionalWindow);
  assert.ok(prematurelySettled < targetScrollTop - 20_000,
    'the mobile width mismatch must reproduce a material near-end clamp');

  let committedWindow = provisionalWindow;
  let settledScrollTop = prematurelySettled;
  const restoreAfterCommit = () => {
    if (!virtualWindowsMatch(committedWindow, destinationWindow)) {
      committedWindow = destinationWindow;
      return false;
    }
    settledScrollTop = clampToCommittedSpacer(targetScrollTop, committedWindow);
    return Math.abs(settledScrollTop - targetScrollTop) < 1;
  };

  assert.equal(restoreAfterCommit(), false,
    'phase one must commit corrected spacer geometry without scrolling');
  assert.equal(settledScrollTop, prematurelySettled,
    'phase one must not issue another scroll against stale DOM geometry');
  assert.equal(restoreAfterCommit(), true,
    'phase two may restore only after the destination spacer is committed');
  assert.equal(settledScrollTop, targetScrollTop,
    'the committed destination extent must make the requested anchor reachable');

  assert.match(collectionSource,
    /if \(!virtualWindowsMatch\(virtualWindow, destinationWindow\)\) \{\s*setVirtualWindow\(destinationWindow\);\s*return;/,
    'the production effect must return after queueing destination geometry');
  assert.match(collectionSource,
    /window\.scrollTo\([\s\S]*?hasPositiveIntersection[\s\S]*?Math\.abs\(window\.scrollY - targetScrollTop\) <= tolerance[\s\S]*?pendingViewAnchorRef\.current = null;/,
    'the pending anchor must survive until measured correction positively intersects and settles');
});
