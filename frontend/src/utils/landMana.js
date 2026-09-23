import { COLORS } from './landCalc.js';

export const MANA_TYPES = Object.freeze([
  ...COLORS,
  Object.freeze({ id: 'C', name: 'Colorless', land: 'Wastes' }),
]);

const IDS = MANA_TYPES.map(({ id }) => id);
const ID_SET = new Set(IDS);
const ROW_KEYS = new Set(['quantity', 'produces', 'tapped', 'conditional']);
const zeros = () => Object.fromEntries(IDS.map(id => [id, 0]));
const isRecord = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function validateInteger(value, minimum, maximum, label) {
  if (typeof value !== 'number') throw new TypeError(`${label} must be a number`);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

/**
 * Source-balance heuristic, NOT draw probability or simultaneous payment feasibility.
 * Each existing quantity consumes physical slots once, even for multi-source lands.
 * Conditional sources are reported separately and never credited to the allocation.
 * Tapped unconditional sources count toward balance but not untappedSources.
 * Missing pip keys mean zero; omitted row booleans mean false. Inputs are not mutated.
 * With no pips, basics/targets/shares remain zero (remainingBasics is still reported).
 */
export function allocateMana(total, pips, existing = []) {
  validateInteger(total, 0, 40, 'total');
  if (!isRecord(pips)) throw new TypeError('pips must be a plain record');
  if (Reflect.ownKeys(pips).some(id => !ID_SET.has(id))) {
    throw new RangeError('pips contains an unknown mana type');
  }
  const weights = zeros();
  for (const id of IDS) {
    weights[id] = Object.hasOwn(pips, id) ? pips[id] : 0;
    validateInteger(weights[id], 0, 999, `pips.${id}`);
  }
  if (!Array.isArray(existing) || existing.length > 40) {
    throw new RangeError('existing must be an array of at most 40 rows');
  }

  const basics = zeros();
  const existingSources = zeros();
  const untappedSources = zeros();
  const conditionalSources = zeros();
  const targets = zeros();
  const shares = zeros();
  let existingCount = 0;
  for (const row of existing) {
    if (!isRecord(row) || Reflect.ownKeys(row).some(key => !ROW_KEYS.has(key))
      || !Object.hasOwn(row, 'quantity') || !Number.isInteger(row.quantity)
      || row.quantity < 1 || row.quantity > 40
      || !Object.hasOwn(row, 'produces') || !Array.isArray(row.produces)
      || row.produces.some(id => !ID_SET.has(id))
      || new Set(row.produces).size !== row.produces.length
      || (Object.hasOwn(row, 'tapped') && typeof row.tapped !== 'boolean')
      || (Object.hasOwn(row, 'conditional') && typeof row.conditional !== 'boolean')) {
      throw new RangeError('invalid existing land row');
    }
    // for...of also catches sparse produces arrays, which Array#some skips.
    for (const id of row.produces) {
      if (!ID_SET.has(id)) throw new RangeError('unknown existing source mana type');
    }
    existingCount += row.quantity;
    if (existingCount > total) throw new RangeError('existing quantity exceeds total');
    for (const id of row.produces) {
      if (row.conditional) conditionalSources[id] += row.quantity;
      else {
        existingSources[id] += row.quantity;
        if (!row.tapped) untappedSources[id] += row.quantity;
      }
    }
  }

  const remainingBasics = total - existingCount;
  const totalPips = IDS.reduce((sum, id) => sum + weights[id], 0);
  const sources = { ...existingSources };
  if (totalPips > 0) {
    const active = IDS.filter(id => weights[id] > 0);
    const sourceBudget = remainingBasics + active.reduce((sum, id) => sum + existingSources[id], 0);
    for (const id of active) {
      shares[id] = weights[id] / totalPips;
      targets[id] = sourceBudget * weights[id] / totalPips;
    }
    for (let slot = 0; slot < remainingBasics; slot += 1) {
      let best;
      let bestCost = Infinity;
      for (const id of active) {
        // totalPips * ((s + 1 - target)^2 - (s - target)^2).
        // Integer comparisons avoid floating-point tie errors; limits stay < 2^53.
        const cost = (2 * sources[id] + 1) * totalPips - 2 * sourceBudget * weights[id];
        if (cost < bestCost || (cost === bestCost && weights[id] > weights[best])) {
          best = id;
          bestCost = cost;
        }
      }
      basics[best] += 1;
      sources[best] += 1;
      untappedSources[best] += 1;
    }
  }
  return {
    total, existingCount, remainingBasics, totalPips, hasPips: totalPips > 0,
    basics, sources, existingSources, untappedSources, conditionalSources, targets, shares,
  };
}
