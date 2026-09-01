import { cardKey } from './cardIdentity.js';

const MTG_MAIN_TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land'];
const GROUP_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Battle', 'Land', 'Other'];

const cardGroup = (card) => {
  const subs = card.subtypes || [];
  for (const type of MTG_MAIN_TYPES) if (subs.includes(type)) return type;
  return 'Other';
};

// Basic Lands are exempt from the "max 4 of a card" deck rule.
export const isBasicLand = (card) => {
  if (!card) return false;
  const subs = card.subtypes || [];
  const basicNames = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
  return (subs.includes('Land') || card.supertype === 'Land') &&
    (subs.includes('Basic') || basicNames.includes(card.name));
};

export function deriveDeckRenderData(deckCards) {
  const groupBuckets = Object.fromEntries(GROUP_ORDER.map(name => [name, { name, cards: [], count: 0 }]));
  const supertypeCounts = new Map();
  const manaCounts = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7+': 0 };
  const colorLandCounts = {};
  const countsByName = new Map();
  let totalDeckCardsCount = 0;
  let basicLandCount = 0;

  for (const card of deckCards) {
    const quantity = card.quantity;
    const group = cardGroup(card);
    const bucket = groupBuckets[group];
    bucket.cards.push(card);
    bucket.count += quantity;
    supertypeCounts.set(group, (supertypeCounts.get(group) || 0) + quantity);
    totalDeckCardsCount += quantity;
    if (isBasicLand(card)) basicLandCount += quantity;

    const nameKey = cardKey(card);
    if (nameKey) countsByName.set(nameKey, (countsByName.get(nameKey) || 0) + Number(quantity || 0));

    const manaValue = card.cmc;
    if (manaValue !== null && manaValue !== undefined) {
      const manaBucket = manaValue >= 7 ? '7+' : String(Math.floor(manaValue));
      if (manaCounts[manaBucket] !== undefined) manaCounts[manaBucket] += quantity;
    }

    const subs = card.subtypes || [];
    const isLand = subs.includes('Land') || card.supertype === 'Land' || group === 'Land';
    if (isLand) {
      const basicLandTypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
      const foundType = basicLandTypes.find(type => subs.includes(type) || card.name.includes(type));
      const label = foundType ? `Land (${foundType})` : 'Land (Nonbasic)';
      colorLandCounts[label] = (colorLandCounts[label] || 0) + quantity;
    } else {
      const colors = card.colors || card.types || [];
      if (colors.length === 0) {
        colorLandCounts.Colorless = (colorLandCounts.Colorless || 0) + quantity;
      } else {
        for (const color of colors) {
          const colorName = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[color] || color;
          colorLandCounts[colorName] = (colorLandCounts[colorName] || 0) + quantity;
        }
      }
    }
  }

  const deckGroups = GROUP_ORDER.map(name => groupBuckets[name]).filter(group => group.cards.length > 0);
  return {
    basicLandCount,
    countsByName,
    deckGroups,
    totalDeckCardsCount,
    supertypeData: Array.from(supertypeCounts, ([name, value]) => ({ name, value })).filter(group => group.value > 0),
    manaCurveData: Object.entries(manaCounts).map(([cost, count]) => ({ cost, count })),
    colorLandData: Object.entries(colorLandCounts).map(([name, value]) => ({ name, value })),
  };
}
