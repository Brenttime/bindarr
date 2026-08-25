export function canRegisterDeckInCollection(deck) {
  return Boolean(
    deck
    && !deck.checked_out
    && Array.isArray(deck.cards)
    && deck.cards.length > 0
  );
}

export function deckRegistrationCardCount(deck) {
  if (!Array.isArray(deck?.cards)) return 0;
  return deck.cards.reduce((total, card) => total + Math.max(0, Number(card.quantity) || 0), 0);
}
