const { sqlCardKey } = require('./cardIdentity');

const QUERY_CHUNK_SIZE = 500;
const PRICE_FIELDS = ['price_normal', 'price_holofoil', 'price_etched', 'price_trend'];

function chunked(values, size = QUERY_CHUNK_SIZE) {
  const chunks = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function cheapestEligiblePrice(row) {
  let cheapest = null;
  for (const field of PRICE_FIELDS) {
    const value = Number(row[field]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (cheapest === null || value < cheapest) cheapest = value;
  }
  return cheapest;
}

async function getDeckRequirements(client, deckIds) {
  const requirements = [];
  for (const ids of chunked(deckIds)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await client.all(`
      SELECT
        dc.deck_id,
        COALESCE(NULLIF(${sqlCardKey('deck_cc')}, ''), 'missing:' || dc.card_id) AS card_key,
        SUM(dc.quantity) AS quantity
      FROM deck_cards dc
      LEFT JOIN card_cache deck_cc ON deck_cc.id = dc.card_id
      WHERE dc.deck_id IN (${placeholders})
        AND dc.quantity > 0
      GROUP BY dc.deck_id, card_key
    `, ids);
    requirements.push(...rows);
  }
  return requirements;
}

async function getCheapestPrices(client, cardKeys) {
  const cheapestByKey = new Map();
  for (const keys of chunked(cardKeys)) {
    const valueRows = keys.map(() => '(?)').join(', ');
    const rows = await client.all(`
      WITH required(card_key) AS (VALUES ${valueRows})
      SELECT
        ${sqlCardKey('priced_cc')} AS card_key,
        priced_cc.price_normal,
        priced_cc.price_holofoil,
        priced_cc.price_etched,
        priced_cc.price_trend
      FROM required
      CROSS JOIN card_cache priced_cc INDEXED BY idx_card_cache_logical_key
      WHERE ${sqlCardKey('priced_cc')} = required.card_key
        AND UPPER(COALESCE(priced_cc.price_currency, 'USD')) = 'USD'
    `, keys);

    for (const row of rows) {
      const candidate = cheapestEligiblePrice(row);
      if (candidate === null) continue;
      const current = cheapestByKey.get(row.card_key);
      if (current === undefined || candidate < current) {
        cheapestByKey.set(row.card_key, candidate);
      }
    }
  }
  return cheapestByKey;
}

async function getDeckMinimumValues(client, deckIds = []) {
  const normalizedDeckIds = [...new Set(deckIds.map(Number).filter(Number.isSafeInteger))];
  const values = new Map(normalizedDeckIds.map(deckId => [deckId, emptyDeckMinimumValue()]));
  if (normalizedDeckIds.length === 0) return values;

  const requirements = await getDeckRequirements(client, normalizedDeckIds);
  const cardKeys = [...new Set(
    requirements
      .map(row => row.card_key)
      .filter(cardKey => cardKey && !cardKey.startsWith('missing:'))
  )];
  const cheapestByKey = await getCheapestPrices(client, cardKeys);

  for (const requirement of requirements) {
    const deckId = Number(requirement.deck_id);
    const quantity = Number(requirement.quantity) || 0;
    const value = values.get(deckId);
    if (!value || quantity <= 0) continue;

    const price = cheapestByKey.get(requirement.card_key);
    if (price === undefined) {
      value.unpriced_cards += quantity;
      value.unpriced_card_types += 1;
    } else {
      value.minimum_value += quantity * price;
    }
  }

  for (const value of values.values()) {
    value.minimum_value = Math.round((value.minimum_value + Number.EPSILON) * 100) / 100;
  }
  return values;
}

function emptyDeckMinimumValue() {
  return {
    minimum_value: 0,
    minimum_value_currency: 'USD',
    unpriced_cards: 0,
    unpriced_card_types: 0,
  };
}

module.exports = {
  getDeckMinimumValues,
  emptyDeckMinimumValue,
};
