import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Sparkles, Loader2 } from 'lucide-react';
import CardImage from './CardImage';
import { CONDITIONS, LANGUAGES } from '../utils/cardOptions';
import { useT } from '../utils/i18n';

// Add a whole Secret Lair drop to the collection in one action. The shape
// mirrors PreconSearchModal (search a name -> pick -> preview the resolved card
// list -> commit), aimed at the product type the deck builder cannot reach:
// MTGJSON lists Secret Lair drops alongside precons, but the deck builder only
// wants playable decks, so a drop otherwise has to be typed into the scanner
// card by card.
//
// The foil choice is a real product decision, not a checkbox on the rows: a
// drop that ships a foil version has a separate "...Foil Edition" product with
// its OWN card list and scryfallIds. Choosing Foil reads THAT product's file,
// so the copies filed are the genuine foil printings (correct art, ids and
// prices) and are stamped Holofoil; Non-foil reads the base product and stamps
// Normal. The server maps the choice onto the collection.printing CHECK
// constraint ('Normal' | 'Holofoil'), the same value the quick-add drawer and
// scanner use. When a drop has no foil twin the Foil option is disabled rather
// than offering a foil add that would fail.
export default function SecretLairPanel({ onAddSuccess, setActiveTab }) {
  const { t } = useT();
  const [view, setView] = useState('search');       // 'search' | 'preview' | 'done'
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);      // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [selected, setSelected] = useState(null);    // {name, code, baseFile, foilFile, hasFoil, foilOnly}
  const [printing, setPrinting] = useState('nonfoil'); // 'nonfoil' | 'foil'
  const [preview, setPreview] = useState(null);      // {cards, unresolved, totalListed, resolvedCount}
  const [previewLoading, setPreviewLoading] = useState(false);
  const [condition, setCondition] = useState('Near Mint');
  const [language, setLanguage] = useState('English');
  const [copies, setCopies] = useState(1);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState(null);        // {added, failed, unresolved}
  const searchSeq = useRef(0);
  const previewSeq = useRef(0);

  const runSearch = useCallback(async (term) => {
    const seq = ++searchSeq.current;
    setSearching(true);
    setError('');
    try {
      const res = await fetch(`/api/secret-lair?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      if (seq !== searchSeq.current) return;         // a newer search has landed
      if (!res.ok) {
        setError(data.error || t('secretlair.errSearch'));
        setResults([]);
      } else {
        setResults(data.results || []);
        setStale(Boolean(data.stale));
      }
    } catch {
      if (seq === searchSeq.current) setError(t('secretlair.errSearch'));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
    // t is referentially stable across renders unless the language changes
    // (the provider memoises it), so it does not re-arm the debounce below.
  }, [t]);

  // Debounced live search, the way the collection search box behaves: typing
  // settles for a quarter-second and the lookup fires without a button press.
  useEffect(() => {
    if (!query.trim()) {
      // Same sequence bump runSearch does: an answer already in flight for the
      // PREVIOUS term would otherwise land after the clear and repopulate the
      // list the user just emptied. Bumping invalidates it (its seq check fails),
      // and setSearching(false) releases the spinner it was holding.
      searchSeq.current += 1;
      setResults(null); setStale(false); setSearching(false);
      return;
    }
    const id = setTimeout(() => runSearch(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query, runSearch]);

  // Read one product file and resolve its list. `which` is the printing the
  // user is looking at, so switching foil/non-foil re-runs against the other
  // product's own file (real printings, real counts - never a recolored copy).
  const loadPreview = async (drop, which) => {
    const fileName = which === 'foil' && drop.foilFile ? drop.foilFile : drop.baseFile;
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    setPreview(null);
    setError('');
    try {
      const res = await fetch(`/api/secret-lair/preview?fileName=${encodeURIComponent(fileName)}`);
      const data = await res.json();
      if (seq !== previewSeq.current) return;
      if (!res.ok) { setError(data.error || t('secretlair.errPreview')); return; }
      setPreview(data);
    } catch {
      if (seq === previewSeq.current) setError(t('secretlair.errPreview'));
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  const reset = () => {
    setView('search'); setSelected(null); setPreview(null); setResult(null); setError('');
    setPrinting('nonfoil'); setCopies(1); setCondition('Near Mint'); setLanguage('English');
  };

  const pickDrop = (drop) => {
    const hasFoil = Boolean(drop.foil);
    const foilOnly = drop.foilOnly === true && hasFoil;
    setSelected({
      name: drop.name, code: drop.code,
      baseFile: drop.fileName,
      foilFile: hasFoil ? drop.foil.fileName : null,
      hasFoil,
      foilOnly,
    });
    setPrinting(foilOnly ? 'foil' : 'nonfoil');
    setResult(null); setError(''); setView('preview');
    loadPreview({ baseFile: drop.fileName, foilFile: hasFoil ? drop.foil.fileName : null }, foilOnly ? 'foil' : 'nonfoil');
  };

  const choosePrinting = (which) => {
    if (which === printing || !selected) return;
    if (which === 'foil' && !selected.hasFoil) return;   // no foil product to read
    setPrinting(which);
    setPreview(null); setError('');
    loadPreview(selected, which);
  };

  const doAdd = async () => {
    if (!selected || adding) return;
    setAdding(true); setError('');
    try {
      const res = await fetch('/api/secret-lair/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: selected.baseFile,
          foil: printing === 'foil',
          printingMode: printing === 'foil' ? 'foil' : 'nonfoil',
          condition, language, copies,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || t('secretlair.errAdd')); return; }
      setResult(data);
      setView('done');
      onAddSuccess?.();
    } catch {
      setError(t('secretlair.errAdd'));
    } finally {
      setAdding(false);
    }
  };

  const chosenName = selected
    ? (printing === 'foil' && selected.hasFoil ? `${selected.name} (${t('secretlair.foilTag')})` : selected.name)
    : '';

  return (
    <div className="glass-panel" style={{ maxWidth: '600px', margin: '0 auto', padding: '1.25rem 1.4rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.25rem' }}>
        <Sparkles size={20} style={{ color: 'var(--accent-yellow)' }} />
        <h2 style={{ fontSize: '1.15rem', color: 'var(--text-strong)' }}>{t('secretlair.title')}</h2>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>{t('secretlair.subtitle')}</p>

      {view === 'search' && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={15} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input
                autoFocus
                className="input-control"
                style={{ paddingLeft: '2rem', width: '100%' }}
                placeholder={t('secretlair.searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && query.trim()) runSearch(query.trim()); }}
              />
            </div>
            <button type="button" className="btn btn-primary" onClick={() => query.trim() && runSearch(query.trim())} disabled={searching}>
              {t('precon.search')}
            </button>
          </div>

          {/* The examples sit under the field, not in the placeholder: a
              placeholder vanishes the moment you start typing, which is exactly
              when a hint is least wanted, and the full string did not fit the
              box anyway. Hidden once a query is on the page. */}
          {!query && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: '0.45rem 0 0' }}>
              {t('secretlair.examples')}
            </p>
          )}

          {stale && <p style={{ color: 'var(--accent-yellow)', fontSize: '0.75rem', margin: '0 0 0.5rem' }}>{t('secretlair.stale')}</p>}
          {error && <p style={{ color: 'var(--accent-red)', fontSize: '0.8rem', margin: '0 0 0.5rem' }}>{error}</p>}

          {searching && <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {t('common.loading')}</p>}

          {!searching && results !== null && (
            results.length === 0
              ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('secretlair.noResults')}</p>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '52vh', overflowY: 'auto' }}>
                  {results.map((d) => (
                    <button
                      key={d.fileName}
                      type="button"
                      className="btn btn-secondary"
                      style={{ textAlign: 'left', padding: '0.6rem 0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}
                      onClick={() => pickDrop(d)}
                    >
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{d.name}</span>
                        <br />
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                          {d.code}{d.releaseDate ? ` · ${d.releaseDate}` : ''}
                          {d.foil ? ` · ${t('secretlair.foilAvailable')}` : ''}
                        </span>
                      </span>
                      {d.foilOnly && <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--accent-purple)', whiteSpace: 'nowrap' }}>{t('secretlair.foilOnlyTag')}</span>}
                    </button>
                  ))}
                </div>
              )
          )}
        </>
      )}

      {view === 'preview' && selected && (
        <>
          <button type="button" className="btn btn-secondary" style={{ marginBottom: '0.6rem', padding: '0.2rem 0.6rem', fontSize: '0.82rem' }} onClick={reset}>‹ {t('secretlair.back')}</button>
          <div style={{ marginBottom: '0.4rem' }}>
            <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-strong)' }}>{chosenName}</span>
            {selected.code && <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>({selected.code})</span>}
          </div>

          {/* Foil / non-foil is the headline choice: a real product switch,
              disabled when the drop has no foil twin. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.6rem 0 0.4rem' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('card.printing')}</span>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => choosePrinting('nonfoil')} disabled={selected.foilOnly}
                style={{ fontWeight: printing === 'nonfoil' ? 700 : 400, opacity: selected.foilOnly ? 0.4 : 1,
                  border: `1px solid ${printing === 'nonfoil' ? 'var(--accent-yellow)' : 'var(--border)'}` }}>
                {t('secretlair.nonfoil')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => choosePrinting('foil')} disabled={!selected.hasFoil}
                style={{ fontWeight: printing === 'foil' ? 700 : 400, opacity: selected.hasFoil ? 1 : 0.4,
                  border: `1px solid ${printing === 'foil' ? 'var(--accent-yellow)' : 'var(--border)'}` }}>
                {t('secretlair.foil')}
              </button>
            </div>
          </div>
          {!selected.hasFoil && <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>{t('secretlair.foilNone')}</p>}
          {printing === 'foil' && selected.hasFoil && <p style={{ fontSize: '0.72rem', color: 'var(--accent-purple)', margin: '0 0 0.4rem' }}>{t('secretlair.foilNote')}</p>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.6rem', margin: '0.4rem 0 0.8rem' }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label style={{ fontSize: '0.75rem' }}>{t('card.condition')}</label>
              <select className="select-control" value={condition} onChange={(e) => setCondition(e.target.value)}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label style={{ fontSize: '0.75rem' }}>{t('card.language')}</label>
              <select className="select-control" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label style={{ fontSize: '0.75rem' }}>{t('secretlair.copiesLabel')}</label>
              <input type="number" min="1" max="4" className="input-control" value={copies}
                onChange={(e) => setCopies(Math.max(1, Math.min(4, parseInt(e.target.value, 10) || 1)))} />
            </div>
          </div>

          {previewLoading && <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {t('secretlair.loading')}</p>}
          {!previewLoading && preview && preview.cards.length === 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('secretlair.noCards')}</p>}
          {!previewLoading && preview && preview.cards.length > 0 && (
            <>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                {t('secretlair.found', { count: preview.resolvedCount, total: preview.totalListed })}
                {preview.unresolved > 0 && ` · ${t('secretlair.unmatched', { count: preview.unresolved })}`}
              </div>
              <div style={{ maxHeight: '42vh', overflowY: 'auto' }}>
                {preview.cards.map((c) => (
                  <div key={c.card_id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ width: '32px', height: '44px', flexShrink: 0, borderRadius: '4px', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
                      <CardImage card={{ image_url: c.image_url }} alt={c.name} width={32} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.name}
                        {c.isFoil && <span style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: 'var(--accent-purple)' }}>{t('secretlair.foilTag')}</span>}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{[c.set_code, c.number].filter(Boolean).join(' ')}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '0.75rem', flexShrink: 0 }}>
                      <div style={{ color: 'var(--text-strong)' }}>{t('secretlair.copies', { count: c.count })}</div>
                      {c.owned > 0 && <div style={{ color: 'var(--accent-green)' }}>{t('secretlair.owned', { count: c.owned })}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {error && <p style={{ color: 'var(--accent-red)', fontSize: '0.8rem', marginTop: '0.5rem' }}>{error}</p>}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn btn-secondary" onClick={reset}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={doAdd} disabled={adding || previewLoading || !preview || !preview.cards.length} style={{ flex: 1 }}>
              {adding ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: '0.4rem' }} />{t('secretlair.adding')}</> : t('secretlair.addConfirm', { count: preview ? preview.cards.length : 0 })}
            </button>
          </div>
        </>
      )}

      {view === 'done' && result && (
        <>
          <div style={{ textAlign: 'center', padding: '0.5rem 0 0.25rem' }}>
            <Sparkles size={26} style={{ color: 'var(--accent-green)', marginBottom: '0.4rem' }} />
            <p style={{ color: 'var(--text-strong)', fontWeight: 600, fontSize: '1rem' }}>{t('secretlair.done', { count: result.added || 0 })}</p>
            {(result.unresolved > 0) && <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' }}>{t('secretlair.skipped', { count: result.unresolved })}</p>}
            {result.failed && result.failed.length > 0 && <p style={{ color: 'var(--accent-red)', fontSize: '0.8rem', marginTop: '0.25rem' }}>{t('secretlair.failedNote', { count: result.failed.length })}</p>}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'center' }}>
            <button type="button" className="btn btn-secondary" onClick={reset}>{t('secretlair.again')}</button>
            <button type="button" className="btn btn-primary" onClick={() => setActiveTab?.('collection')}>{t('secretlair.goToCollection')}</button>
          </div>
        </>
      )}
    </div>
  );
}
