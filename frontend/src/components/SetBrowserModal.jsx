import { useState, useEffect, useCallback } from 'react';
import { X, Search, Database, Play, CheckCircle2, Zap } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';

function formatDate(d) {
  if (!d) return '-';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return d; }
}

/**
 * Returns the bare set code for the build API (strips "mtg-" prefix for MTG sets).
 */
function bareSetCode(id, game) {
  if (game === 'mtg' && id.startsWith('mtg-')) return id.slice(4);
  return id;
}

const isActive = (p) => p && (p.status === 'fetching' || p.status === 'indexing');

export default function SetBrowserModal({ game: initialGame, onClose, onStartBuild, existingKeys, progress }) {
  const [game, setGame] = useState(initialGame || 'mtg');
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [buildingSet, setBuildingSet] = useState(new Set());

  useBackGuard(true, onClose);

  useEffect(() => {
    let cancelled = false;
    const fetchSets = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/sets-browse?game=${game}`);
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setSets(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchSets();
    return () => { cancelled = true; };
  }, [game]);

  const existingSet = new Set(existingKeys || []);

  const handleIndex = useCallback(async (g, setCode) => {
    const key = `${g}|${setCode}`;
    setBuildingSet(prev => new Set(prev).add(key));
    try {
      await onStartBuild(g, setCode);
    } catch {
      // onStartBuild handles its own errors/toasts
    }
    // Don't remove from buildingSet — the polling-driven existingKeys
    // will cause the row to flip to "Indexed" once the build completes.
  }, [onStartBuild]);

  const handleIndexAll = () => {
    const unbuilt = sets.filter(s => {
      const code = bareSetCode(s.id, game);
      const key = `${game}|${code}`;
      return !existingSet.has(key) && !buildingSet.has(key) && !isActive(progress[key]);
    });
    if (unbuilt.length === 0) return;
    if (!window.confirm(`Index all ${unbuilt.length} unbuilt ${game === 'mtg' ? 'MTG' : 'Pokémon'} sets? This downloads every card image for each set and can take a long time.`)) return;
    for (const s of unbuilt) {
      handleIndex(game, bareSetCode(s.id, game));
    }
  };

  const filtered = filter.trim()
    ? sets.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()) || s.id.toLowerCase().includes(filter.toLowerCase()))
    : sets;

  const logoFor = (s) => s.logo_url || s.symbol_url || null;

  const unbuiltCount = sets.filter(s => {
    const code = bareSetCode(s.id, game);
    return !existingSet.has(`${game}|${code}`);
  }).length;

  return (
    <div
      className="modal-overlay"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ width: '960px', maxWidth: '98vw', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-primary, #121212)', borderRadius: 'var(--radius-lg, 12px)', border: '1px solid var(--border-glass)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Database size={18} style={{ color: 'var(--accent-red)' }} />
            Browse Sets
          </h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {unbuiltCount > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                onClick={handleIndexAll}
              >
                <Zap size={14} /> Index All ({unbuiltCount})
              </button>
            )}
            <button className="btn btn-secondary btn-icon-only" onClick={onClose} style={{ width: '28px', height: '28px', padding: 0 }}>
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Game selector + search */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '0.35rem' }}>
            {['mtg', 'pokemon'].map(g => (
              <button
                key={g}
                type="button"
                className={`btn ${game === g ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
                onClick={() => setGame(g)}
              >
                {g === 'mtg' ? 'MTG' : 'Pokémon'}
              </button>
            ))}
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: '180px' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="input-control"
                placeholder="Filter sets..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ paddingLeft: '1.8rem' }}
              />
            </div>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto 0.5rem' }}></div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Loading sets...</p>
          </div>
        ) : error ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--accent-red)', fontSize: '0.85rem' }}>
            Failed to load sets: {error}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            {filter.trim() ? 'No sets match your filter.' : 'No sets found for this game.'}
          </div>
        ) : (
          <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="collection-table">
              <thead>
                <tr>
                  <th style={{ width: '48px' }}></th>
                  <th>Set</th>
                  <th>Release</th>
                  <th>Cards</th>
                  <th style={{ width: '110px' }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => {
                  const setCode = bareSetCode(s.id, game);
                  const key = `${game}|${setCode}`;
                  const isBuilt = existingSet.has(key);
                  const isIndexing = buildingSet.has(key) || isActive(progress[key]);
                  const logo = logoFor(s);
                  return (
                    <tr key={s.id}>
                      <td style={{ padding: '0.25rem' }}>
                        {logo ? (
                          <img
                            src={logo}
                            alt=""
                            style={{ width: '36px', height: '36px', objectFit: 'contain', display: 'block', filter: 'invert(1) brightness(1.1)' }}
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        ) : null}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{s.name}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{setCode}</div>
                      </td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{formatDate(s.release_date)}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{s.printed_total || '-'}</td>
                      <td>
                        {isBuilt ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: 'var(--accent-green, #4ade80)' }}>
                            <CheckCircle2 size={14} /> Indexed
                          </span>
                        ) : isIndexing ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>
                            <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> Indexing...
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary"
                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                            onClick={() => handleIndex(game, setCode)}
                          >
                            <Play size={12} /> Index Set
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
