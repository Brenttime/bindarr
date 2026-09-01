import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const collectionSource = readFileSync(
  new URL('../components/CollectionList.jsx', import.meta.url),
  'utf8',
);

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
