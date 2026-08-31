'use strict';

// Scryfall normally exposes oracle_id on the top-level card object. Reversible
// cards are the exception: their shared Oracle identity is carried only by the
// faces. Accept that identity only when every populated face agrees.
function oracleIdForCard(card) {
  if (!card || typeof card !== 'object') return null;
  if (card.oracle_id) return String(card.oracle_id);
  const faceIds = new Set(
    (Array.isArray(card.card_faces) ? card.card_faces : [])
      .map(face => face && face.oracle_id)
      .filter(Boolean)
      .map(String),
  );
  return faceIds.size === 1 ? [...faceIds][0] : null;
}

// /cards/search excludes these supplemental objects unless a query explicitly
// asks for them (or include_extras=true). The local planner only handles otag
// plus ordinary card fields; explicit extra/layout operators stay on the remote
// compatibility path, so its local rows must mirror the default search pool.
const EXTRA_LAYOUTS = new Set([
  'planar',
  'scheme',
  'vanguard',
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
]);

function defaultSearchEligible(card) {
  if (!card || typeof card !== 'object' || !card.layout) return null;
  return EXTRA_LAYOUTS.has(String(card.layout).toLowerCase()) ? 0 : 1;
}

module.exports = { oracleIdForCard, defaultSearchEligible };
