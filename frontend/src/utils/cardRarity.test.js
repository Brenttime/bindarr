import assert from 'node:assert';
import {
  getRarityRank,
  getRarityTier,
  getRarityBadgeLabel,
  isPremiumRarity,
} from './cardRarity.js';

const scryfallRarities = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'];
assert.deepStrictEqual(
  scryfallRarities.map(getRarityRank),
  [1, 2, 3, 4, 5, 6],
  'all and only Scryfall rarities have the canonical sort order'
);
assert.deepStrictEqual(
  scryfallRarities.map(getRarityTier),
  ['common', 'uncommon', 'rare', 'top', 'top', 'top']
);
assert.deepStrictEqual(
  scryfallRarities.map(getRarityBadgeLabel),
  ['COM', 'UNC', 'RARE', 'MYTHIC', 'SPECIAL', 'BONUS']
);
assert.deepStrictEqual(
  scryfallRarities.filter(isPremiumRarity),
  ['mythic', 'special', 'bonus']
);

// Exact matching is deliberate: provider-era composite labels must never be
// interpreted as current MTG rarity values.
for (const unsupported of ['rare holo', 'ultra rare', 'promo', 'illustration rare', 'secret rare']) {
  assert.strictEqual(getRarityRank(unsupported), 0, `${unsupported} is not a Scryfall rarity`);
}
assert.strictEqual(getRarityRank(' MYTHIC '), 4, 'normalization trims and lowercases');
assert.strictEqual(getRarityBadgeLabel(''), '—');

console.log('PASS: cardRarity.test.js');
