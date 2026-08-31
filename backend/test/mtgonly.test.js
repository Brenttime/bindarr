// Static boundary test: compatibility code may recognize legacy exports and
// schemas, but active runtime/UI/shared configuration must remain MTG-only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function scan(files, patterns) {
  const failures = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(text)) failures.push(`${path.relative(ROOT, file)} matches ${pattern}`);
    }
  }
  return failures;
}

const sourceExtensions = new Set(['.js', '.jsx', '.css', '.json', '.md']);
const activeFrontend = walk(path.join(ROOT, 'frontend/src'))
  .filter(file => sourceExtensions.has(path.extname(file)) && !file.endsWith('.test.js'));
const shared = walk(path.join(ROOT, 'shared')).filter(file => sourceExtensions.has(path.extname(file)));
const activeBackend = walk(path.join(ROOT, 'backend/src'))
  .filter(file => sourceExtensions.has(path.extname(file)))
  // These modules deliberately recognize old storage/imports/files so they can
  // remove or reject them. No other runtime module gets that exception.
  .filter(file => !['db.js', 'cardArt.js', path.join('routes', 'importExport.js')]
    .some(suffix => file.endsWith(suffix)));
const currentDocs = [path.join(ROOT, 'PROJECT.md')]
  .concat(walk(path.join(ROOT, 'docs')).filter(file => path.extname(file) === '.md'));

const retiredBrandOrProvider = /pok[eé]mon|pikachu|charizard|pidgeot|tcgdex|pokemontcg|pokemonprovider|tcgcsv/i;
const retiredUiOrDataShape = /reverse holo|1st edition|classic collection|special illustration|double rare|rare holo|holo rare|ultra rare|secret rare|shiny rare|radiant rare|amazing rare|--type-grass/i;
const providerSpecificSetColumn = /ptcgo_code/i;

const failures = [
  ...scan(activeFrontend, [retiredBrandOrProvider, retiredUiOrDataShape, providerSpecificSetColumn]),
  ...scan(shared, [retiredBrandOrProvider, retiredUiOrDataShape, providerSpecificSetColumn]),
  ...scan(activeBackend, [retiredBrandOrProvider, retiredUiOrDataShape, providerSpecificSetColumn]),
  ...scan(currentDocs, [retiredBrandOrProvider, retiredUiOrDataShape, providerSpecificSetColumn]),
];
// The README's "About this fork" section intentionally names retired upstream
// products to document that they are unsupported. Verify that wording as policy,
// then exclude only that bounded section from the active-feature residue scan.
const readmeRaw = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const forkPolicy = readmeRaw.match(/## About this fork\n([\s\S]*?)\n---\n/);
assert.ok(forkPolicy, 'README must document how this fork differs from upstream');
assert.match(forkPolicy[1], /supports \*\*Magic: The Gathering only\*\*/);
assert.match(forkPolicy[1], /no Pok[eé]mon, Lorcana, game picker/i);
const readme = readmeRaw
  .replace(forkPolicy[0], '')
  .replaceAll('pokemon_cards', 'legacy_database');
for (const pattern of [retiredBrandOrProvider, retiredUiOrDataShape, providerSpecificSetColumn]) {
  if (pattern.test(readme)) failures.push(`README.md matches ${pattern}`);
}
assert.deepStrictEqual(failures, [], `retired material remains active:\n${failures.join('\n')}`);

const cardOrder = require('../../shared/cardOrder.json');
assert.deepStrictEqual(Object.keys(cardOrder.printingNormalsFirst), ['Normal', 'Holofoil']);
assert.deepStrictEqual(Object.keys(cardOrder.printingFoilsFirst), ['Holofoil', 'Normal']);

for (const deleted of [
  'docs/images/dashboard.png',
  'docs/images/collection.png',
  'docs/images/storage.png',
  'docs/images/storage_box.png',
]) {
  assert.ok(!fs.existsSync(path.join(ROOT, deleted)), `${deleted} contains retired screenshots`);
}

for (const script of ['build-cv-catalog.mjs', 'measure-scan-floor.js']) {
  const text = fs.readFileSync(path.join(ROOT, 'backend', 'scripts', script), 'utf8');
  assert.ok(!text.includes('--game'), `${script} must not expose an arbitrary game flag`);
  assert.match(text, /const game = 'mtg'/, `${script} must be hardcoded to MTG`);
}

console.log('PASS: active source, shared config, and current docs are MTG-only');
