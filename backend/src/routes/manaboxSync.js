// ManaBox sync (Settings -> Sync from ManaBox).
//
//   POST /api/manabox-sync/preview  {csv}  -> plan summary + report (changes nothing)
//   POST /api/manabox-sync/apply    {csv, includeLists} -> applies in one transaction
//   GET  /api/manabox-sync/runs            -> past runs (summary)
//   GET  /api/manabox-sync/runs/:id/report -> markdown record of one run
//
// Planning rules live in utils/manaboxSync.js. Apply re-plans from the same CSV
// against the collection as it is now, so a preview that went stale can never
// be applied blindly.
const express = require('express');
const db = require('../db');
const { bulkFetchByIdentifier, cacheCards } = require('../scryfallApi');
const { parseManaboxExport, identityMismatch, planCollection, planLists } = require('../utils/manaboxSync');

const router = express.Router();

async function cardsById(ids) {
  const out = new Map();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const rows = await db.all(
      `SELECT id, name, printed_name, set_id, number FROM card_cache WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const r of rows) out.set(r.id, r);
  }
  const missing = list.filter(id => !out.has(id));
  if (missing.length) {
    const { cards } = await bulkFetchByIdentifier(missing.map(id => ({ id })));
    if (cards.length) await cacheCards(cards);
    for (const c of cards) out.set(c.id, { id: c.id, name: c.name, printed_name: c.printed_name, set_id: c.set_id, number: c.number });
  }
  return out;
}

async function buildPlan(userId, csv, includeLists) {
  const parsed = parseManaboxExport(csv);
  if (parsed.error) return { error: parsed.error };
  const listEntries = [...parsed.lists.values()].flatMap(m => [...m.values()]);
  const cards = await cardsById([...parsed.owned.map(o => o.card_id), ...listEntries.map(e => e.card_id)]);

  // Every printing must agree with the CSV's set, collector number and name.
  const rejected = [...parsed.errors];
  const owned = parsed.owned.filter(o => {
    const why = identityMismatch(o.expect, cards.get(o.card_id));
    if (why) rejected.push({ name: o.expect.name, reason: why, quantity: o.quantity });
    return !why;
  });
  for (const [name, m] of parsed.lists) {
    for (const [id, e] of m) {
      const why = identityMismatch(e.expect, cards.get(id));
      if (why) { rejected.push({ name: e.expect.name, reason: `${why} (list ${name})` }); m.delete(id); }
    }
  }

  const rows = await db.all(
    `SELECT id, card_id, quantity, printing, condition, language, added_at, source FROM collection WHERE user_id = ?`, [userId]);
  const coll = planCollection(rows, owned);

  let lists = { create: [], update: [], skipped: [] };
  if (includeLists) {
    const ls = await db.all(`SELECT id, name, source FROM card_lists WHERE user_id = ?`, [userId]);
    for (const l of ls) {
      l.cards = new Map((await db.all(`SELECT card_id, quantity FROM list_cards WHERE list_id = ?`, [l.id])).map(r => [r.card_id, r.quantity]));
    }
    lists = planLists(ls, parsed.lists);
  }

  const before = rows.reduce((s, r) => s + r.quantity, 0);
  const removed = coll.remove.reduce((s, r) => s + r.quantity, 0);
  const summary = {
    csvRows: parsed.rows,
    owned: owned.reduce((s, o) => s + o.quantity, 0),
    before, after: before - removed + coll.add.length,
    add: coll.add.length, remove: removed, redate: coll.redate.length,
    handAdded: rows.filter(r => r.source !== 'manabox').length,
    listsCreate: lists.create.length, listsUpdate: lists.update.length, listsSkipped: lists.skipped,
    rejected: rejected.length,
  };
  return { summary, coll, lists, rejected, cards, rows };
}

function report(plan, { applied, fileName }) {
  const { summary: s, coll, lists, rejected, cards } = plan;
  const nm = id => { const c = cards.get(id); return c ? `${c.name} | ${String(c.set_id).toUpperCase()} ${c.number}` : `${id} | ?`; };
  const L = [
    `# ManaBox sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC (${applied ? 'APPLIED' : 'PREVIEW - nothing changed'})`, '',
    `- File: ${fileName || 'ManaBox export'} (${s.csvRows} rows, ${s.owned} owned copies)`,
    `- Collection: ${s.before} -> ${s.after} copies`,
    `- Added: **${s.add}**, removed: **${s.remove}**, dates set from ManaBox: ${s.redate}`,
    `- Kept untouched: ${s.handAdded} rows added in Scrybox itself`,
    `- Lists created: ${s.listsCreate}, updated: ${s.listsUpdate}${s.listsSkipped.length ? `, skipped (a Scrybox list already has the name): ${s.listsSkipped.join(', ')}` : ''}`,
    `- Rejected rows (set/number/name did not match the Scryfall ID, or unreadable): ${s.rejected}`, '',
    '## Removed', '', 'Row | Card | Set # | Printing | Condition | Language | Added', '---|---|---|---|---|---|---',
    ...coll.remove.map(r => `${r.id} | ${nm(r.card_id)} | ${r.printing} | ${r.condition} | ${r.language} | ${String(r.added_at).slice(0, 10)}`),
    '', '## Added', '', 'Card | Set # | Printing | Condition | Language | ManaBox added', '---|---|---|---|---|---',
    ...coll.add.map(a => `${nm(a.card_id)} | ${a.printing} | ${a.condition} | ${a.language} | ${String(a.added_at || '').slice(0, 10)}`),
    '', '## Lists', '',
    ...lists.create.map(l => `- Created **${l.name}** (${l.cards.reduce((n, c) => n + c.quantity, 0)} cards)`),
    ...lists.update.map(l => `- Updated **${l.name}** to ${l.cards.reduce((n, c) => n + c.quantity, 0)} cards`),
    '', '## Rejected', '',
    ...rejected.map(r => `- ${r.line ? `line ${r.line}: ` : ''}${r.name}: ${r.reason}`),
  ];
  return L.join('\n') + '\n';
}

router.post('/preview', async (req, res) => {
  try {
    const plan = await buildPlan(req.user.id, req.body?.csv, req.body?.includeLists !== false);
    if (plan.error) return res.status(400).json({ error: plan.error });
    res.json({ summary: plan.summary, report: report(plan, { applied: false, fileName: req.body?.fileName }) });
  } catch (e) {
    console.error('[manabox-sync] preview', e);
    res.status(500).json({ error: 'Could not read the ManaBox export.' });
  }
});

router.post('/apply', async (req, res) => {
  try {
    const plan = await buildPlan(req.user.id, req.body?.csv, req.body?.includeLists !== false);
    if (plan.error) return res.status(400).json({ error: plan.error });
    if (req.body?.expectBefore != null && Number(req.body.expectBefore) !== plan.summary.before) {
      return res.status(409).json({ error: 'The collection changed since the preview. Preview again.' });
    }
    const uid = req.user.id;
    const md = report(plan, { applied: true, fileName: req.body?.fileName });
    await db.withTransaction(async () => {
      for (const r of plan.coll.remove) await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [r.id, uid]);
      for (const [id, d] of plan.coll.redate) await db.run(`UPDATE collection SET added_at = ? WHERE id = ? AND user_id = ?`, [d, id, uid]);
      for (const a of plan.coll.add) {
        await db.run(
          `INSERT INTO collection (user_id, card_id, quantity, condition, printing, language, purchase_price, added_at, source)
           VALUES (?, ?, 1, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 'manabox')`,
          [uid, a.card_id, a.condition, a.printing, a.language, a.purchase_price, a.added_at]);
      }
      for (const l of plan.lists.create) {
        const r = await db.run(`INSERT INTO card_lists (user_id, name, description, source) VALUES (?, ?, 'Synced from ManaBox', 'manabox')`, [uid, l.name]);
        for (const c of l.cards) await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)`, [r.lastID, c.card_id, c.quantity]);
      }
      for (const l of plan.lists.update) {
        await db.run(`DELETE FROM list_cards WHERE list_id = ?`, [l.id]);
        for (const c of l.cards) await db.run(`INSERT INTO list_cards (list_id, card_id, quantity) VALUES (?, ?, ?)`, [l.id, c.card_id, c.quantity]);
      }
      await db.run(`INSERT INTO manabox_sync_runs (user_id, summary, report) VALUES (?, ?, ?)`, [uid, JSON.stringify(plan.summary), md]);
    });
    res.json({ summary: plan.summary, report: md });
  } catch (e) {
    console.error('[manabox-sync] apply', e);
    res.status(500).json({ error: 'Sync failed; nothing was changed.' });
  }
});

router.get('/runs', async (req, res) => {
  const rows = await db.all(`SELECT id, created_at, summary FROM manabox_sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [req.user.id]);
  res.json(rows.map(r => ({ id: r.id, created_at: r.created_at, summary: JSON.parse(r.summary) })));
});

router.get('/runs/:id/report', async (req, res) => {
  const r = await db.get(`SELECT report, created_at FROM manabox_sync_runs WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.type('text/markdown').set('Content-Disposition', `attachment; filename="manabox-sync-${req.params.id}.md"`).send(r.report);
});

module.exports = router;
