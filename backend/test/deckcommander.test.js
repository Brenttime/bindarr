// The deck list shows each deck's commander art on its tile. Pinned here: the
// pick is a Legendary Creature (or an ambient-text commander variant), a deck
// with no such card gets null (no broken image), multi-commander decks break
// ties by deck color-identity overlap then quantity then cmc then name, and
// every deck's commander comes back from ONE query (no per-deck round trips;
// this shape exists so the deck list never rescans card_cache once per deck).
// No framework - plain node + assert, scratch DB like collectioncatalogquery.
// Run: `node test/deckcommander.test.js`
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `scrybox-deckcommander-${process.pid}.db`);
const db = require('../src/db');
const { getDeckCommanders } = require('../src/utils/deckCommander');

const USER = 1;
// Name lookups go through the seeded array: the card's name is inserted from
// `cards` and asserted against the same source, so the row shapes below are
// defined exactly once.
const COLOR_WORD = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

// scryfallApi stores the printed type line split into words in subtypes, the
// colors as words in types, and the color identity as color WORDS ('White').
function card(id, name, { legend = false, creature = false, subtype = null, ci = [], cmc = 3, image = null } = {}) {
  const types = ci.map(c => COLOR_WORD[c]);
  const subtypes = [legend && 'Legendary', creature && 'Creature', subtype].filter(Boolean);
  return { id, name, supertype: 'MTG', subtypes, types, cmc, color_identity: ci, image_url: image };
}

async function main() {
  await db.initDb();
  await db.run('DELETE FROM deck_cards');
  await db.run('DELETE FROM decks');
  await db.run('DELETE FROM card_cache');
  await db.run('DELETE FROM users');
  await db.run(`INSERT INTO users (id, username, password_hash, role, share_token)
    VALUES (?, 'dc-test', 'x', 'admin', 'dc-test-token')`, [USER]);
  // A second user's deck must never be visible to the first.
  await db.run(`INSERT INTO users (id, username, password_hash, role, share_token)
    VALUES (99, 'dc-other', 'x', 'member', 'dc-other-token')`);

  const cards = [
    card('mtg-bolt', 'Lightning Bolt', { ci: ['R'], cmc: 1 }),
    card('mtg-hazoret', 'Hazoret the Fervent', { legend: true, creature: true, ci: ['R', 'W'], cmc: 5, image: 'https://example.com/hazoret.jpg' }),
    card('mtg-hazoret-alt', 'Hazoret the Fervent', { legend: true, creature: true, ci: ['R', 'W'], cmc: 5, image: 'https://example.com/hazoret-alt.jpg' }),
    card('mtg-tawxs', 'Tawxs, Ariitteus Sergeant-at-Arms', { legend: true, creature: true, ci: ['B', 'R'], cmc: 2, image: 'https://example.com/tawxs.jpg' }),
    card('mtg-mountain', 'Mountain', { ci: ['R'], cmc: 0 }),
    card('mtg-plain', 'Plains', { ci: ['W'], cmc: 0 }),
    card('mtg-elf', 'Llanowar Elves', { creature: true, ci: ['G'], cmc: 1 }),
    card('mtg-streamer', 'theallocator', { creature: true, subtype: 'Companion', ci: ['U', 'G'], cmc: 3, image: 'https://example.com/streamer.jpg' }),
    card('mtg-island', 'Island', { ci: ['U'], cmc: 0 }),
    card('mtg-forest', 'Forest', { ci: ['G'], cmc: 0 }),
  ];
  for (const c of cards) {
    await db.run(
      `INSERT INTO card_cache (id, name, supertype, subtypes, types, cmc, color_identity, image_url)
       VALUES (?,?,?,?,?,?,?,?)`,
      [c.id, c.name, c.supertype, JSON.stringify(c.subtypes), JSON.stringify(c.types), c.cmc,
       JSON.stringify(c.color_identity), c.image_url]);
  }

  await db.run(`INSERT INTO decks (id, user_id, name) VALUES
    (1, ?, 'Mono Red'),
    (2, ?, 'Plain Deck'),
    (3, ?, ' IDENTICAL-TWIN'),
    (4, ?, 'Legacy'),
    (5, ?, ' Companion'),
    (6, 99, 'Someone Else')`, [USER, USER, USER, USER, USER]);

  const add = (deckId, cardId, qty) =>
    db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?,?,?)', [deckId, cardId, qty]);
  // Deck 1: Hazoret is the only legendary creature.
  await add(1, 'mtg-hazoret', 1); await add(1, 'mtg-bolt', 4); await add(1, 'mtg-mountain', 20);
  // Deck 2: a plain creature and lands. No commander exists.
  await add(2, 'mtg-elf', 2); await add(2, 'mtg-forest', 10);
  // Deck 3 (id-only tie-break): an alt etched foil printing of
  // Hazoret. Everything matches between printings, so the lower id wins.
  await add(3, 'mtg-hazoret-alt', 1); await add(3, 'mtg-hazoret', 1);
  // Deck 4: the commander row sits at quantity 0 (list left mid-sell) with
  // nothing else qualifying. It should still win, not voteless Bolt, and never
  // look at another card. That's the paint of a giveaway-deck tile.
  await add(4, 'mtg-hazoret', 0); await add(4, 'mtg-bolt', 4);
  // Deck 5: a nonlegendary creature with the 'Companion' subtype only.
  await add(5, 'mtg-streamer', 1); await add(5, 'mtg-island', 12); await add(5, 'mtg-forest', 8);
  // Deck 6 lives for USER 99.
  await add(6, 'mtg-hazoret', 1);

  const commanders = await getDeckCommanders(db, USER);

  assert.strictEqual(commanders.size, 4, 'every deck but the commander-less one got a pick');
  assert.ok(!commanders.has(2), 'a deck with no commander-shaped card gets no entry');
  assert.ok(!commanders.has(6), "another user's deck is not scanned");

  assert.strictEqual(commanders.get(1).commander_name, 'Hazoret the Fervent');
  assert.strictEqual(commanders.get(1).commander_image_url, 'https://example.com/hazoret.jpg');
  assert.strictEqual(commanders.get(1).commander_card_id, 'mtg-hazoret');

  assert.strictEqual(commanders.get(3).commander_card_id, 'mtg-hazoret',
    'equal printings resolve to the lower card id deterministically');

  assert.strictEqual(commanders.get(4).commander_card_id, 'mtg-hazoret',
    'the full-quantity commander rows are preferred over a zero-quantity slot');

  assert.strictEqual(commanders.get(5).commander_card_id, 'mtg-streamer',
    'the nonlegendary companion creature is the deck 5 candidate');
  assert.strictEqual(commanders.get(5).commander_name, 'theallocator');

  // The color-identity tie-break: partners in a black-red deck. Tawxs (BR)
  // overlaps the deck identity better than a splash-the-plane red Hazoret.
  await db.run('DELETE FROM deck_cards WHERE deck_id = 3');
  await add(3, 'mtg-tawxs', 1); await add(3, 'mtg-hazoret', 1);
  await add(3, 'mtg-bolt', 4); await add(3, 'mtg-mountain', 17); await add(3, 'mtg-plain', 3);
  const partners = await getDeckCommanders(db, USER);
  assert.strictEqual(partners.get(3).commander_card_id, 'mtg-tawxs',
    'the candidate whose identity best matches the deck (BR in this BR-heavy) wins the pair');

  // An empty cached URL reads as "no art" rather than an empty src.
  await db.run("UPDATE card_cache SET image_url = '' WHERE id = 'mtg-streamer'");
  const noArt = await getDeckCommanders(db, USER);
  assert.strictEqual(noArt.get(5).commander_image_url, null, 'an empty cached URL becomes null');
  assert.strictEqual(noArt.get(5).commander_name, 'theallocator', 'the name still comes through');

  // A declared commander (Moxfield commanders board) wins even when it is not
  // legendary (Pauper EDH uncommons) and a legendary creature sits in the 99.
  await db.run('DELETE FROM deck_cards WHERE deck_id = 2');
  await add(2, 'mtg-elf', 1); await add(2, 'mtg-hazoret', 1); await add(2, 'mtg-forest', 10);
  await db.run("UPDATE deck_cards SET is_commander = 1 WHERE deck_id = 2 AND card_id = 'mtg-elf'");
  const declared = await getDeckCommanders(db, USER);
  assert.strictEqual(declared.get(2).commander_card_id, 'mtg-elf', 'the declared commander beats a legendary guess');

  // markDeckCommanders sets and clears flags by logical card.
  const { markDeckCommanders } = require('../src/moxfieldSync');
  const { sqlCardKey } = require('../src/utils/cardIdentity');
  const key = (await db.get(`SELECT ${sqlCardKey('card_cache')} AS k FROM card_cache WHERE id = 'mtg-hazoret'`)).k;
  await markDeckCommanders(db, 2, new Set([key]));
  const flags = await db.all('SELECT card_id, is_commander FROM deck_cards WHERE deck_id = 2 ORDER BY card_id');
  assert.deepStrictEqual(flags.filter(f => f.is_commander).map(f => f.card_id), ['mtg-hazoret']);

  console.log('deckcommander.test.js passed');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
  });
