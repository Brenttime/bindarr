const { sqlCardKey } = require('./cardIdentity');

// Decks deliberately keep one representative printing id per logical card. A
// replacement-cost floor must ignore that representative and instead use the
// cheapest positive USD quote across every cached physical printing/finish with
// the same canonical name. We do not mix currencies without an exchange-rate
// source. Cards with no USD quote are counted separately so the UI can show a
// truthful lower bound ("$12.34+") instead of silently pricing them at zero.
async function getDeckMinimumValues(client, deckIds) {
  const ids = Array.from(new Set((deckIds || [])
    .map(id => Number(id))
    .filter(Number.isSafeInteger)));
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await client.all(`
    WITH deck_requirements AS (
      SELECT
        dc.deck_id,
        CASE
          WHEN deck_cc.id IS NULL THEN 'missing:' || dc.card_id
          ELSE ${sqlCardKey('deck_cc')}
        END AS card_key,
        SUM(dc.quantity) AS quantity
      FROM deck_cards dc
      LEFT JOIN card_cache deck_cc ON deck_cc.id = dc.card_id
      WHERE dc.deck_id IN (${placeholders})
        AND dc.quantity > 0
      GROUP BY dc.deck_id, card_key
    ),
    price_candidates AS (
      SELECT ${sqlCardKey('priced_cc')} AS card_key, priced_cc.price_normal AS price
      FROM card_cache priced_cc
      WHERE UPPER(COALESCE(priced_cc.price_currency, 'USD')) = 'USD'
        AND priced_cc.price_normal > 0
      UNION ALL
      SELECT ${sqlCardKey('priced_cc')} AS card_key, priced_cc.price_holofoil AS price
      FROM card_cache priced_cc
      WHERE UPPER(COALESCE(priced_cc.price_currency, 'USD')) = 'USD'
        AND priced_cc.price_holofoil > 0
      UNION ALL
      SELECT ${sqlCardKey('priced_cc')} AS card_key, priced_cc.price_trend AS price
      FROM card_cache priced_cc
      WHERE UPPER(COALESCE(priced_cc.price_currency, 'USD')) = 'USD'
        AND priced_cc.price_trend > 0
    ),
    cheapest_prices AS (
      SELECT card_key, MIN(price) AS price
      FROM price_candidates
      WHERE card_key <> ''
      GROUP BY card_key
    )
    SELECT
      requirements.deck_id,
      ROUND(COALESCE(SUM(
        CASE WHEN cheapest.price IS NOT NULL
          THEN requirements.quantity * cheapest.price
          ELSE 0
        END
      ), 0), 2) AS minimum_value,
      COALESCE(SUM(
        CASE WHEN cheapest.price IS NULL THEN requirements.quantity ELSE 0 END
      ), 0) AS unpriced_cards,
      COALESCE(SUM(
        CASE WHEN cheapest.price IS NULL THEN 1 ELSE 0 END
      ), 0) AS unpriced_card_types
    FROM deck_requirements requirements
    LEFT JOIN cheapest_prices cheapest ON cheapest.card_key = requirements.card_key
    GROUP BY requirements.deck_id
  `, ids);

  return new Map(rows.map(row => [Number(row.deck_id), {
    minimum_value: Number(row.minimum_value) || 0,
    minimum_value_currency: 'USD',
    unpriced_cards: Number(row.unpriced_cards) || 0,
    unpriced_card_types: Number(row.unpriced_card_types) || 0,
  }]));
}

function emptyDeckMinimumValue() {
  return {
    minimum_value: 0,
    minimum_value_currency: 'USD',
    unpriced_cards: 0,
    unpriced_card_types: 0,
  };
}

module.exports = { getDeckMinimumValues, emptyDeckMinimumValue };
