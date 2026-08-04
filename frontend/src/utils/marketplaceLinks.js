// Links to the marketplaces a card's price comes from.
//
// Order of preference:
//   1. The URL the PROVIDER gave us (card_cache.tcgplayer_url / cardmarket_url).
//      Scryfall and pokemontcg.io both supply one per card, and Scryfall's search
//      the ENGLISH name — which is what these sites index — so they resolve even
//      for a Japanese printing.
//   2. A name search, for rows cached before those columns existed.
//   3. Nothing. Returning null is deliberate: a non-English Pokémon card from
//      TCGdex has only a localized name, and searching TCGplayer for ヒトカゲ
//      returns zero results every time. A button that always fails is worse than
//      no button, so the caller hides it.
function cardGame(card) {
  return card?.game || (card?.supertype === 'MTG' ? 'mtg' : 'pokemon');
}

// Does this name stand a chance in an English-language marketplace search?
// Both sites index English names, so a name with no Latin letters cannot match.
function searchable(card) {
  return /[a-z]/i.test(card?.name || '');
}

export function tcgplayerUrl(card) {
  if (card?.tcgplayer_url) return card.tcgplayer_url;
  if (!searchable(card)) return null;
  const line = cardGame(card) === 'mtg' ? 'magic' : 'pokemon';
  // Name only. Appending set name + number narrowed a lot of searches to zero
  // hits — Scryfall's own links search the bare name for the same reason.
  return `https://www.tcgplayer.com/search/${line}/product?q=${encodeURIComponent(card.name)}`;
}

export function cardmarketUrl(card) {
  if (card?.cardmarket_url) return card.cardmarket_url;
  if (!searchable(card)) return null;
  const game = cardGame(card) === 'mtg' ? 'Magic' : 'Pokemon';
  return `https://www.cardmarket.com/en/${game}/Products/Search?searchString=${encodeURIComponent(card.name)}`;
}

const isForeignPokemon = (card) =>
  cardGame(card) === 'pokemon' && !!card?.language && card.language !== 'English';

// Where the displayed price actually came from, for the inspector to label.
// Non-English Pokémon prices are Cardmarket's, quoted in EUR — but only claim that
// when there IS such a price. TCGdex has no Cardmarket listing for whole sets
// (テラスタルフェスex is one), and labelling a $0.00 as "via Cardmarket (EUR)"
// asserts a source that never answered.
export function priceSource(card) {
  if (!isForeignPokemon(card)) return null;
  const hasCardmarketData = card.cardmarket_url || Number(card.price_trend) > 0;
  return hasCardmarketData ? { name: 'Cardmarket', currency: 'EUR' } : null;
}

// Why there is no marketplace link, when there isn't one. The two causes need
// different words: a card can be missing from the marketplaces entirely, or listed
// under a name we don't hold.
export function noLinkReason(card) {
  if (tcgplayerUrl(card) || cardmarketUrl(card)) return null;
  if (isForeignPokemon(card)) {
    return 'No marketplace listing for this printing — TCGdex has no Cardmarket entry for it, which is also why there is no price.';
  }
  return 'No marketplace link for this printing — TCGplayer and Cardmarket index cards by English name, and this one has none.';
}
