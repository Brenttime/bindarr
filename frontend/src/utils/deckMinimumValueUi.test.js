import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const deckBuilder = readFileSync(join(srcDir, 'components', 'DeckBuilder.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(srcDir, 'locales', 'en.json'), 'utf8'));

assert.ok((deckBuilder.match(/deckMinimumValueText\(deck\)/g) || []).length >= 2,
  'deck minimum value must appear in both grid and table summaries');
assert.match(deckBuilder, /deckMinimumValueText\(activeDeck\)/,
  'deck minimum value must appear in deck detail');
assert.match(deckBuilder, /deckMinimumValueHint\(/,
  'minimum-value display must explain incomplete pricing');
assert.ok((deckBuilder.match(/tabIndex=\{0\}/g) || []).length >= 3,
  'minimum-value explanations must be keyboard focusable in grid, table, and detail views');
assert.ok((deckBuilder.match(/deckUnpricedCountText\(/g) || []).length >= 3,
  'unpriced-card counts must be visibly rendered in grid, table, and detail views');
assert.match(en['deck.minimumValueComplete'], /cheapest known USD printing or finish/i);
assert.match(en['deck.minimumValueIncompleteOne'], /1 card does not/i);
assert.match(en['deck.minimumValueIncomplete'], /\{count\}/);
assert.match(en['deck.minimumValueIncomplete'], /printings or finishes/i);
assert.match(en['deck.unpricedCount'], /\{count\}/);

console.log('PASS: deckMinimumValueUi.test.js');
