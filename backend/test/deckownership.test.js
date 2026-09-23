// Deck list ownership (utils/deckOwnership.js): the per-deck "missing" numbers
// the deck grid shows must match the deck editor's missingEntries rule.
// Pinned: printing-agnostic (owned alt printing counts), basics exempt, partial
// shortfalls count the remaining copies, other users' collections never count,
// and a fully owned deck reports 0.
// Run: `node test/deckownership.test.js`
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-deckownership-${process.pid}.db`);
const db = require('../src/db');
const { getDeckOwnership } = require('../src/utils/deckOwnership');

const USER = 1;

async function main() {
  await db.initDb();
  for (const t of ['deck_cards', 'decks', 'collection', 'card_cache', 'users']) await db.run(`DELETE FROM ${t}`);
  await db.run(`INSERT INTO users (id, username, password_hash, role, share_token) VALUES (1,'do','x','admin','do-t'), (99,'other','x','member','other-t')`);

  const cards = [
    ['mtg-bolt', 'Lightning Bolt', '[]'],
    ['mtg-bolt-alt', 'Lightning Bolt', '[]'],
    ['mtg-sol', 'Sol Ring', '[]'],
    ['mtg-crypt', 'Mana Crypt', '[]'],
    ['mtg-mountain', 'Mountain', '["Basic","Land"]'],
  ];
  for (const [id, name, subs] of cards) {
    await db.run('INSERT INTO card_cache (id, name, supertype, subtypes) VALUES (?,?,?,?)', [id, name, 'MTG', subs]);
  }
  await db.run(`INSERT INTO decks (id, user_id, name) VALUES (1, 1, 'Short'), (2, 1, 'Full'), (3, 99, 'Theirs')`);
  const add = (d, c, q) => db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?,?,?)', [d, c, q]);
  // Deck 1 needs: 4 Bolt (owns 3 via the ALT printing), 1 Sol (owned),
  // 1 Crypt (only user 99 owns it), 20 Mountain (basic, exempt).
  await add(1, 'mtg-bolt', 4); await add(1, 'mtg-sol', 1); await add(1, 'mtg-crypt', 1); await add(1, 'mtg-mountain', 20);
  // Deck 2: fully owned.
  await add(2, 'mtg-sol', 1);
  await add(3, 'mtg-crypt', 1);

  const own = (u, c, q) => db.run('INSERT INTO collection (user_id, card_id, quantity) VALUES (?,?,?)', [u, c, q]);
  await own(1, 'mtg-bolt-alt', 3); await own(1, 'mtg-sol', 1); await own(99, 'mtg-crypt', 1);

  const res = await getDeckOwnership(db, USER);
  assert.deepStrictEqual(res.get(1), { missing_card_types: 2, missing_copies: 2 }, 'Bolt short 1 + Crypt short 1; basics exempt');
  assert.deepStrictEqual(res.get(2), { missing_card_types: 0, missing_copies: 0 }, 'fully owned deck');
  assert.strictEqual(res.has(3), false, "other user's deck not returned");
  console.log('deckownership: ok');
}

main().then(() => { try { fs.unlinkSync(process.env.DB_PATH); } catch {} process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
