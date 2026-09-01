import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const deckBuilder = readFileSync(join(srcDir, 'components', 'DeckBuilder.jsx'), 'utf8');

const section = (start, end) => {
  const startIndex = deckBuilder.indexOf(start);
  const endIndex = deckBuilder.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing section marker: ${end}`);
  return deckBuilder.slice(startIndex, endIndex);
};

for (const thumbnailSection of [
  section('{/* Search Results list */}', '{/* Deck Cards Header & Display Mode Toggle */}'),
  section('{/* 1. COMPACT LIST VIEW */}', '{/* 2. VISUAL CARD GRID VIEW */}'),
  section('{/* 2. VISUAL CARD GRID VIEW */}', '{/* Right Column: Statistics, Mana Curve & Deck Health */}'),
]) {
  assert.match(thumbnailSection, /<CardImage[\s\S]*?loading="lazy"[\s\S]*?decoding="async"[\s\S]*?\/>/,
    'search, list, and grid thumbnails must defer loading and decode work');
}

const previewSection = section('{/* E. High-Res Card Art Preview Popover */}', '{/* Checkout Coverage Modal */}');
assert.doesNotMatch(previewSection, /loading="lazy"|decoding="async"/,
  'an explicitly opened high-resolution preview must remain eager');

assert.match(deckBuilder, /import \{[^}]*\buseMemo\b[^}]*\} from 'react';/,
  'deck-wide derived data must use React useMemo');
assert.match(deckBuilder, /const deckDerived = useMemo\(\(\) => deriveDeckRenderData\(deckCards\), \[deckCards\]\);/,
  'deck derivations must be memoized only by the stable deck-card array');

const deriveStart = deckBuilder.indexOf('function deriveDeckRenderData(deckCards)');
const componentStart = deckBuilder.indexOf('function DeckBuilder', deriveStart);
assert.notEqual(deriveStart, -1, 'missing consolidated deck derivation helper');
assert.notEqual(componentStart, -1, 'deck derivation helper must live outside the component');
const deriveBody = deckBuilder.slice(deriveStart, componentStart);
assert.equal((deriveBody.match(/for \(const card of deckCards\)/g) || []).length, 1,
  'all deck summaries and groups must be collected in one card pass');
assert.doesNotMatch(deriveBody, /deckCards\.(?:filter|reduce|forEach|map)\(/,
  'deck derivation helper must not add hidden deck-wide array passes');

const deckCardsSection = section('{/* Deck Cards Header & Display Mode Toggle */}', '{/* Right Column: Statistics, Mana Curve & Deck Health */}');
assert.doesNotMatch(deckCardsSection, /activeDeck\.cards\.filter\(/,
  'GROUP_ORDER rendering must consume pre-bucketed groups instead of filtering once per group');

console.log('PASS: deckRenderPerformance.test.js');
