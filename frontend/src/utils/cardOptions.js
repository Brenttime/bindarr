// Shared <select> option lists for collection entry fields, previously
// copy-pasted across CollectionList, CardSearch, and
// CameraScanner's quick-add/edit forms.
import { LANGUAGE_NAMES } from './languages';

export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo'];
// Re-exported from the language registry so the entry forms, the search language
// picker and the backend can never drift out of sync.
export const LANGUAGES = LANGUAGE_NAMES;

// Magic cards are only Nonfoil or Foil. The foil price is stored under the
// 'Holofoil' value (scryfall usd_foil), so we keep that stored value (also what
// the DB CHECK allows) and just relabel it "Foil".
const MTG_PRINTINGS = [{ value: 'Normal', label: 'Nonfoil' }, { value: 'Holofoil', label: 'Foil' }];

// Printing/finish {value,label} options. Value stays within the
// collection.printing CHECK constraint. The `game` argument is kept for call
// sites that still pass one; it no longer changes anything.
export function getPrintings(game) {
  void game;
  return MTG_PRINTINGS;
}

// A binder-family container lays out fixed pockets (Pages); other container
// types (boxes, deck boxes) are continuous (Rows). Kept here so the several
// UI spots that branch on it share one definition.
export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';

// Container type labels are translated, but the type itself is the English string
// stored in the database, so the two are paired here rather than in each screen
// that renders one. The label is t(`container.type.${containerTypeKey(type)}`);
// 'misc' is keyed that way and not 'other' because a key ending in a plural
// category is read as a counted phrase by check-locales.mjs.
const CONTAINER_TYPE_KEYS = {
  'Binder': 'binder',
  'Toploader Binder': 'toploaderBinder',
  'Box': 'box',
  'Toploader Box': 'toploaderBox',
  'Display Shelf / Stand': 'displayShelf',
  'Deck Box': 'deckBox',
  'Tin / Case': 'tinCase',
  'Other': 'misc',
};

// A type from an older install (or a hand-edited row) has no key; callers fall
// back to showing the stored English rather than mislabelling it "Other".
export const containerTypeKey = (type) => CONTAINER_TYPE_KEYS[type] || null;
