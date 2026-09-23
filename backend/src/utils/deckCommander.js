// The commander behind a deck's art in the deck list. One grouped query over
// every card of a user's decks: the per-deck correlated shape that once made
// the deck list slow (a card_cache rescan per deck) is what this avoids.
//
// Candidate rule: the printed type line is stored split into words, so the
// supertype word and the card type are looked for in the union of the subtypes
// and types JSON blobs. The ambient-text commander variants (Companion, Mate,
// Mandate, Council's resolve, Carriage, Agent) print no supertype at all, so
// their lone subtype word also makes a candidate.
//
// color_identity rows mix Scryfall letters and the display names newer
// scryfallApi writes; both spellings fold to a letter here.

// JSON arrays store each word as a double-quoted string, so a word match is a
// quoted-word substring search: build the SQL literal from the plain word.
const quotedWord = (word) => `'` + `"${word}"` + `'`;
const wordMatch = (word) => `INSTR(kind_json, ${quotedWord(word)})`;

const COMMANDER_PER_DECK_SQL = `
  WITH deck_rows AS (
    SELECT
      d.id                          AS deck_id,
      dc.card_id,
      COALESCE(dc.quantity, 0)      AS quantity,
      COALESCE(dc.is_commander, 0)  AS is_commander,
      cc.name,
      NULLIF(cc.image_url, '')      AS image_url,
      COALESCE(cc.cmc, 0)           AS cmc,
      CASE WHEN json_valid(COALESCE(cc.color_identity, '[]'))
           THEN COALESCE(cc.color_identity, '[]') ELSE '[]' END AS ci_json,
      LOWER(COALESCE(cc.types, '[]') || COALESCE(cc.subtypes, '[]')) AS kind_json
    FROM decks d
    JOIN deck_cards dc ON dc.deck_id = d.id
    JOIN card_cache cc ON cc.id = dc.card_id
    WHERE d.user_id = ?
  ),
  row_colors AS (
    SELECT DISTINCT
      deck_id,
      card_id,
      CASE UPPER(je.value)
        WHEN 'W' THEN 'W' WHEN 'WHITE' THEN 'W'
        WHEN 'U' THEN 'U' WHEN 'BLUE'  THEN 'U'
        WHEN 'B' THEN 'B' WHEN 'BLACK' THEN 'B'
        WHEN 'R' THEN 'R' WHEN 'RED'   THEN 'R'
        WHEN 'G' THEN 'G' WHEN 'GREEN' THEN 'G'
      END AS letter
    FROM deck_rows
    CROSS JOIN json_each(deck_rows.ci_json) je
  ),
  deck_colors AS (
    -- A deck's color identity is the union of its cards' identities.
    SELECT DISTINCT deck_id, letter FROM row_colors WHERE letter IS NOT NULL
  ),
  candidates AS (
    SELECT *
    FROM deck_rows
    WHERE is_commander = 1
       OR (${wordMatch('legendary')} > 0 AND ${wordMatch('creature')} > 0)
       OR ${wordMatch('companion')} > 0
       OR ${wordMatch('mate')}      > 0
       OR ${wordMatch('mandate')}   > 0
       OR ${wordMatch('council')}   > 0
       OR ${wordMatch('carriage')}  > 0
       OR ${wordMatch('agent')}     > 0
  ),
  overlap AS (
    -- How much of the candidate's identity the deck actually plays.
    SELECT c.deck_id, c.card_id, COUNT(DISTINCT rc.letter) AS color_overlap
    FROM candidates c
    JOIN row_colors  rc  ON rc.deck_id  = c.deck_id AND rc.card_id  = c.card_id
    JOIN deck_colors dc2 ON dc2.deck_id = c.deck_id AND dc2.letter  = rc.letter
    GROUP BY c.deck_id, c.card_id
  ),
  ranked AS (
    SELECT
      c.deck_id,
      c.card_id   AS commander_card_id,
      c.name      AS commander_name,
      c.image_url AS commander_image_url,
      ROW_NUMBER() OVER (
        PARTITION BY c.deck_id
        -- An in-play commander outranks an identical zero-quantity row; the
        -- deck list still wants its art when the build is only sold-down.
        -- A declared commander (Moxfield commanders board, precon commander)
        -- beats any guess.
        ORDER BY c.is_commander DESC,
                 CASE WHEN c.quantity > 0 THEN 0 ELSE 1 END,
                 COALESCE(o.color_overlap, 0) DESC,
                 c.quantity DESC,
                 c.cmc,
                 c.name,
                 c.card_id
      ) AS rn
    FROM candidates c
    LEFT JOIN overlap o ON o.deck_id = c.deck_id AND o.card_id = c.card_id
  )
  SELECT deck_id, commander_card_id, commander_name, commander_image_url
  FROM ranked
  WHERE rn = 1
`;

// Returns Map<deck_id, {commander_card_id, commander_name, commander_image_url}>.
// A deck with no commander-shaped card has no entry; image_url is null when the
// commander's cache row has no art.
async function getDeckCommanders(client, userId) {
  const rows = await client.all(COMMANDER_PER_DECK_SQL, [userId]);
  return new Map(rows.map(row => [Number(row.deck_id), row]));
}

module.exports = { getDeckCommanders };
