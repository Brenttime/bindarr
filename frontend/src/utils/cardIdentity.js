export function cardKey(cardOrName) {
  const name = typeof cardOrName === 'string' ? cardOrName : cardOrName?.name;
  return String(name || '').trim().toLowerCase();
}

export function sameCard(left, right) {
  const leftKey = cardKey(left);
  return leftKey !== '' && leftKey === cardKey(right);
}

export function findSameCard(cards, cardOrName) {
  return (cards || []).find(card => sameCard(card, cardOrName));
}

export function quantityByCardName(cards, cardOrName) {
  return (cards || [])
    .filter(card => sameCard(card, cardOrName))
    .reduce((total, card) => total + Number(card.quantity || 0), 0);
}

export function adjustOwnedQuantityByName(cards, cardOrName, delta) {
  return (cards || []).map(card => sameCard(card, cardOrName)
    ? { ...card, owned_qty: Math.max(0, Number(card.owned_qty || 0) + delta) }
    : card);
}
