// Runnable smoke test for deck copy rules. No framework — plain node + assert.
// Run: `node test/deckrules.test.js`. Uses a fake db client so it never
// touches a real database.
const assert = require('assert');
const { isBasicLand, validateDeckAddition } = require('../src/utils/deckRules');

function testClassification() {
  assert.strictEqual(isBasicLand({ name: 'Forest', supertype: 'Land', subtypes: '["Basic","Forest"]' }), true);
  assert.strictEqual(isBasicLand({ name: 'Snow-Covered Plains', supertype: 'Land', subtypes: '["Basic","Snow","Plains"]' }), true);
  assert.strictEqual(isBasicLand({ name: 'Tundra', supertype: 'Land', subtypes: '["Land","Plains","Island"]' }), false,
    'typed dual lands are not Basic Lands');
  assert.strictEqual(isBasicLand({ name: 'Fabled Passage', supertype: 'Land', subtypes: '["Land"]' }), false);
  assert.strictEqual(isBasicLand({ name: 'Sword of the Meek', supertype: 'Enchantment' }), false);
}

function makeFakeDb({ owned = 3, card } = {}) {
  const cachedCard = card || {
    id: 'mtg-p1', name: 'Llantern Wanderer', supertype: 'Creature', subtypes: '["Creature","Cat"]'
  };
  return {
    async get(sql) {
      if (/FROM card_cache WHERE id/.test(sql)) return cachedCard;
      if (/AS owned/.test(sql)) return { owned };
      return null;
    },
  };
}

async function testValidation() {
  const base = { deckId: 1, userId: 7, cardId: 'mtg-p1' };

  assert.strictEqual((await validateDeckAddition({ ...base, newQty: 4, dbClient: makeFakeDb({ owned: 3 }) })).ok, false,
    'cannot exceed logical copies owned across printings');

  const capFail = await validateDeckAddition({ ...base, newQty: 5, dbClient: makeFakeDb({ owned: 10 }) });
  assert.strictEqual(capFail.ok, false, 'absolute logical quantity is capped at 4');
  assert.ok(/more than 4/.test(capFail.error), 'reports the 4-copy rule');

  assert.strictEqual((await validateDeckAddition({ ...base, newQty: 4, dbClient: makeFakeDb({ owned: 10 }) })).ok, true,
    'exactly 4 total is allowed');

  const island = { id: 'island-a', name: 'Island', supertype: 'Land', subtypes: '["Basic","Land","Island"]' };
  assert.strictEqual((await validateDeckAddition({
    ...base, cardId: island.id, newQty: 20, dbClient: makeFakeDb({ owned: 20, card: island })
  })).ok, true, 'basic lands remain exempt from the four-copy cap');

  const tundra = { id: 'tundra-a', name: 'Tundra', supertype: 'Land', subtypes: '["Land","Plains","Island"]' };
  assert.strictEqual((await validateDeckAddition({
    ...base, cardId: tundra.id, newQty: 5, dbClient: makeFakeDb({ owned: 10, card: tundra })
  })).ok, false, 'typed nonbasic lands remain subject to the four-copy cap');
}

async function main() {
  testClassification();
  await testValidation();
  console.log('deckrules.test.js passed');
}

main().catch(err => { console.error(err); process.exit(1); });
