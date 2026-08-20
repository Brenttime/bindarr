// Moxfield sync engine: mirrors an author's public Moxfield decks into Bindarr.
//
// Two cadences, driven by moxfieldScheduler.js on its 20s tick:
//
//   syncDecklist(author) — the SLOW job (default: every hour, configurable).
//     Re-validates the author on Moxfield, re-lists their public decks, creates
//     the local mirror deck for anything new (and pulls its contents right
//     away), and retires anything the author deleted.
//
//   runContentSync(author) — the FAST job (default: every minute, configurable).
//     Fetches the author's deck summary list — one request carries every
//     deck's lastUpdatedAtUtc stamp — and compares it against the stamps it
//     last mirrored. A deck whose stamp moved gets its full contents pulled
//     from /v3/decks/all and mirrored onto the local deck. No stamp movement,
//     no network beyond that one summary call: the per-minute check is cheap by
//     construction.
//
// Mapping rule: a Moxfield card's `scryfall_id` is a Scryfall UUID, and
// Bindarr's MTG card id is `mtg-<that same UUID>` — so decks mirror onto
// card_cache directly. No name matching, no printing ambiguity.
//
// Ownership: mirrored decks are owned by the user who added the author, carry
// `source='moxfield'` plus the Moxfield public id, and are reconciled exactly
// on each content pull. Whatever a local user edits on a synced deck is a
// departure the next content sync overwrites — that is the feature: the local
// deck is a live mirror, not a copy. Hand-made decks (source='manual') are
// never touched.
const db = require('./db');
const moxfieldApi = require('./moxfieldApi');
const { bulkFetchByIdentifier, cacheCards } = require('./scryfallApi');
const {
  MIRROR_BOARDS,
  extractDeckCards,
  boardCounts,
  bindarrCardId,
  mfxFormatLabel,
  targetSizeForFormat,
  synthesizeMoxfieldCard
} = require('./utils/mfxPayload');

// ---------------------------------------------------------------------------
// Scryfall backfill for cards not yet in card_cache
// ---------------------------------------------------------------------------

// Moxfield hands us complete card data, but Bindarr's card_cache is what every
// downstream read joins against (art, prices, rarity, marketplace links — and
// the MTG price sweep). For cards we do not already hold, resolve them against
// Scryfall by id — the same batched, queue-limited lookup the import path uses.
//
// Some cards (sealed-product printings like Mystery Booster) have a
// scryfall_id Scryfall does not know: the id lookup 404s for them. Those are
// synthesized into card_cache from Moxfield's own card block so the deck never
// ends up with a dangling reference (price_source='moxfield' marks the row).
async function backfillMissingCards(entries) {
  const ids = [...new Set(entries.map(e => bindarrCardId(e.card)))];
  const missing = [];
  for (const id of ids) {
    const cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [id]);
    if (!cached) missing.push(id);
  }
  if (missing.length === 0) return;

  const { cards, notFound } = await bulkFetchByIdentifier(missing.map(id => ({ id })));
  if (cards.length > 0) await cacheCards(cards);

  // Anything still absent after the batched lookup is a card Scryfall has no
  // record for — synthesize it from the Moxfield payload instead of leaving a
  // dangling deck_card -> card_cache reference.
  const stillMissing = new Set();
  for (const id of missing) {
    const cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [id]);
    if (!cached) stillMissing.add(id);
  }
  if (stillMissing.size > 0) {
    const seen = new Set();
    const synthesized = [];
    for (const e of entries) {
      const id = bindarrCardId(e.card);
      if (stillMissing.has(id) && !seen.has(id)) {
        seen.add(id);
        synthesized.push(synthesizeMoxfieldCard(id, e.card));
      }
    }
    if (synthesized.length > 0) {
      await cacheCards(synthesized);
      console.warn(`Moxfield sync: ${synthesized.length} card(s) unknown to Scryfall — synthesized from Moxfield data: ${synthesized.map(c => c.name).join(', ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Local deck mirroring
// ---------------------------------------------------------------------------

// Create the local mirror deck for a summary (or details-derived summary) if
// one does not already exist. Returns the local deck id.
async function ensureLocalDeck(author, summary) {
  const existing = await db.get(
    `SELECT id FROM decks WHERE user_id = ? AND moxfield_public_id = ?`,
    [author.user_id, summary.publicId]
  );
  if (existing) return existing.id;

  const result = await db.run(
    `INSERT INTO decks (name, description, game, format, category, accent_color, target_size, user_id, source, moxfield_public_id)
     VALUES (?, ?, 'mtg', ?, 'Moxfield Sync', '#22d3ee', ?, ?, 'moxfield', ?)`,
    [
      summary.name || summary.publicId,
      summary.description || '',
      mfxFormatLabel(summary.format),
      targetSizeForFormat(summary.format),
      author.user_id,
      summary.publicId
    ]
  );
  console.log(`Moxfield sync: created local deck #${result.lastID} "${summary.name}" for ${author.moxfield_user}`);
  return result.lastID;
}

// Keep the tracking row for a deck in step with the remote summary, and link
// the local deck to it. Only creates the local mirror when the deck is
// enabled — an unchecked deck is tracked (so re-enabling is instant) but
// never imported.
async function upsertTrackingRow(author, summary, { enabled = true } = {}) {
  await db.run(
    `INSERT INTO moxfield_decks
       (author_id, public_id, name, format, mainboard_count, sideboard_count, maybeboard_count, commander_count, last_updated_at, bindarr_deck_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(author_id, public_id) DO UPDATE SET
       name = excluded.name,
       format = excluded.format,
       mainboard_count = excluded.mainboard_count,
       sideboard_count = excluded.sideboard_count,
       maybeboard_count = excluded.maybeboard_count,
       last_updated_at = excluded.last_updated_at,
       bindarr_deck_id = COALESCE(excluded.bindarr_deck_id, moxfield_decks.bindarr_deck_id)`,
    [
      author.id,
      summary.publicId,
      summary.name || summary.publicId,
      summary.format || null,
      summary.mainboardCount != null ? parseInt(summary.mainboardCount, 10) : null,
      summary.sideboardCount != null ? parseInt(summary.sideboardCount, 10) : null,
      summary.maybeboardCount != null ? parseInt(summary.maybeboardCount, 10) : null,
      null,
      summary.lastUpdatedAtUtc || null
    ]
  );
  const row = await db.get(`SELECT * FROM moxfield_decks WHERE author_id = ? AND public_id = ?`,
    [author.id, summary.publicId]);
  if (!row.bindarr_deck_id && enabled) {
    const deckId = await ensureLocalDeck(author, summary);
    await db.run(`UPDATE moxfield_decks SET bindarr_deck_id = ? WHERE id = ?`, [deckId, row.id]);
    row.bindarr_deck_id = deckId;
  }
  // Renames on Moxfield propagate to the mirror.
  await db.run(
    `UPDATE decks SET name = ?, description = ? WHERE id = ? AND moxfield_public_id = ? AND source = 'moxfield'`,
    [summary.name || summary.publicId, summary.description || '', row.bindarr_deck_id, summary.publicId]
  );
  return row;
}

// Retire a tracked deck: drop the local mirror and its tracking row. Cards stay
// in card_cache (they may be referenced by other decks and by price history).
async function retireDeck(author, publicId) {
  const row = await db.get(`SELECT bindarr_deck_id FROM moxfield_decks WHERE author_id = ? AND public_id = ?`,
    [author.id, publicId]);
  if (!row) return false;
  if (row.bindarr_deck_id) {
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [row.bindarr_deck_id]);
    await db.run(`DELETE FROM decks WHERE id = ? AND source = 'moxfield'`, [row.bindarr_deck_id]);
  }
  await db.run(`DELETE FROM moxfield_decks WHERE author_id = ? AND public_id = ?`, [author.id, publicId]);
  console.log(`Moxfield sync: retired deck "${publicId}" (removed on Moxfield)`);
  return true;
}

// ---------------------------------------------------------------------------
// Decklist sync (the slow job)
// ---------------------------------------------------------------------------

// Re-validate the author on Moxfield and reconcile the list of tracked decks:
// create mirrors for new decks (and pull their contents immediately), retire
// deleted ones, refresh the stamp on every tracked row.
async function syncDecklist(authorId, { user } = {}) {
  const author = await db.get(`SELECT * FROM moxfield_authors WHERE id = ?`, [authorId]);
  if (!author) throw new Error('Moxfield author not found');

  // Resolve the canonical username (and pick up profile name changes).
  const userInfo = await moxfieldApi.getUser(author.moxfield_user);
  await db.run(`UPDATE moxfield_authors SET display_name = ?, profile_image_url = ?, last_error = NULL WHERE id = ?`,
    [userInfo.displayName, userInfo.profileImageUrl, author.id]);

  const summaries = await moxfieldApi.getAuthorDeckSummaries(userInfo.userName);
  let created = 0;
  let kept = 0;

  for (const summary of summaries) {
    if (!summary.publicId) continue;
    const wasTracked = await db.get(`SELECT id, enabled FROM moxfield_decks WHERE author_id = ? AND public_id = ?`,
      [author.id, summary.publicId]);
    const enabled = wasTracked ? wasTracked.enabled !== 0 : true;
    await upsertTrackingRow(author, summary, { enabled });
    if (wasTracked) {
      kept += 1;
    } else if (enabled) {
      created += 1;
      // Brand-new mirror: pull its contents right away rather than waiting for
      // the fast job to notice the unsynced stamp.
      try {
        await pullDeckContent(author, summary.publicId);
      } catch (err) {
        console.warn(`Moxfield sync: initial content pull for "${summary.name}" failed: ${err.message}`);
        await db.run(`UPDATE moxfield_decks SET last_error = ? WHERE author_id = ? AND public_id = ?`,
          [err.message, author.id, summary.publicId]);
      }
    }
  }

  // Decks that vanished on Moxfield.
  let removed = 0;
  const tracked = await db.all(`SELECT public_id FROM moxfield_decks WHERE author_id = ?`, [author.id]);
  const remoteIds = new Set(summaries.map(s => s.publicId));
  for (const row of tracked) {
    if (!remoteIds.has(row.public_id)) {
      if (await retireDeck(author, row.public_id)) removed += 1;
    }
  }

  await db.run(`UPDATE moxfield_authors SET last_decklist_sync_at = CURRENT_TIMESTAMP WHERE id = ?`, [author.id]);
  return {
    ok: true,
    author: userInfo.userName,
    decks_on_moxfield: summaries.length,
    decks_created: created,
    decks_kept: kept,
    decks_removed: removed
  };
}

// ---------------------------------------------------------------------------
// Content sync (the fast job)
// ---------------------------------------------------------------------------

// The per-minute check for one author. One summary call carries every deck's
// lastUpdatedAtUtc; each tracked deck whose stamp moved (or has never been
// mirrored) gets its full contents pulled and mirrored. Decks that vanished
// are retired. When nothing changed, this job made exactly ONE Moxfield
// request and touched only its own tracking rows.
async function runContentSync(authorId, { user } = {}) {
  const author = await db.get(`SELECT * FROM moxfield_authors WHERE id = ?`, [authorId]);
  if (!author) throw new Error('Moxfield author not found');
  // No ENABLED tracked decks yet (author just added, decklist sync pending, or
  // every deck unchecked): nothing to check. Unchecked decks cost no Moxfield
  // requests.
  const haveDecks = await db.get(`SELECT COUNT(*) AS c FROM moxfield_decks WHERE author_id = ? AND enabled = 1`, [author.id]);
  if (!haveDecks || haveDecks.c === 0) return { ok: true, checked: 0, updated: 0, skipped: 0 };

  const summaries = await moxfieldApi.getAuthorDeckSummaries(author.moxfield_user);
  const byPublicId = new Map(summaries.map(s => [s.publicId, s]));
  const tracked = await db.all(`SELECT * FROM moxfield_decks WHERE author_id = ?`, [author.id]);

  let updated = 0;
  let removed = 0;
  let skipped = 0;
  for (const row of tracked) {
    const summary = byPublicId.get(row.public_id);
    if (!summary) {
      if (await retireDeck(author, row.public_id)) removed += 1;
      continue;
    }
    // Unchecked deck: keep its listing row fresh (name, counts, remote stamp)
    // but never pull contents or create a mirror.
    if (row.enabled === 0) {
      skipped += 1;
      await db.run(
        `UPDATE moxfield_decks SET last_updated_at = ?, name = ?, format = ?,
                mainboard_count = ?, sideboard_count = ?, maybeboard_count = ?
         WHERE id = ?`,
        [
          summary.lastUpdatedAtUtc || null,
          summary.name || row.name,
          summary.format || row.format,
          summary.mainboardCount != null ? parseInt(summary.mainboardCount, 10) : null,
          summary.sideboardCount != null ? parseInt(summary.sideboardCount, 10) : null,
          summary.maybeboardCount != null ? parseInt(summary.maybeboardCount, 10) : null,
          row.id
        ]
      );
      continue;
    }
    // Stamp moved since we last mirrored this deck (or never mirrored it).
    const stamp = summary.lastUpdatedAtUtc || null;
    const needsPull = !row.last_synced_updated_at || stamp !== row.last_synced_updated_at;
    if (needsPull) {
      try {
        await pullDeckContent(author, row.public_id, row);
        updated += 1;
      } catch (err) {
        console.warn(`Moxfield sync: content pull failed for "${row.name}": ${err.message}`);
        await db.run(`UPDATE moxfield_decks SET last_error = ? WHERE id = ?`, [err.message, row.id]);
      }
    }
    // Refresh the stored stamp (and the summary fields) even when no pull
    // happened, so the decklist job's view stays in step.
    await db.run(
      `UPDATE moxfield_decks SET last_updated_at = ?, name = ?, format = ?,
              mainboard_count = ?, sideboard_count = ?, maybeboard_count = ?
       WHERE id = ?`,
      [
        stamp,
        summary.name || row.name,
        summary.format || row.format,
        summary.mainboardCount != null ? parseInt(summary.mainboardCount, 10) : null,
        summary.sideboardCount != null ? parseInt(summary.sideboardCount, 10) : null,
        summary.maybeboardCount != null ? parseInt(summary.maybeboardCount, 10) : null,
        row.id
      ]
    );
  }

  // Mark that we did a check just now, whether or not anything moved — the
  // author-level "last content check" timestamp is what tells a person the
  // per-minute job is alive. (Per-deck last_content_sync_at only advances on
  // an actual pull.)
  await db.run(`UPDATE moxfield_authors SET last_content_check_at = CURRENT_TIMESTAMP WHERE id = ?`, [author.id]);

  return { ok: true, checked: tracked.length, updated, removed, skipped };
}

// Pull one deck's full contents from Moxfield and mirror onto the local deck.
async function pullDeckContent(author, publicId, knownRow = null) {
  const row = knownRow || await db.get(`SELECT * FROM moxfield_decks WHERE author_id = ? AND public_id = ?`,
    [author.id, publicId]);
  if (!row) throw new Error(`Deck ${publicId} is not tracked for ${author.moxfield_user}`);

  const details = await moxfieldApi.getDeckDetails(publicId);
  const entries = extractDeckCards(details);
  const targetDeckId = row.bindarr_deck_id || await ensureLocalDeck(author, {
    publicId,
    name: details.name || row.name,
    description: details.description || '',
    format: details.format || row.format
  });
  if (!row.bindarr_deck_id) {
    await db.run(`UPDATE moxfield_decks SET bindarr_deck_id = ? WHERE id = ?`, [targetDeckId, row.id]);
  }

  // 1. Backfill any cards not in card_cache yet (Scryfall, batched + rate-limited).
  await backfillMissingCards(entries);

  // 2. Reconcile quantities exactly: drop what left the deck, upsert the rest.
  //    (A card that stays keeps its row — and any checked_out state on it.)
  const desired = new Map(); // card_id -> quantity
  for (const e of entries) {
    const id = bindarrCardId(e.card);
    desired.set(id, (desired.get(id) || 0) + e.quantity);
  }
  const current = await db.all(`SELECT card_id FROM deck_cards WHERE deck_id = ?`, [targetDeckId]);
  for (const c of current) {
    if (!desired.has(c.card_id)) {
      await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [targetDeckId, c.card_id]);
    }
  }
  for (const [cardId, quantity] of desired) {
    await db.run(
      `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
       ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
      [targetDeckId, cardId, quantity]
    );
  }

  // 3. Refresh the tracking row: the stamp we just mirrored is now "current".
  const stamp = details.lastUpdatedAtUtc || null;
  await db.run(
    `UPDATE moxfield_decks SET
        last_synced_updated_at = ?, last_content_sync_at = CURRENT_TIMESTAMP, last_error = NULL,
        name = ?, format = ?,
        mainboard_count = ?, sideboard_count = ?, maybeboard_count = ?, commander_count = ?
     WHERE id = ?`,
    [
      stamp,
      details.name || row.name,
      details.format || row.format,
      details.boards && details.boards.mainboard ? details.boards.mainboard.count : null,
      details.boards && details.boards.sideboard ? details.boards.sideboard.count : null,
      details.boards && details.boards.maybeboard ? details.boards.maybeboard.count : null,
      details.boards && details.boards.commanders ? details.boards.commanders.count : null,
      row.id
    ]
  );
  // Name drift between the summary list and the details payload.
  if (details.name) {
    await db.run(`UPDATE decks SET name = ? WHERE id = ? AND source = 'moxfield'`, [details.name, targetDeckId]);
  }

  const counts = boardCounts(entries);
  return {
    ok: true,
    public_id: publicId,
    deck: details.name || row.name,
    mainboard: counts.mainboard,
    sideboard: counts.sideboard,
    commanders: counts.commanders
  };
}

// Flip one deck's import switch. Disabling removes the local mirror (and its
// card quantities) but keeps the tracking row — the deck stays listed in the
// UI and re-enabling re-imports it on the next content check, with no state to
// reconstruct. Enabling works even for a deck that has never been imported.
async function setDeckEnabled(userId, publicId, enabled) {
  const row = await db.get(
    `SELECT md.*, a.moxfield_user AS author_user
     FROM moxfield_decks md
     JOIN moxfield_authors a ON a.id = md.author_id
     WHERE md.public_id = ? AND a.user_id = ?`,
    [publicId, userId]
  );
  if (!row) throw new Error('Moxfield deck not found for this user');

  if (enabled) {
    await db.run(`UPDATE moxfield_decks SET enabled = 1, last_error = NULL WHERE id = ?`, [row.id]);
    // Imported already: just re-armed. Not imported yet (or re-imported after
    // a disable): pull it now so the user sees the result immediately instead
    // of on the next clock.
    if (row.bindarr_deck_id) {
      return { ok: true, enabled: true, imported: true };
    }
    const author = await db.get(`SELECT * FROM moxfield_authors WHERE id = ?`, [row.author_id]);
    try {
      await pullDeckContent(author, publicId, row);
    } catch (err) {
      await db.run(`UPDATE moxfield_decks SET last_error = ? WHERE id = ?`, [err.message, row.id]);
    }
    const fresh = await db.get(`SELECT bindarr_deck_id FROM moxfield_decks WHERE id = ?`, [row.id]);
    return { ok: true, enabled: true, imported: !!fresh.bindarr_deck_id };
  }

  if (row.bindarr_deck_id) {
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [row.bindarr_deck_id]);
    await db.run(`DELETE FROM decks WHERE id = ? AND source = 'moxfield'`, [row.bindarr_deck_id]);
    await db.run(`UPDATE moxfield_decks SET enabled = 0, bindarr_deck_id = NULL, last_synced_updated_at = NULL, last_error = NULL WHERE id = ?`, [row.id]);
  } else {
    await db.run(`UPDATE moxfield_decks SET enabled = 0, last_error = NULL WHERE id = ?`, [row.id]);
  }
  console.log(`Moxfield sync: deck "${row.name}" import disabled (mirror removed)`);
  return { ok: true, enabled: false };
}

// Re-pull one specific deck's contents for a user, regardless of its stamp.
// Finds the tracking row under that user's authors (a public id belongs to one
// author on Moxfield, so this is unique once found).
async function pullDeckContentByPublicId(userId, publicId) {
  const row = await db.get(
    `SELECT md.* FROM moxfield_decks md
     JOIN moxfield_authors a ON a.id = md.author_id
     WHERE md.public_id = ? AND a.user_id = ?`,
    [publicId, userId]
  );
  if (!row) throw new Error('Moxfield deck not found for this user');
  const author = await db.get(`SELECT * FROM moxfield_authors WHERE id = ?`, [row.author_id]);
  return pullDeckContent(author, publicId, row);
}

// ---------------------------------------------------------------------------
// Author management
// ---------------------------------------------------------------------------

// Track a new Moxfield author for this user, then run the first decklist sync
// so the decks appear immediately.
async function addAuthor(userId, username) {
  const clean = String(username || '').trim();
  if (!clean) throw new Error('Moxfield username is required');
  // Validate up-front so the UI gets a real 404 instead of a silently-broken row.
  const userInfo = await moxfieldApi.getUser(clean);
  const existing = await db.get(
    `SELECT id FROM moxfield_authors WHERE user_id = ? AND LOWER(moxfield_user) = LOWER(?)`,
    [userId, userInfo.userName]
  );
  if (existing) {
    const report = await syncDecklist(existing.id, { user: { id: userId } });
    return { author: existing.id, already_tracked: true, ...report };
  }
  const result = await db.run(
    `INSERT INTO moxfield_authors (user_id, moxfield_user, display_name, profile_image_url) VALUES (?, ?, ?, ?)`,
    [userId, userInfo.userName, userInfo.displayName, userInfo.profileImageUrl]
  );
  const report = await syncDecklist(result.lastID, { user: { id: userId } });
  return { author: result.lastID, ...report };
}

// Stop tracking an author: remove every mirrored deck this account produced.
async function removeAuthor(userId, authorId) {
  const author = await db.get(`SELECT * FROM moxfield_authors WHERE id = ? AND user_id = ?`, [authorId, userId]);
  if (!author) throw new Error('Moxfield author not found');
  const tracked = await db.all(`SELECT bindarr_deck_id FROM moxfield_decks WHERE author_id = ?`, [author.id]);
  for (const row of tracked) {
    if (row.bindarr_deck_id) {
      await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [row.bindarr_deck_id]);
      await db.run(`DELETE FROM decks WHERE id = ? AND source = 'moxfield'`, [row.bindarr_deck_id]);
    }
  }
  // CASCADE removes the moxfield_decks rows.
  await db.run(`DELETE FROM moxfield_authors WHERE id = ?`, [author.id]);
  return { ok: true, removed_decks: tracked.filter(r => r.bindarr_deck_id).length };
}

// Status for the UI: every author this user tracks, with per-deck freshness.
async function getStatus(userId) {
  const authors = await db.all(
    `SELECT a.id, a.moxfield_user, a.display_name, a.profile_image_url,
            a.last_decklist_sync_at, a.last_content_check_at, a.last_error, a.created_at
     FROM moxfield_authors a WHERE a.user_id = ? ORDER BY a.created_at DESC`,
    [userId]
  );
  for (const a of authors) {
    // The aggregate describes what is actually being synced; unchecked decks
    // are shown in the deck list but don't count against the "up to date" bar.
    const agg = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_synced_updated_at IS NOT NULL AND last_synced_updated_at = last_updated_at THEN 1 ELSE 0 END) AS current,
              SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS with_errors,
              MAX(last_content_sync_at) AS last_content_sync
       FROM moxfield_decks WHERE author_id = ? AND enabled = 1`,
      [a.id]
    );
    a.total_decks = agg ? agg.total : 0;
    a.current_decks = agg && agg.current ? agg.current : 0;
    a.error_decks = agg && agg.with_errors ? agg.with_errors : 0;
    a.last_content_sync = agg ? agg.last_content_sync : null;
    a.tracked_decks = (await db.get(
      `SELECT COUNT(*) AS c FROM moxfield_decks WHERE author_id = ?`, [a.id]
    ) || { c: 0 }).c;

    const decks = await db.all(
      `SELECT md.public_id, md.name, md.format, md.mainboard_count, md.sideboard_count,
              md.last_updated_at, md.last_synced_updated_at, md.last_content_sync_at, md.last_error,
              md.enabled
       FROM moxfield_decks md WHERE md.author_id = ? ORDER BY md.last_updated_at DESC`,
      [a.id]
    );
    a.decks = decks.map(d => ({
      ...d,
      enabled: d.enabled !== 0,
      current: !!(d.last_synced_updated_at && d.last_synced_updated_at === d.last_updated_at)
    }));
  }
  return { authors };
}

module.exports = {
  addAuthor,
  removeAuthor,
  getStatus,
  syncDecklist,
  runContentSync,
  setDeckEnabled,
  pullDeckContent,
  pullDeckContentByPublicId,
  // Re-exported from utils/mfxPayload so callers can import everything from one place.
  extractDeckCards,
  boardCounts,
  bindarrCardId,
  mfxFormatLabel,
  targetSizeForFormat,
  MIRROR_BOARDS
};
