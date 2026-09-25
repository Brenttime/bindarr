// How much each color should pull on the basic-land split.
//
// Raw pips over-reward double-pip cards: 14 black pips spread over only 6 black
// cards is a smaller share of your spells than 14 single-pip cards. Card count
// alone ignores that {B}{B} costs genuinely need more sources. The default
// blends the two shares 50/50; 'pips' and 'cards' keep either pure view.
//
// Returns integer weights (0..100) that allocateMana accepts as its pip record.
export const WEIGHT_MODES = ['blend', 'pips', 'cards'];

export function colorWeights(pips, cards, mode = 'blend') {
  const ids = Object.keys(pips);
  const sum = rec => ids.reduce((a, id) => a + (Number(rec?.[id]) || 0), 0);
  const P = sum(pips);
  const C = sum(cards);
  const usePips = mode === 'pips' || C === 0;
  const useCards = mode === 'cards' && C > 0;
  const out = {};
  for (const id of ids) {
    const p = P ? (Number(pips[id]) || 0) / P : 0;
    const c = C ? (Number(cards?.[id]) || 0) / C : 0;
    // A color with pips but no card count yet (typed by hand) keeps its pip share.
    let share = usePips ? p : useCards ? c : (p + c) / 2;
    if (!usePips && (Number(pips[id]) || 0) > 0 && !(Number(cards?.[id]) > 0)) share = p;
    out[id] = (Number(pips[id]) || 0) > 0 ? Math.max(1, Math.round(share * 100)) : 0;
  }
  return out;
}
