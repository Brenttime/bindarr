// Which provider owns a card ID, and how to fetch it.
//
// The ID itself is the answer — it was minted by whichever provider supplied the
// card, and only that provider can resolve it:
//
//   mtg-<uuid>          Scryfall
//   tcgdex-<lang>-<id>  TCGdex
//   <anything else>     pokemontcg.io
//
// NOT the same question as utils/pokemonProvider. That one decides which provider
// should SERVE a language when searching or building — a policy that follows a
// setting. This is a fact about an ID that already exists, and no setting changes
// it: a 'tcgdex-en-sv01-001' row belongs to TCGdex whatever the provider is set
// to today. Conflating the two would reintroduce the bug that pokemonProvider
// exists to prevent, from the other direction.
//
// This lives in one place because the dispatch was written out in routes/
// collection.js and simply omitted in routes/decks.js, which therefore asked
// pokemontcg.io for every uncached card. tcgApi.getCardById short-circuits on the
// two foreign prefixes and returns only what is cached, so an uncached TCGdex or
// MTG card came back null and the route answered "Card not found on Pokémon TCG
// API" — a failure and a misleading message, for a card that exists.
const scryfallApi = require('../scryfallApi');
const tcgApi = require('../tcgApi');
const tcgdexApi = require('../tcgdexApi');

const isMtgId = (id) => String(id || '').startsWith('mtg-');
const isTcgdexId = (id) => String(id || '').startsWith('tcgdex-');

// The game an ID implies. `game` from the request wins when it says MTG, since a
// caller that knows better should be believed; everything else is Pokémon.
function gameOf(id, requestedGame) {
  return (requestedGame === 'mtg' || isMtgId(id)) ? 'mtg' : 'pokemon';
}

// Fill in a row that was cached from a partial source before it is relied on.
// Only TCGdex has thin rows (set briefs carry name/number/image and nothing
// else); the others always cache complete cards. Never throws — hydration is an
// improvement, and failing it must not block adding a card.
async function hydrate(id) {
  if (!isTcgdexId(id)) return;
  try { await tcgdexApi.hydrateCard(id); }
  catch (e) { console.warn(`Could not hydrate ${id}: ${e.message}`); }
}

// Fetch a card from whichever provider minted its ID. Returns null when that
// provider does not have it.
async function getCardById(id, { game, tcgApiKey = '' } = {}) {
  if (gameOf(id, game) === 'mtg') return await scryfallApi.getCardById(id);
  if (isTcgdexId(id)) return await tcgdexApi.getCardById(id);
  return await tcgApi.getCardById(id, tcgApiKey);
}

module.exports = { isMtgId, isTcgdexId, gameOf, hydrate, getCardById };
