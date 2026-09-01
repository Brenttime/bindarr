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

  assert.match(collectionSource,
    /translateAnchorViewportOffset\(\s*sourceViewportOffset,\s*virtualWindow\.rowStride,\s*nextGeometry\.rowStride,?\s*\)/,
    'the view-switch path must use the clipped-row translation helper');
});
