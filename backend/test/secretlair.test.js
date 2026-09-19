// Secret Lair drop search + preview + add. No network and no real database:
// getPreconIndex, getPreconCardList, bulkFetchByIdentifier and bulkAddToCollection
// are all injected, and the ownership read runs against a stub db, so every
// assertion is about what WOULD be filed, not about a live server.
const assert = require('assert');
const os = require('os');
const path = require('path');
// secretLair pulls in the db module transitively; park it on a throwaway file
// so an injected-stub run can never touch a real (dev) database.
process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-seclair-${process.pid}.db`);
const {
  baseName, isFoilRow, searchSecretLair, previewSecretLairDrop, addSecretLairToCollection,
} = require('../src/utils/secretLair');

const UUID_A = 'c385447a-f56d-4b65-a090-bae48b0313c0';
const UUID_B = '11111111-2222-3333-4444-555555555555';

// --- pure name helpers -----------------------------------------------------
assert.strictEqual(baseName('A Box of Rocks Foil Edition'), 'A Box of Rocks');
assert.strictEqual(baseName('A Box of Rocks'), 'A Box of Rocks');
assert.ok(isFoilRow({ name: 'x Foil Edition' }), 'name convention marks the foil twin');
assert.ok(isFoilRow({ isFoil: true }), 'explicit flag marks the foil twin');
assert.ok(!isFoilRow({ name: 'x' }), 'a base row is not foil');

(async () => {
  // --- searchSecretLair ----------------------------------------------------
  const INDEX = {
    source: 'fresh',
    mtgjsonDate: '2026-09-15',
    decks: [
      { name: 'A Box of Rocks', code: 'SLD', type: 'Secret Lair Drop', releaseDate: '2021-03-15', fileName: 'ABoxOfRocks_SLD' },
      { name: 'A Box of Rocks Foil Edition', code: 'SLD', type: 'Secret Lair Drop', releaseDate: '2021-03-15', fileName: 'ABoxOfRocksFoilEdition_SLD' },
      { name: 'Foil Only Drop', code: 'SLD', type: 'Secret Lair Drop', releaseDate: '2022-01-01', fileName: 'FoilOnlyDrop_FoilEdition_SLD', isFoil: true },
      { name: 'Plain Drop', code: 'SLD', type: 'Secret Lair Drop', releaseDate: '2020-01-01', fileName: 'PlainDrop_SLD' },
      { name: 'Not A Drop', code: 'C21', type: 'Commander Deck', fileName: 'NotACommander_C21' },
    ],
  };
  const getIndex = async () => INDEX;

  let out = await searchSecretLair('box of rocks', { getIndex });
  assert.strictEqual(out.total, 3, 'only Secret Lair drops are catalogued (base + foil twin merge into one)');
  assert.strictEqual(out.results.length, 1, 'the query ranks one drop first');
  const rock = out.results[0];
  assert.strictEqual(rock.name, 'A Box of Rocks', 'the foil twin merged into the base entry');
  assert.strictEqual(rock.fileName, 'ABoxOfRocks_SLD', 'base file is the non-foil read');
  assert.strictEqual(rock.foil.fileName, 'ABoxOfRocksFoilEdition_SLD', 'foil twin carried for the foil read');
  assert.strictEqual(rock.hasFoil, true);
  assert.strictEqual(rock.foilOnly, false);
  assert.strictEqual(out.stale, false, 'a fresh mirror is not stale');
  assert.strictEqual(out.mtgjsonDate, '2026-09-15');

  out = await searchSecretLair('foil only', { getIndex });
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0].foilOnly, true, 'a drop with only a Foil Edition product is foil-only');
  assert.strictEqual(out.results[0].fileName, 'FoilOnlyDrop_FoilEdition_SLD', 'foil-only falls back to the one file it has');

  // An unknown fileName is not a hard failure — the box browses, so empty wins
  // over an error, and it never matches the non-drop row.
  out = await searchSecretLair('zzzz', { getIndex });
  assert.deepStrictEqual(out.results, [], 'no match is an empty list, not an error');

  assert.ok((await searchSecretLair('', { getIndex })).total >= 3, 'empty query browses the whole catalogue');

  // --- previewSecretLairDrop ----------------------------------------------
  // Two rows share one scryfallId (a duplicate printing across sections) and
  // one row has no usable identifiers at all — it must be dropped, not faked.
  const list = {
    name: 'A Box of Rocks', code: 'SLD', type: 'Secret Lair Drop',
    cards: [
      { setCode: 'SLD', number: '201', scryfallId: UUID_A, name: 'Arcane Signet', count: 2, isFoil: false },
      { setCode: 'SLD', number: '201', scryfallId: UUID_A, name: 'Arcane Signet', count: 2, isFoil: false }, // dup
      { setCode: 'SLD', number: '202', scryfallId: UUID_B, name: 'Forest', count: 9, isFoil: true },
      { setCode: '', number: '', scryfallId: '', name: '', count: 1 }, // unusable -> dropped
    ],
  };
  const getCardList = async () => list;
  // Echoes the real resolver's contract: `pairs[].row` is the exact row object we
  // sent (so the _count/_isFoil scratch fields ride along), and only the known
  // uuids come back — the rest surface as notFound.
  const bulkResolve = async (rows) => {
    const cards = []; const pairs = []; let notFound = 0;
    for (const r of rows) {
      if (r.id === UUID_A) { const c = { id: `mtg-${UUID_A}`, name: 'Arcane Signet', image_url: 'a.png', set_id: 'SLD', number: '201' }; cards.push(c); pairs.push({ row: r, card: c }); }
      else if (r.id === UUID_B) { const c = { id: `mtg-${UUID_B}`, name: 'Forest', image_url: 'b.png', set_id: 'SLD', number: '202' }; cards.push(c); pairs.push({ row: r, card: c }); }
      else notFound++;
    }
    return { cards, pairs, notFound };
  };
  let cached = 0;
  const cacheCards = async (cs) => { cached += cs.length; };
  const dbStub = { all: async () => [{ card_id: `mtg-${UUID_A}`, qty: 3 }] }; // owns 3 Signets, 0 Forest

  const p = await previewSecretLairDrop({ fileName: 'anything', userId: 7 },
    { getCardList, bulkResolve, cacheCards, db: dbStub });
  assert.strictEqual(p.name, 'A Box of Rocks');
  assert.strictEqual(p.cards.length, 2, 'the unusable row is dropped, the duplicate merged');
  const signet = p.cards.find((c) => c.card_id === `mtg-${UUID_A}`);
  const forest = p.cards.find((c) => c.card_id === `mtg-${UUID_B}`);
  assert.strictEqual(signet.count, 4, 'duplicate printing folds into one entry with summed copies');
  assert.strictEqual(signet.owned, 3, 'ownership is counted from the collection stub');
  assert.strictEqual(forest.count, 9, 'per-card product count is preserved');
  assert.strictEqual(forest.isFoil, true, 'the product foil flag rides the identity handle');
  assert.strictEqual(forest.owned, 0, 'an unowned card reports zero');
  assert.strictEqual(p.unresolved, 0, 'both real printings resolved');
  assert.strictEqual(p.totalListed, 2, 'distinct printings listed');
  assert.strictEqual(p.resolvedCount, 2, 'resolved printings counted');
  assert.strictEqual(cached, 2, 'resolved cards are cached for the later add');

  // No user → no ownership read (would otherwise throw on a missing db).
  const pNoUser = await previewSecretLairDrop({ fileName: 'x' }, { getCardList, bulkResolve, cacheCards });
  assert.strictEqual(pNoUser.cards.find((c) => c.card_id === `mtg-${UUID_A}`).owned, 0, 'no user means no owned lookup');

  // --- addSecretLairToCollection ------------------------------------------
  const calls = [];
  const bulkAdd = async (user, entries, shared) => {
    calls.push({ user, entries, shared });
    return { added: entries.map((e) => ({ card_id: e.card_id, id: 1 })), failed: [] };
  };
  const user = { id: 7 };

  // auto: each card keeps the product's own foil flag, and the two printings
  // split across the two shared-printing calls.
  let a = await addSecretLairToCollection({ fileName: 'x', user, printingMode: 'auto', copies: 2 },
    { getCardList, bulkResolve, cacheCards, db: dbStub, bulkAdd });
  assert.strictEqual(a.added, 2, 'both cards filed');
  assert.strictEqual(a.failed.length, 0);
  assert.strictEqual(calls.length, 2, 'auto splits by the product flag (Normal + Holofoil)');
  const normalCall = calls.find((c) => c.shared.printing === 'Normal');
  const foilCall = calls.find((c) => c.shared.printing === 'Holofoil');
  assert.ok(normalCall && foilCall, 'one group per printing');
  assert.strictEqual(normalCall.entries[0].card_id, `mtg-${UUID_A}`, 'the non-foil product card is Normal');
  assert.strictEqual(normalCall.entries[0].quantity, 8, 'per-card quantity = product count × copies');
  assert.strictEqual(foilCall.entries[0].card_id, `mtg-${UUID_B}`, 'the foil product card is Holofoil');
  assert.strictEqual(foilCall.entries[0].quantity, 18, '9 copies × 2');
  assert.strictEqual(normalCall.shared.condition, 'Near Mint', 'shared condition applied');
  assert.strictEqual(normalCall.shared.language, 'English', 'shared language applied');
  assert.strictEqual(normalCall.shared.stackable, true, 'stacked write is the collection path');
  assert.strictEqual(a.unresolved, 0);

  // force foil: every card lands Holofoil, one call.
  calls.length = 0;
  a = await addSecretLairToCollection({ fileName: 'x', user, printingMode: 'foil' },
    { getCardList, bulkResolve, cacheCards, db: dbStub, bulkAdd });
  assert.strictEqual(calls.length, 1, 'forced printing is a single group');
  assert.strictEqual(calls[0].shared.printing, 'Holofoil');
  assert.strictEqual(calls[0].entries.length, 2, 'both forced-holofoil cards share one call');
  assert.strictEqual(calls[0].entries[0].quantity, 4, 'copies default to a 1× multiplier');

  // invalid printing value falls back to auto (the product's own flag), never 500.
  calls.length = 0;
  await addSecretLairToCollection({ fileName: 'x', user, printingMode: 'bogus' },
    { getCardList, bulkResolve, cacheCards, db: dbStub, bulkAdd });
  assert.strictEqual(calls.length, 2, 'an invalid printing behaves like auto');

  // invalid condition coerces to Near Mint, not rejected.
  calls.length = 0;
  await addSecretLairToCollection({ fileName: 'x', user, printingMode: 'nonfoil', condition: 'Minty' },
    { getCardList, bulkResolve, cacheCards, db: dbStub, bulkAdd });
  assert.strictEqual(calls[0].shared.condition, 'Near Mint', 'a bad condition falls back, not throws');

  // a bulk-add failure is reported per card, not thrown.
  const bulkFail = async (user, entries) => ({ added: [], failed: entries.map((e) => ({ card_id: e.card_id, error: 'nope' })) });
  a = await addSecretLairToCollection({ fileName: 'x', user, printingMode: 'nonfoil' },
    { getCardList, bulkResolve, cacheCards, db: dbStub, bulkAdd: bulkFail });
  assert.strictEqual(a.added, 0);
  assert.strictEqual(a.failed.length, 2, 'per-card failures are surfaced');

  // nothing resolvable → 0 filed, and the bulk service is never reached.
  let touched = false;
  a = await addSecretLairToCollection({ fileName: 'x', user },
    { getCardList: async () => ({ name: 'Empty', cards: [] }), bulkResolve, cacheCards, db: dbStub,
      bulkAdd: async () => { touched = true; return { added: [], failed: [] }; } });
  assert.strictEqual(a.added, 0);
  assert.ok(!touched, 'an empty product never reaches the bulk writer');
  assert.strictEqual(a.totalCards, 0);

  console.log('PASS: secret lair search + preview + add core');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL: secret lair —', err && err.stack ? err.stack : err);
  process.exit(1);
});
