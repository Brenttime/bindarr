import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const deckBuilder = readFileSync(join(srcDir, 'components', 'DeckBuilder.jsx'), 'utf8');
const chooser = readFileSync(join(srcDir, 'components', 'AddDeckChoiceModal.jsx'), 'utf8');
const precon = readFileSync(join(srcDir, 'components', 'PreconSearchModal.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(srcDir, 'locales', 'en.json'), 'utf8'));

assert.match(deckBuilder, /setShowAddDeckModal\(true\)/, 'deck vault must open the unified Add Deck flow');
assert.equal((deckBuilder.match(/t\('deck\.addDeck'\)/g) || []).length, 1, 'deck vault should expose one Add Deck action');
assert.doesNotMatch(deckBuilder, /t\('precon\.addPrecon'\)/, 'deck vault must not retain a competing Add Precon button');
assert.match(chooser, /deck\.addCustomTitle/, 'chooser must offer a custom or pasted-list path');
assert.match(chooser, /deck\.addPreconTitle/, 'chooser must offer the one-step precon path');
assert.match(chooser, /deck\.addMoxfieldTitle/, 'chooser must preserve the Moxfield sync path');
assert.match(deckBuilder, /renderSourceBadge\(deck\.source\)/, 'vault rows/cards must render source labels');
assert.match(deckBuilder, /renderSourceBadge\(activeDeck\.source\)/, 'deck detail must retain the source label');
assert.match(precon, /precon\.fastPathBody/, 'precon search must explain that naming and setup are skipped');
assert.match(precon, /precon\.added/, 'successful precon adds must confirm the Precon label');
assert.equal(en['deck.sourcePrecon'], 'Precon');
assert.match(en['precon.fastPathBody'], /no naming or setup screens/i);

console.log('PASS: deckAddFlow.test.js');
