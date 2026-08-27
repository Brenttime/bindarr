import assert from 'node:assert';
// The collection screen's Scryfall-syntax filter (CollectionList.jsx) and the
// shared evaluator (shared/scryfallQuery.js) must stay in step: the import is
// the drift detector, and a few behaviors are pinned here so the frontend test
// run fails if the shared module's contract changes.
import { QuerySyntaxError, compileQuery, matches, classifyQuery } from '../../../shared/scryfallQuery.js';

const rows = [
  { name: 'Foret', supertype: 'land', subtypes: ['Basic', 'Land'], types: [], rarity: 'basic', set_id: 'lea', number: '35', cmc: null, color_identity: [], language: 'English' },
  { name: 'Lightning Bolt', supertype: '', subtypes: ['Instant'], types: ['Red'], rarity: 'common', set_id: 'lea', number: '56', cmc: 1, color_identity: ['Red'], language: 'Japanese', printed_name: '稲妻' },
];

// The query the placeholder suggests must run and match what it reads as.
assert.ok(matches(rows[0], 'is:land color:g set:lea rarity:rare') === false);
assert.ok(matches(rows[0], 'is:land set:lea'), 'placeholder example shape parses');
assert.ok(matches(rows[1], 'lang:ja'), 'language operator resolves by code');
assert.ok(matches(rows[1], '稲妻'), 'bare word hits the printed name');

// Invalid syntax is a named error the UI can show, never a silent no-op.
assert.throws(() => compileQuery('bogus:1'), (e) => e instanceof QuerySyntaxError);

// The collection screen routes queries by this split: data-backed operators
// filter the loaded rows locally; catalog-only operators (otag:, availability:,
// ...) go live to the server, which resolves them on Scryfall and intersects
// with what the user owns. A genuine parse error must NOT read as "catalog" —
// that would route a typo to the API.
assert.strictEqual(classifyQuery('is:land color:g').mode, 'local');
assert.strictEqual(classifyQuery('otag:sneak').mode, 'catalog');
assert.strictEqual(classifyQuery('is:land otag:sneak').mode, 'catalog');
assert.strictEqual(classifyQuery('-(otag:tutor) r:c').mode, 'catalog');
assert.throws(() => classifyQuery('(r:c'), (e) => e instanceof QuerySyntaxError);
assert.throws(() => classifyQuery('name:'), (e) => e instanceof QuerySyntaxError);

console.log('scryfallQuery.test.js: all assertions passed');
