import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Database, RefreshCw, Zap, AlertTriangle, Play, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { LANGUAGES, langName } from '../utils/languages';
import { enabledGames, gameLabel } from '../utils/games';

// The one place indexes are managed.
//
// This replaced two separate panels — "Set Scan Indexes" and "Global Scan
// Indexes" — which hid the fact that they are the same thing at two scales. There
// is one unit of work, a per-set index; the whole-game tables that let you scan
// WITHOUT naming a set are concatenations of those set indexes. Two panels made
// that look like two features, and gave "index everything" two implementations
// that disagreed (one fired a request per set with no queue).
//
// So: pick a game and language, filter the catalogue however you like, and either
// index a selection or take the whole language in one action — with the coverage
// consequences stated before anything starts.
const isActive = (p) => p && p.status === 'running';

// Match the filter-field styling the rest of the app uses (see CollectionList):
// uppercase muted label above a .select-control / .input-control, in a form-group
// with no bottom margin. The controls carry no inline font-size — those classes
// already set it, and overriding it is what made these look foreign.
const labelStyle = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' };

// What each game lets you leave out of a build, keyed by game because the two
// catalogues have nothing in common here.
//
// MTG's four are Scryfall set_type values read by setIndex.childAllowed, which is
// reached only from the MTG paths. They were previously shown for every game,
// which meant a Pokémon catalogue offered four controls that wrote a settings
// column nothing then read — "Ignore Jumpstarts (j25)" on a Pokémon set list.
//
// Pokémon's one is a different kind of thing: not a subset of a set, but whole
// series that exist only in the phone game. It is the sole exclusion that defaults
// ON, because no camera will ever be pointed at a Pokémon TCG Pocket card.
// Translation KEYS, not strings — the panel resolves them at render, so the box
// follows the interface language like everything else.
const EXCLUSIONS = {
  mtg: {
    title: 'scanIndex.exclMtgTitle',
    hint: 'scanIndex.exclMtgHint',
    options: [
      ['scan_exclude_jumpstart', 'scanIndex.exclStarter', 'scanIndex.exclStarterHint'],
      ['scan_exclude_tokens', 'scanIndex.exclTokens', 'scanIndex.exclTokensHint'],
      ['scan_exclude_art_cards', 'scanIndex.exclArtCards', 'scanIndex.exclArtCardsHint'],
      ['scan_exclude_promos', 'scanIndex.exclPromos', 'scanIndex.exclPromosHint'],
    ],
  },
  pokemon: {
    title: 'scanIndex.exclPkmTitle',
    hint: 'scanIndex.exclPkmHint',
    options: [
      ['scan_exclude_digital', 'scanIndex.exclDigital', 'scanIndex.exclDigitalHint'],
    ],
  },
};

// The backend's absent-set reason buckets are stable identifiers, so they map to
// keys rather than being shown raw. An unrecognised bucket falls back to itself,
// which is still readable rather than blank.
const REASON_KEYS = {
  'no card images': 'scanIndex.reasonNoCardImages',
  'no card records': 'scanIndex.reasonNoCardRecords',
  'not published in this language': 'scanIndex.reasonNotPublished',
  unavailable: 'scanIndex.reasonUnavailable',
};

// No local number formatter: every count now goes through t(), and translate()
// runs numeric vars through Intl.NumberFormat for the INTERFACE locale — so a
// German reader gets 21.775 where an English one gets 21,775, without the call
// sites thinking about it.
function Field({ label, children, style }) {
  return (
    <div className="form-group" style={{ marginBottom: 0, ...style }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

// The detail behind the headline, hidden until asked for.
//
// Every number here answers a question the single coverage line provoked and
// could not answer: which cards are these, why are 55 sets missing, and is the
// gap something I can close? Kept collapsed because the answer is usually
// "nothing to do" — and a panel that shouts that permanently is the thing this
// replaced.
function CoverageDetail({ summary, t }) {
  const { cards, series = [], unavailable = [], unavailableReasons = [] } = summary;
  const row = { display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.15rem 0' };
  const head = { ...labelStyle, fontSize: '0.68rem', marginTop: '0.5rem' };

  return (
    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-glass)', paddingTop: '0.5rem', marginTop: '0.15rem' }}>
      {series.length > 0 && (
        <>
          <div style={head}>{t('scanIndex.indexedBySeries')}</div>
          {series.filter(s => s.built > 0).map(s => (
            <div key={s.series} style={row}>
              <span style={{ color: 'var(--text-strong)' }}>
                {s.series}
                {s.digital && <span style={{ color: 'var(--accent-yellow)', marginLeft: '0.35rem' }}>{t('scanIndex.digitalTag')}</span>}
              </span>
              <span>{t('scanIndex.seriesLine', { sets: s.built, cards: s.cards })}</span>
            </div>
          ))}
        </>
      )}

      {/* The gap the panel could never previously explain: sets the provider
          lists but cannot supply art for. Grouped by reason, because "retry",
          "switch language" and "accept it" are different next moves. */}
      {unavailable.length > 0 && (
        <>
          <div style={head}>{t('scanIndex.unavailableHeading')}</div>
          {unavailableReasons.map(r => (
            <div key={r.reason} style={row}>
              <span>{REASON_KEYS[r.reason] ? t(REASON_KEYS[r.reason]) : r.reason}</span>
              <span>{t('scanIndex.setsCount', { n: r.count })}</span>
            </div>
          ))}
          <div style={{ ...row, color: 'var(--text-muted)', fontSize: '0.68rem', flexWrap: 'wrap' }}>
            <span>{unavailable.slice(0, 8).map(u => u.set).join(', ')}
              {unavailable.length > 8 && `, +${unavailable.length - 8}`}</span>
          </div>
        </>
      )}

      {/* Cards inside sets that DID build but carry no art. Invisible everywhere
          else in this panel: those sets show as fully indexed. */}
      {cards && cards.missingArt > 0 && (
        <>
          <div style={head}>{t('scanIndex.insideBuiltSets')}</div>
          <div style={row}>
            <span>{t('scanIndex.noImageToIndex')}</span>
            <span>{t('scanIndex.cardsCount', { n: cards.missingArt })}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function ScanIndexPanel({ t, showToast, formatBytes }) {
  const [game, setGame] = useState(() => enabledGames()[0] || 'mtg');
  const [lang, setLang] = useState('en');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // Filters. `yearFrom`/`yearTo` are strings so the inputs stay controlled while
  // being cleared.
  const [text, setText] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [status, setStatus] = useState('all');   // all | indexed | missing

  // Which sets to build. Empty means "everything", so the default action needs no
  // clicking around; ticking any row narrows it to exactly what is ticked.
  const [selected, setSelected] = useState(() => new Set());
  const [expandedSets, setExpandedSets] = useState(() => new Set());
  const [showDetail, setShowDetail] = useState(false);
  const [appSettings, setAppSettings] = useState(null);
  const [disabledChildCodes, setDisabledChildCodes] = useState(() => new Map());

  const toggleExpand = (setCode) => setExpandedSets(prev => {
    const next = new Set(prev);
    if (next.has(setCode)) next.delete(setCode); else next.add(setCode);
    return next;
  });

  const toggleChildCode = (setCode, childCode) => setDisabledChildCodes(prev => {
    const next = new Map(prev);
    const setCodes = new Set(next.get(setCode) || []);
    if (setCodes.has(childCode)) setCodes.delete(childCode); else setCodes.add(childCode);
    next.set(setCode, setCodes);
    return next;
  });

  const loadSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) setAppSettings(await res.json());
    } catch { /* best effort */ }
  };

  const updateSetting = async (patch) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setAppSettings(await res.json());
        showToast('Settings saved');
        load(true);
      }
    } catch (e) {
      showToast(String(e.message || e));
    }
  };

  const pollRef = useRef(null);
  const mounted = useRef(true);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch(`/api/admin/scan-indexes?game=${game}&lang=${lang}`);
      const body = await res.json();
      if (!mounted.current) return false;
      if (!res.ok) { setError(body.error || 'Failed to load'); return false; }
      setError('');
      setData(body);
      return Object.values(body.progress || {}).some(isActive);
    } catch (e) {
      if (mounted.current) setError(String(e.message || e));
      return false;
    } finally {
      if (mounted.current && showSpinner) setLoading(false);
    }
  }, [game, lang]);

  useEffect(() => {
    mounted.current = true;
    loadSettings();
    load(true).then(active => { if (active) startPoll(); });
    return () => {
      mounted.current = false;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, lang]);

  const startPoll = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const active = await load(false);
      if (!active && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }, 1500);
  };

  const sets = data ? data.sets : [];
  const summary = data ? data.summary : null;
  const progress = data && data.progress ? data.progress[`${game}|${lang}`] : null;
  const running = isActive(progress);
  const yearsAvailable = data ? data.yearsAvailable : false;

  // The filtered selection is what the build actions operate on, so it has to be
  // the same list the table shows — no hidden divergence between what you see and
  // what gets built.
  const filtered = sets.filter(s => {
    if (status === 'indexed' && !s.indexed) return false;
    if (status === 'missing' && s.indexed) return false;
    if (text.trim()) {
      const q = text.trim().toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.set.toLowerCase().includes(q)) return false;
    }
    // A set with no known year is never excluded by a year filter — hiding it would
    // silently drop every non-English Pokémon set, whose provider omits dates.
    if (s.year !== null) {
      if (yearFrom && s.year < Number(yearFrom)) return false;
      if (yearTo && s.year > Number(yearTo)) return false;
    }
    return true;
  });

  const describeFilter = () => {
    const bits = [];
    if (yearFrom || yearTo) bits.push(`${yearFrom || '…'}–${yearTo || '…'}`);
    if (status !== 'all') bits.push(status);
    if (text.trim()) bits.push(`"${text.trim()}"`);
    return bits.join(', ') || 'selection';
  };

  // The build scope: exactly what is ticked, or the whole catalogue when nothing
  // is. Deliberately NOT "the current filter" — a scope you cannot see in full is
  // a scope you can get wrong, and this one determines what stays scannable.
  const scopeSets = selected.size ? sets.filter(s => selected.has(s.set)).map(s => s.set) : null;
  const scopeCount = scopeSets ? scopeSets.length : (summary ? summary.total : 0);

  const filteredSelectedCount = filtered.filter(s => selected.has(s.set)).length;
  const allFilteredSelected = filtered.length > 0 && filteredSelectedCount === filtered.length;

  const toggleOne = (set) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(set)) next.delete(set); else next.add(set);
    return next;
  });
  const toggleAllFiltered = () => setSelected(prev => {
    const next = new Set(prev);
    if (allFilteredSelected) for (const s of filtered) next.delete(s.set);
    else for (const s of filtered) next.add(s.set);
    return next;
  });

  const post = async (body, label) => {
    setBusy(label);
    try {
      const res = await fetch('/api/admin/scan-indexes/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, lang, ...body }),
      });
      const j = await res.json();
      if (res.ok) { showToast(j.message); await load(false); startPoll(); }
      else showToast(j.error || t('admin.errGlobalBuild'));
    } catch (e) {
      showToast(String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  // Every build states its coverage consequences first. A partial index cannot say
  // "I don't know" when it meets a card it never saw — it returns the nearest
  // artwork it does hold — so the excluded count is the thing to be honest about.
  const confirmAndBuild = () => {
    const total = summary ? summary.total : 0;
    const indexedAfter = summary ? Math.max(summary.indexed, scopeCount) : scopeCount;
    const lines = [t('scanIndex.confirmIntro', { count: scopeCount, game: gameLabel(game, true), language: langName(lang) })];
    // The consequence worth stating: which cards will still be unscannable
    // without naming their set afterwards.
    if (total - indexedAfter > 0) lines.push('', t('scanIndex.confirmExcluded', { excluded: total - indexedAfter, total }));
    lines.push('', t('scanIndex.confirmTime'));
    if (!window.confirm(lines.join('\n'))) return;
    post({ sets: scopeSets, rollup: true, filter: scopeSets ? { description: describeFilter() } : null }, 'build');
  };

  const stop = async () => {
    if (!window.confirm(t('admin.confirmStopGlobal', { game: `${game.toUpperCase()} (${langName(lang)})` }))) return;
    const res = await fetch(`/api/admin/global-indexes/${game}?lang=${lang}`, { method: 'DELETE' });
    const j = await res.json();
    showToast(j.message || j.error);
    load(false);
  };

  const buildOne = async (set) => {
    const disabled = Array.from(disabledChildCodes.get(set) || []);
    await fetch('/api/admin/set-indexes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game, set, lang, excludeChildCodes: disabled }),
    });
    showToast(t('scanIndex.buildingSet', { set }));
    load(false);
    startPoll();
  };

  const removeOne = async (set) => {
    if (!window.confirm(t('admin.confirmRemoveIndex', { lang: langName(lang), game, set }))) return;
    await fetch(`/api/admin/set-indexes/${game}/${encodeURIComponent(set)}?lang=${lang}`, { method: 'DELETE' });
    load(false);
  };

  // Only the ticked sets that actually HAVE an index — the rest have nothing to
  // remove, and counting them would make the button offer to delete more than it
  // can.
  const selectedIndexed = sets.filter(s => selected.has(s.set) && s.indexed);

  // Bulk remove. There was no way to do this except one row at a time, which for
  // a filtered selection of forty sets is not a real option.
  //
  // Sequential on purpose: each delete is a directory of files, and firing forty
  // at once at the same disk is how the per-set build path used to misbehave. A
  // failure does not abort the rest — a half-finished removal is recoverable,
  // whereas stopping at the first error leaves the user to work out which of
  // forty sets went.
  const removeSelected = async () => {
    const targets = selectedIndexed.map(s => s.set);
    if (!targets.length) return;
    const warning = summary && summary.codeFreeReady ? t('scanIndex.confirmRemoveRollupNote') : '';
    const listed = `${targets.slice(0, 10).join(', ')}${targets.length > 10 ? `, +${targets.length - 10}` : ''}`;
    if (!window.confirm(t('scanIndex.confirmRemoveMany', {
      n: targets.length, game: game.toUpperCase(), language: langName(lang), sets: listed,
    }) + warning)) return;

    setBusy('remove');
    let done = 0;
    for (const set of targets) {
      try {
        const res = await fetch(`/api/admin/set-indexes/${game}/${encodeURIComponent(set)}?lang=${lang}`, { method: 'DELETE' });
        if (res.ok) done++;
      } catch { /* keep going; the toast reports the shortfall */ }
    }
    setBusy('');
    setSelected(new Set());
    showToast(done === targets.length
      ? t('scanIndex.removedIndexes', { n: done })
      : t('scanIndex.removedIndexesPartial', { done, total: targets.length, failed: targets.length - done }));
    load(false);
  };

  // Card-level coverage where we have it, falling back to sets. The two differ a
  // lot — 163 of 218 sets is 75%, the same index is ~92% of the cards — and the
  // bar should agree with the number printed above it.
  const cards = summary ? summary.cards : null;
  const buildableCards = cards ? Math.max(0, cards.claimed - cards.unavailable) : 0;
  const pct = cards && buildableCards
    ? Math.round((cards.indexed / buildableCards) * 100)
    : (summary && summary.total ? Math.round((summary.indexed / summary.total) * 100) : 0);
  const phaseLabel = {
    check: t('scanIndex.phaseCheck'), sets: t('admin.phaseSets'), recall: t('admin.phaseRecall'),
    orb: 'ORB', verify: t('admin.phaseVerify'), gather: t('admin.phaseGather'), embed: t('admin.phaseEmbeddings'),
  }[progress?.phase] || progress?.phase || '';

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Database size={18} style={{ color: 'var(--accent-red)' }} />
        {t('scanIndex.title')}
      </h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.45 }}>
        {t('scanIndex.hint')}
      </p>
      {/* Everything else the user might need to know is either on the coverage
          line or in a tooltip. The panel is a tool, not a document. */}

      {/* Game + language pick the whole view: indexes are per game AND per language,
          because a card's art differs by language. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
        <Field label={t('collection.fGame')}>
          <select className="select-control" value={game} onChange={(e) => setGame(e.target.value)}>
            {enabledGames().map(g => <option key={g} value={g}>{gameLabel(g, true)}</option>)}
          </select>
        </Field>
        <Field label={t('card.language')}>
          <select className="select-control" value={lang} onChange={(e) => setLang(e.target.value)}>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </Field>
        {game === 'pokemon' && lang === 'en' && (
          <Field label="Pokémon Provider (EN)">
            <select
              className="select-control"
              value={appSettings?.pokemon_provider || 'pokemontcg'}
              onChange={(e) => updateSetting({ pokemon_provider: e.target.value })}
            >
              {/* No hardcoded set counts: they were 174/218, both went stale the
                  moment a provider shipped a set, and the 218 stopped being true
                  at all once digital sets were excluded. The live numbers are on
                  the coverage line below. */}
              <option value="pokemontcg">{t('scanIndex.providerPokemontcg')}</option>
              <option value="tcgdex">{t('scanIndex.providerTcgdex')}</option>
            </select>
          </Field>
        )}
      </div>

      {/* Which subsets fold into their parent set's index.
          MTG only, and shown only for MTG: these are Scryfall set_type values, read
          by setIndex.childAllowed, which is reached exclusively from the three
          MTG paths (getMtgChildSets, getMtgChildSetMap, mtgSetFamilyQuery). The
          Pokémon providers publish no set_type at all, so on a Pokémon catalogue
          these boxes wrote a settings column that nothing then read — four
          controls that looked like they were narrowing the build and were not. */}
      {appSettings && EXCLUSIONS[game] && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', padding: '0.75rem 0.9rem', borderRadius: 'var(--radius-sm)' }}>
          <span style={labelStyle}>{t(EXCLUSIONS[game].title)}</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            {t(EXCLUSIONS[game].hint)}
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.4rem 1rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {EXCLUSIONS[game].options.map(([key, label, hint]) => (
              <label key={key} title={t(hint)} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!appSettings[key]}
                  onChange={(e) => updateSetting({ [key]: e.target.checked })}
                />
                {t(label)}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--accent-red)', fontSize: '0.8rem', background: 'rgba(255,71,71,0.06)', border: '1px solid var(--border-glass)', padding: '0.6rem 0.8rem', borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      {/* Coverage summary: the answer to "why can't I scan without a set code". */}
      {summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', padding: '0.75rem 0.9rem', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.8rem' }}>
            {/* Cards, not sets. Sets range from 12 printings to 302, so set-based
                coverage read 75% while the same index held ~92% of the cards. The
                `~` is not decoration: the numerator is measured off the built
                indexes, the denominator is the provider's claimed count. */}
            <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>
              {cards
                ? t('scanIndex.artworksCoverage', { indexed: cards.indexed, total: buildableCards })
                : t('scanIndex.coverage', { indexed: summary.indexed, total: summary.total })}
            </span>
            {/* "Not ready" told the user nothing they could act on. Say what a
                no-set-code scan can actually recognise right now. */}
            <span style={{ color: summary.codeFreeReady ? 'var(--accent-green, #4ade80)' : 'var(--accent-yellow)' }}>
              {summary.codeFreeReady
                ? t('scanIndex.codeFreeCovers', {
                  covered: summary.scope ? summary.scope.covered : summary.embedded,
                  // The rollup's OWN catalogue size, not today's. The live tables
                  // were built against whatever the catalogue was at the time, so
                  // pairing their covered count with the current total compares
                  // two different lists — visibly so the moment an exclusion
                  // changes one of them ("163 of 203", where the 163 counted 14
                  // sets the 203 no longer contains).
                  total: (summary.scope && summary.scope.catalogue) || summary.total,
                })
                : (summary.embedded > 0
                  ? t('scanIndex.codeFreePending', { count: summary.embedded })
                  : t('scanIndex.codeFreeNone'))}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{formatBytes(summary.bytes || 0)}</span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--accent-green, #4ade80)' : 'var(--accent-yellow)', transition: 'width 0.4s ease' }}></div>
          </div>

          {/* Sets demoted to a second line, and counted against what is actually
              buildable. A set the provider has no art for is not work left undone,
              so it belongs in the breakdown rather than in the denominator. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {t('scanIndex.coverage', { indexed: summary.builtSets, total: summary.buildableSets })}
              {summary.unavailableSets > 0 && ` · ${t('scanIndex.unavailableFromProvider', { n: summary.unavailableSets })}`}
            </span>
            <button
              type="button"
              onClick={() => setShowDetail(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.72rem', color: 'var(--text-secondary)' }}
            >
              {showDetail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {showDetail ? t('scanIndex.hideDetails') : t('scanIndex.details')}
            </button>
          </div>

          {showDetail && <CoverageDetail summary={summary} t={t} />}

          {/* Only warn about a partial index when there is something left to DO
              about it. Sets the provider cannot supply are reported in the
              breakdown instead — a permanent yellow warning on a finished job
              reads as an error the user can fix, and there is nothing to fix.
              (scanMatch still disclaims weak matches against `scope.excluded`,
              which is the different question of what the index can answer.) */}
          {summary.buildableSets - summary.builtSets > 0 && summary.scope && (
            <span style={{ fontSize: '0.72rem', color: 'var(--accent-yellow)' }}>
              {t('scanIndex.partialWarning', { covered: summary.scope.covered, total: summary.scope.catalogue })}
            </span>
          )}
          {running && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.25rem' }}>
              <div style={{ height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '100%', opacity: progress.total ? 1 : 0.35, background: 'var(--accent-red)' }}></div>
              </div>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                {phaseLabel} {progress.done}/{progress.total || '?'}
                {progress.currentSet ? ` · ${progress.currentSet}` : ''}
                {progress.absent ? ` · ${t('scanIndex.absentCount', { count: progress.absent })}` : ''}
              </span>
            </div>
          )}
          {!running && progress && progress.status === 'error' && (
            <span style={{ fontSize: '0.72rem', color: 'var(--accent-red)', wordBreak: 'break-word' }}>{progress.error}</span>
          )}
        </div>
      )}

      {/* Stop/resume live up here because they act on a build already in flight,
          independent of what is selected below. */}
      {(running || (progress && progress.resumable && ['error', 'stopped', 'interrupted'].includes(progress.status))) && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {running && (
            <button type="button" className="btn btn-danger btn-sm" onClick={stop} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <AlertTriangle size={14} /> {t('admin.stopBuild')}
            </button>
          )}
          {!running && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => post({ resume: true }, 'resume')} disabled={!!busy}
              style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Play size={14} /> {t('admin.resumeBuild')}
            </button>
          )}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
        <Field label={t('scanIndex.filterText')} style={{ gridColumn: 'span 2' }}>
          <input className="input-control" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('scanIndex.filterTextPlaceholder')} />
        </Field>
        <Field label={t('scanIndex.yearFrom')}>
          <input className="input-control" type="number" value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value)} disabled={!yearsAvailable} placeholder="1993" />
        </Field>
        <Field label={t('scanIndex.yearTo')}>
          <input className="input-control" type="number" value={yearTo}
            onChange={(e) => setYearTo(e.target.value)} disabled={!yearsAvailable} placeholder="2026" />
        </Field>
        <Field label={t('admin.colStatus')}>
          <select className="select-control" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">{t('scanIndex.statusAll')}</option>
            <option value="indexed">{t('scanIndex.statusIndexed')}</option>
            <option value="missing">{t('scanIndex.statusMissing')}</option>
          </select>
        </Field>
      </div>
      {/* Say why the year inputs are dead rather than leaving them mysteriously
          disabled — but as one short line, not a paragraph. */}
      {!yearsAvailable && data && (
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{t('scanIndex.noYears')}</span>
      )}

      {/* Actions, in a bar you can actually see.
          These were 11px secondary buttons sitting inline in a row of grey helper
          text, 1,600px down the page — present, and reported as absent, which is
          the only test that matters. Keeping a multi-hour job from being the
          obvious default is right; making it undiscoverable is not, so the
          restraint now lives in the confirm dialog rather than in the font size.
          The destructive action is styled apart and never appears without a
          selection to scope it. */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.6rem 0.75rem', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {t('scanIndex.showing', { shown: filtered.length, total: sets.length })}
          {selected.size > 0 && (
            <strong style={{ color: 'var(--accent-yellow)', marginLeft: '0.45rem' }}>
              {t('scanIndex.selectedCount', { count: selected.size })}
            </strong>
          )}
        </span>
        <span style={{ flex: 1 }} />

        {selected.size > 0 ? (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={confirmAndBuild} disabled={!!busy || running}
              style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Zap size={14} /> {t('scanIndex.buildSelected', { count: scopeCount })}
            </button>
            {selectedIndexed.length > 0 && (
              <button type="button" className="btn btn-danger btn-sm" onClick={removeSelected} disabled={!!busy || running}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Trash2 size={14} /> {t('scanIndex.removeIndexes', { n: selectedIndexed.length })}
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())} disabled={!!busy}>
              {t('scanIndex.clearSelection')}
            </button>
          </>
        ) : (
          // Only offer "index everything" when there is actually a catalogue to
          // index — "Index all 0 sets" is noise when the provider is unreachable.
          summary && summary.total > 0 && (
            <>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('scanIndex.pickSetsPrompt')}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={confirmAndBuild} disabled={!!busy || running}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title={t('scanIndex.buildAllWarning')}>
                <RefreshCw size={14} /> {t('scanIndex.buildAll', { count: summary.total, language: langName(lang) })}
              </button>
            </>
          )
        )}
      </div>

      <div className="collection-table-wrapper" style={{ overflowX: 'auto', maxHeight: '460px', overflowY: 'auto' }}>
        <table className="collection-table">
          <thead>
            <tr>
              {/* Ticks the filtered rows, not the whole catalogue — the header box
                  should only ever affect what you can actually see. */}
              <th style={{ width: '32px' }}>
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleAllFiltered}
                  disabled={!filtered.length}
                  title={t('scanIndex.selectAllFiltered', { count: filtered.length })}
                />
              </th>
              <th>{t('admin.colName')}</th>
              <th>{t('scanIndex.colYear')}</th>
              <th>{t('sets.colCards')}</th>
              <th>{t('admin.colSize')}</th>
              <th>{t('admin.colStatus')}</th>
              <th>{t('admin.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('scanIndex.loading')}</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('scanIndex.noMatches')}</td></tr>}
            {filtered.map(s => {
              const hasChildren = Array.isArray(s.children) && s.children.length > 0;
              const isExpanded = expandedSets.has(s.set);
              return (
                <React.Fragment key={s.set}>
                  <tr style={selected.has(s.set) ? { background: 'rgba(255,71,71,0.06)' } : undefined}>
                    <td>
                      <input type="checkbox" checked={selected.has(s.set)} onChange={() => toggleOne(s.set)} />
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {hasChildren && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-icon-only"
                            style={{ width: '20px', height: '20px', minWidth: '20px', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                            onClick={() => toggleExpand(s.set)}
                            title={isExpanded ? 'Collapse subsets' : 'Expand subsets'}
                          >
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        )}
                        {s.logo && <img src={s.logo} alt="" style={{ height: '18px', maxWidth: '46px', objectFit: 'contain' }} />}
                        <span style={{ color: 'var(--text-strong)' }}>{s.name}</span>
                        <code style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{s.set}</code>
                      </div>
                    </td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{s.year ?? '—'}</td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {s.cards ? (
                        <div>
                          <div>{s.cards.toLocaleString()} indexed</div>
                          {hasChildren && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              ~{s.totalFamilyCount ? s.totalFamilyCount.toLocaleString() : '—'} family total
                            </div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <div>~{s.printings ? s.printings.toLocaleString() : '—'} main</div>
                          {hasChildren && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--accent-blue, #60a5fa)' }}>
                              + {s.children.length} subsets (~{s.totalFamilyCount ? s.totalFamilyCount.toLocaleString() : '—'} total)
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{s.bytes ? formatBytes(s.bytes) : '—'}</td>
                    <td style={{ fontSize: '0.75rem' }}>
                      {s.indexed
                        ? <span style={{ color: 'var(--accent-green, #4ade80)' }}>
                          {s.embedded ? t('scanIndex.stateFull') : t('scanIndex.stateSetOnly')}
                        </span>
                        : <span style={{ color: 'var(--text-secondary)' }}>{t('admin.statusNotBuilt')}</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.3rem' }}>
                        <button className="btn btn-secondary btn-icon-only" title={s.indexed ? t('admin.rebuild') : t('scanIndex.buildSet')} onClick={() => buildOne(s.set)} disabled={running}>
                          <RefreshCw size={13} />
                        </button>
                        {s.indexed && (
                          <button className="btn btn-danger btn-icon-only" title={t('admin.removeIndex')} onClick={() => removeOne(s.set)} disabled={running}>
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {hasChildren && isExpanded && (
                    <tr style={{ background: 'rgba(0,0,0,0.18)' }}>
                      <td colSpan={7} style={{ padding: '0.4rem 0.8rem 0.6rem 2.4rem' }}>
                        <div style={{ fontSize: '0.73rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>
                          {t('scanIndex.subsetsBundled', { set: s.set.toUpperCase() })}
                        </div>
                        <table style={{ width: '100%', fontSize: '0.72rem', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-glass)', textAlign: 'left', color: 'var(--text-muted)' }}>
                              <th style={{ padding: '0.2rem 0.4rem', width: '28px' }}></th>
                              <th style={{ padding: '0.2rem 0.4rem' }}>{t('scanIndex.colCode')}</th>
                              <th style={{ padding: '0.2rem 0.4rem' }}>{t('scanIndex.colSubsetName')}</th>
                              <th style={{ padding: '0.2rem 0.4rem' }}>{t('scanIndex.colType')}</th>
                              <th style={{ padding: '0.2rem 0.4rem' }}>{t('scanIndex.colExpectedCards')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.children.map(c => {
                              const isChecked = !(disabledChildCodes.get(s.set)?.has(c.code));
                              return (
                                <tr key={c.code} style={{ borderBottom: '1px dotted rgba(255,255,255,0.05)', opacity: isChecked ? 1 : 0.45 }}>
                                  <td style={{ padding: '0.2rem 0.4rem' }}>
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => toggleChildCode(s.set, c.code)}
                                      title={isChecked ? `Include ${c.code} in ${s.set.toUpperCase()} index` : `Skip ${c.code} from ${s.set.toUpperCase()} index`}
                                    />
                                  </td>
                                  <td style={{ padding: '0.2rem 0.4rem' }}><code>{c.code}</code></td>
                                  <td style={{ padding: '0.2rem 0.4rem', color: 'var(--text-strong)' }}>{c.name}</td>
                                  <td style={{ padding: '0.2rem 0.4rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{c.type}</td>
                                  <td style={{ padding: '0.2rem 0.4rem' }}>~{c.cardCount ? c.cardCount.toLocaleString() : 0}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
