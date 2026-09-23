export const COLORS = Object.freeze([
  { id: 'W', name: 'White', land: 'Plains' },
  { id: 'U', name: 'Blue', land: 'Island' },
  { id: 'B', name: 'Black', land: 'Swamp' },
  { id: 'R', name: 'Red', land: 'Mountain' },
  { id: 'G', name: 'Green', land: 'Forest' },
].map(Object.freeze));

function validateInteger(value, maximum, label) {
  if (typeof value !== 'number') {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 0 to ${maximum}`);
  }
}

/**
 * Allocate basics using Hamilton's largest-remainder method.
 * Missing own color keys count as zero; unrelated keys are ignored.
 * Shares describe pip proportions, including when no lands are requested.
 * Inputs are never mutated. All integer products are exact within the limits.
 */
export function allocate(total, pips) {
  validateInteger(total, 40, 'total');
  if (pips === null || typeof pips !== 'object' || Array.isArray(pips)) {
    throw new TypeError('pips must be a plain object');
  }
  const prototype = Object.getPrototypeOf(pips);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('pips must be a plain object');
  }

  const weights = COLORS.map(({ id }) => {
    const weight = Object.hasOwn(pips, id) ? pips[id] : 0;
    validateInteger(weight, 999, `pips.${id}`);
    return weight;
  });
  const totalPips = weights.reduce((sum, weight) => sum + weight, 0);
  const lands = Object.fromEntries(COLORS.map(({ id }) => [id, 0]));
  const shares = { ...lands };
  if (totalPips === 0) {
    return { totalPips, hasPips: false, lands, shares };
  }

  let allocated = 0;
  const candidates = [];
  COLORS.forEach(({ id }, index) => {
    const weight = weights[index];
    shares[id] = weight / totalPips;
    if (weight === 0) return;
    const numerator = total * weight;
    const remainder = numerator % totalPips;
    const base = (numerator - remainder) / totalPips;
    lands[id] = base;
    allocated += base;
    candidates.push({ id, index, weight, remainder });
  });
  candidates.sort((a, b) =>
    b.remainder - a.remainder || b.weight - a.weight || a.index - b.index,
  );
  for (let index = 0; index < total - allocated; index += 1) {
    lands[candidates[index].id] += 1;
  }
  return { totalPips, hasPips: true, lands, shares };
}
