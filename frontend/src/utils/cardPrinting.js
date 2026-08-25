// Single source of truth for how a card's printing/finish is displayed across
// every view (Collection gallery/list, deck views, inspectors).
//
// Every view routes badge text, colors, and foil treatment through this module so
// the same finish looks identical throughout the app.

// Short uppercase badge label shown on card thumbnails.
export function getPrintingBadgeLabel(printing) {
  switch (printing) {
    case 'Holofoil': return 'FOIL';
    default: return '';
  }
}

// Full user-facing finish label. Stored values remain unchanged for database and
// API compatibility, but should never be rendered directly.
export function getPrintingLabel(printing) {
  switch (printing) {
    case 'Holofoil': return 'Foil';
    case 'Normal': return 'Nonfoil';
    default: return printing || '';
  }
}

// Badge background/text colors.
export function getPrintingBadgeStyle(printing) {
  switch (printing) {
    case 'Holofoil':
      return { background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', color: '#1a1206' };
    default:
      return { background: 'rgba(148, 163, 184, 0.85)', color: '#0a0f1d' };
  }
}

// Returns the CSS class for the animated foil overlay, or null for finishes
// that get no shine. The legacy Holofoil storage value gets a rainbow prism.
export function getFoilOverlayClass(printing) {
  if (printing === 'Holofoil') return 'foil-shine-overlay';
  return null;
}
