// Mirrors backend/src/utils/priceHelpers.js's resolveCardPrice. Card search
// results and scan results carry per-printing prices (price_normal,
// price_holofoil) alongside a generic price_trend
// (whichever finish the provider happened to return first — usually Normal).
// Anywhere a specific printing is selected before the card is saved, use
// this so the displayed/recorded price matches that printing instead of
// silently showing a different finish's price.
export function resolveCardPrice(card, printing) {
  if (!card) return 0;
  if (printing === 'Holofoil' && card.price_holofoil > 0) return card.price_holofoil;
  if (printing === 'Normal' && card.price_normal > 0) return card.price_normal;
  return card.price_trend || 0;
}
