// Runnable smoke test for the card-sort logic in utils/cardSort.js.
// No framework — plain node + assert. Run: `npm test` (from backend/) or
// `node test/sort.test.js`.
const assert = require('assert');

const { sortCards, getSortCategory, rarityRank } = require('../src/utils/cardSort');
const cardOrder = require('../../shared/cardOrder.json');

// Pure test (no DB): the 'language' filing scheme orders by language rank
// (English, Japanese, ...) then by name, and buckets cards by language.
function testLanguageScheme() {
  const cards = [
    { name: 'Zebra', language: 'Japanese' },
    { name: 'Alpha', language: 'English' },
    { name: 'Beta', language: 'Japanese' },
    { name: 'Gamma', language: 'German' },
  ];
  const sorted = sortCards(cards, 'language', 'normals_first');
  assert.deepStrictEqual(sorted.map(c => c.name), ['Alpha', 'Beta', 'Zebra', 'Gamma'],
    'language scheme must order English, then Japanese-by-name, then German');
  assert.strictEqual(getSortCategory({ language: 'Japanese' }, 'language'), 'Japanese');
  assert.strictEqual(getSortCategory({}, 'language'), 'English', 'missing language defaults to English');
  console.log('PASS: language filing scheme orders by language then name');
}

// Pure test (no DB): favorite as primary sort key floats starred cards to the
// front while the secondary key (name) still sub-orders within each group.
function testFavoriteScheme() {
  const cards = [
    { name: 'Bravo', favorite: 0 },
    { name: 'Alpha', favorite: 1 },
    { name: 'Delta', favorite: 0 },
    { name: 'Charlie', favorite: 1 },
  ];
  const sorted = sortCards(cards, [{ by: 'favorite', dir: 'desc' }, { by: 'name', dir: 'asc' }], 'normals_first');
  assert.deepStrictEqual(sorted.map(c => c.name), ['Alpha', 'Charlie', 'Bravo', 'Delta'],
    'favorites must sort to the front, sub-ordered by name');
  console.log('PASS: favorite sort key floats starred cards to the front');
}

// Pure test (no DB): the default name scheme is stable and alphabetical.
function testNameScheme() {
  const cards = [
    { name: 'Bolt', printing: 'Normal' },
    { name: 'Zap', printing: 'Normal' },
    { name: 'Aard', printing: 'Normal' },
  ];
  const sorted = sortCards(cards, 'name-asc', 'normals_first');
  assert.deepStrictEqual(sorted.map(c => c.name), ['Aard', 'Bolt', 'Zap'],
    'name-asc must order alphabetically');
  console.log('PASS: name-asc scheme orders alphabetically');
}

// Pure test (no DB): foil-variant schemes put foil printings before normals
// in 'foils_first' and after in 'normals_first'. 'set-number-printing' is the
// only scheme carrying a printing criterion, so same-set cards split on it.
function testFoilOrdering() {
  const base = [
    { name: 'Alpha', printing: 'Holofoil', set_name: 'Set One' },
    { name: 'Beta', printing: 'Normal', set_name: 'Set One' },
  ];
  const foilsFirst = sortCards([...base], 'set-number-printing', 'foils_first');
  assert.deepStrictEqual(foilsFirst.map(c => c.name), ['Alpha', 'Beta'],
    'foils_first must put the foil printing ahead of its normal twin');
  const normalsFirst = sortCards([...base], 'set-number-printing', 'normals_first');
  assert.deepStrictEqual(normalsFirst.map(c => c.name), ['Beta', 'Alpha'],
    'normals_first must put the normal printing ahead of its foil twin');
  console.log('PASS: foil ordering honours the foil_sorting option');
}

function testMtgOnlyCategories() {
  assert.deepStrictEqual(Object.keys(cardOrder.printingNormalsFirst), ['Normal', 'Holofoil']);
  assert.deepStrictEqual(Object.keys(cardOrder.printingFoilsFirst), ['Holofoil', 'Normal']);
  assert.deepStrictEqual(
    ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'].map(rarityRank),
    [1, 2, 3, 4, 5, 6],
    'rarity sorting must use the complete Scryfall vocabulary'
  );
  for (const unsupported of ['rare holo', 'ultra rare', 'promo', 'illustration rare', 'secret rare']) {
    assert.strictEqual(rarityRank(unsupported), 0, `${unsupported} is not a Scryfall rarity`);
  }
  console.log('PASS: printing and rarity categories are MTG-only');
}

main();

async function main() {
  testLanguageScheme();
  testFavoriteScheme();
  testNameScheme();
  testFoilOrdering();
  testMtgOnlyCategories();
  console.log('sort tests: OK');
}
