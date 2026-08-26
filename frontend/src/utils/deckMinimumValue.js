import { priceText } from './formatPrice.js';

export function deckMinimumValueText(deck) {
  const value = Number(deck?.minimum_value);
  const amount = Number.isFinite(value) && value > 0 ? value : 0;
  const rendered = priceText(amount, deck?.minimum_value_currency || 'USD');
  return Number(deck?.unpriced_cards) > 0 ? `${rendered}+` : rendered;
}

export function deckMinimumValueHint(deck, t) {
  const unpriced = Number(deck?.unpriced_cards) || 0;
  if (unpriced === 1) return t('deck.minimumValueIncompleteOne');
  if (unpriced > 1) return t('deck.minimumValueIncomplete', { count: unpriced });
  return t('deck.minimumValueComplete');
}

export function deckUnpricedCountText(deck, t) {
  const unpriced = Number(deck?.unpriced_cards) || 0;
  return unpriced > 0 ? t('deck.unpricedCount', { count: unpriced }) : '';
}
