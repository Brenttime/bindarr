import { useState, useEffect, useRef } from 'react';
import {
  Plus, Trash2, X, ChevronLeft, Search, ListChecks, Copy, Pencil,
  Layers, Minus,
} from 'lucide-react';
import CardImage from './CardImage';
import { useBackGuard } from '../utils/useBackGuard';
import { displayName, setReference } from '../utils/languages';
import { useT } from '../utils/i18n';

const ACCENTS = [
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Gold', hex: '#eab308' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Purple', hex: '#a855f7' },
  { name: 'Slate', hex: '#64748b' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Orange', hex: '#f97316' },
];

function Lists({ showToast }) {
  const { t } = useT();

  // View state: 'list' (all lists) or 'detail' (one list's cards)
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeList, setActiveList] = useState(null);
  const [listDetail, setListDetail] = useState(null);

  // List filters
  const [searchTerm, setSearchTerm] = useState('');


  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const [newAccent, setNewAccent] = useState('#10b981');
  const [importText, setImportText] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit modal
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editAccent, setEditAccent] = useState('#10b981');

  // Card search inside detail view
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const searchDebounce = useRef(null);

  // Detail view card filter: 'all' | 'missing' | 'owned'
  const [cardFilter, setCardFilter] = useState('all');

  // True while an add/qty write is in flight (prevents clobbering upserts)
  const [savingCard, setSavingCard] = useState(false);

  useBackGuard(showCreate, () => setShowCreate(false));
  useBackGuard(showEdit, () => setShowEdit(false));
  useBackGuard(!!activeList, () => setActiveList(null));

  useEffect(() => { fetchLists(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchLists = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/lists');
      if (res.ok) setLists(await res.json());
    } catch (err) {
      console.error(err);
      showToast(t('lists.errLoad'));
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setNewName('');
    setNewDesc('');
    setNewAccent('#10b981');
    setImportText('');
    setShowCreate(true);
  };

  const openEdit = () => {
    setEditName(activeList.name);
    setEditDesc(activeList.description || '');
    setEditAccent(activeList.accent_color || '#10b981');
    setShowEdit(true);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          description: newDesc,
          accent_color: newAccent,
          list_text: importText,
        }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.unmatched && data.unmatched.length > 0) {
          showToast(t('lists.importedSummary', {
            matched: data.matched,
            unmatched: t('lists.unmatched', {
              count: data.unmatched.length,
              names: data.unmatched.slice(0, 3).join(', ') + (data.unmatched.length > 3 ? '…' : ''),
            }),
          }));
        } else {
          showToast(t('lists.created'));
        }
        setShowCreate(false);
        fetchLists();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || t('lists.errCreate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('lists.errCreate'));
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!editName.trim()) return;
    try {
      const res = await fetch(`/api/lists/${activeList.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, description: editDesc, accent_color: editAccent }),
      });
      if (res.ok) {
        showToast(t('lists.listUpdated'));
        setShowEdit(false);
        fetchLists();
        loadList(activeList.id);
      } else {
        showToast(t('lists.errUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('lists.errUpdate'));
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t('lists.confirmDelete', { name: activeList.name }))) return;
    try {
      const res = await fetch(`/api/lists/${activeList.id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(t('lists.deleted'));
        setActiveList(null);
        setListDetail(null);
        fetchLists();
      } else {
        showToast(t('lists.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('lists.errDelete'));
    }
  };

  const loadList = async (listId) => {
    try {
      const res = await fetch(`/api/lists/${listId}`);
      if (res.ok) {
        setListDetail(await res.json());
      } else {
        showToast(t('lists.errLoad'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('lists.errLoad'));
    }
  };

  const openList = async (list) => {
    setActiveList(list);
    setCardFilter('all');
    setSearchQuery('');
    setSearchResults([]);
    await loadList(list.id);
  };

  // --- Card search (debounced as the user types) ---
  const doSearch = async (query) => {
    try {
      setSearching(true);
      const q = query;
      const res = await fetch(`/api/search?name=${encodeURIComponent(q)}&limit=24`);
      if (res.ok) {
        setSearchResults(await res.json());
      } else if (res.status === 429) {
        showToast(t('lists.errLoad'));
      } else {
        setSearchResults([]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSearching(false);
    }
  };

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!value.trim()) { setSearchResults([]); return; }
    searchDebounce.current = setTimeout(() => doSearch(value), 350);
  };

  // --- Card quantity management inside the open list ---
  const setQty = async (cardId, qty) => {
    if (savingCard) return;
    if (!Number.isFinite(qty) || qty < 0) return;
    if (qty === 0) { await removeCard(cardId); return; }
    setSavingCard(true);
    try {
      const res = await fetch(`/api/lists/${activeList.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, quantity: qty }),
      });
      if (res.ok) await loadList(activeList.id);
      else showToast(t('lists.errCard'));
    } catch (err) {
      console.error(err);
      showToast(t('lists.errCard'));
    } finally {
      setSavingCard(false);
    }
  };

  const addCard = async (card) => {
    const existing = listDetail?.cards.find(c => c.id === card.id);
    await setQty(card.id, (existing?.quantity || 0) + 1);
    if (!existing) showToast(t('lists.addedCard', { name: displayName(card) }));
  };

  const removeCard = async (cardId) => {
    if (savingCard) return;
    setSavingCard(true);
    try {
      const res = await fetch(`/api/lists/${activeList.id}/cards/${cardId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(t('lists.cardRemoved'));
        await loadList(activeList.id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSavingCard(false);
    }
  };

  // --- Export (the same two shapes as the collection cardlist) ---
  const handleExport = async (style) => {
    try {
      const res = await fetch(`/api/lists/${activeList.id}/cardlist?style=${style}`);
      if (!res.ok) throw new Error('export failed');
      const text = await res.text();
      if (!text) { showToast(t('lists.exportEmpty')); return; }
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Older browsers / non-secure contexts: legacy path.
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showToast(t('lists.exportCopied'));
    } catch (err) {
      console.error(err);
      showToast(t('lists.errExport'));
    }
  };

  // --- Derived data ---
  const filteredLists = lists.filter(l => {
    if (searchTerm && !l.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  const cards = (listDetail?.cards || []).filter(c => {
    if (cardFilter === 'missing') return (c.owned_qty || 0) < c.quantity;
    if (cardFilter === 'owned') return (c.owned_qty || 0) > 0;
    return true;
  });

  // ============================ LIST VIEW ============================
  if (!activeList) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem 1.5rem', background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(15, 23, 42, 0.8))', border: '1px solid rgba(16,185,129,0.25)' }}>
          <div>
            <h2 style={{ fontSize: '1.4rem', color: 'var(--text-strong)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
              <ListChecks size={22} style={{ color: 'var(--accent-green, #10b981)' }} />
              {t('nav.lists')}
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>{t('lists.subtitle')}</p>
          </div>
          <button className="btn btn-primary" onClick={openCreate}
            style={{ padding: '0.6rem 1.25rem', fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> {t('lists.newList')}
          </button>
        </div>

        <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', padding: '1rem 1.25rem' }}>
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '220px' }}>
            <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input type="text" className="input-control" placeholder={t('deck.filterPlaceholder')}
              value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              style={{ paddingLeft: '2.25rem', width: '100%', fontSize: '0.85rem' }} />
          </div>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spinner" /></div>
        ) : filteredLists.length === 0 ? (
          <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 1.5rem', color: 'var(--text-secondary)' }}>
            <ListChecks size={40} style={{ opacity: 0.35, marginBottom: '0.75rem' }} />
            <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{t('lists.empty')}</div>
            <div style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>{t('lists.emptyHint')}</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
            {filteredLists.map(list => {
              const accent = list.accent_color || '#10b981';
              return (
                <div key={list.id} className="glass-panel"
                  style={{
                    display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.25rem',
                    position: 'relative', overflow: 'hidden', cursor: 'pointer',
                    border: `1px solid ${accent}40`,
                    background: `linear-gradient(145deg, ${accent}12, rgba(15,23,42,0.65))`,
                    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                  onClick={() => openList(list)}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = `0 12px 30px ${accent}25`; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
                >
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: `linear-gradient(90deg, ${accent}, ${accent}cc)` }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{list.name}</div>
                      {list.description && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{list.description}</div>}
                    </div>
                    <button className="btn btn-danger btn-icon-only" title={t('deck.deleteDeck')}
                      onClick={e => { e.stopPropagation(); window.confirm(t('lists.confirmDelete', { name: list.name })) && fetch(`/api/lists/${list.id}`, { method: 'DELETE' }).then(() => { showToast(t('lists.deleted')); fetchLists(); }); }}
                      style={{ width: '1.6rem', height: '1.6rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <Layers size={13} /> {t('lists.cards', { count: list.total_card_types || 0 })}
                    </span>
                    <span>{t('lists.total', { count: list.total_cards || 0 })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Create modal */}
        {showCreate && (
          <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
            <div className="glass-panel" style={{ maxWidth: '460px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '1.75rem', position: 'relative', border: '1px solid rgba(255,255,255,0.15)' }}>
              <button className="btn btn-secondary btn-icon-only" onClick={() => setShowCreate(false)}
                style={{ position: 'absolute', top: '0.75rem', right: '0.75rem' }}><X size={16} /></button>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-strong)', margin: '0 0 1rem' }}>{t('lists.newList')}</h3>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('lists.name')}</label>
                  <input className="input-control" value={newName} onChange={e => setNewName(e.target.value)}
                    placeholder={t('lists.namePlaceholder')} autoFocus required style={{ width: '100%' }} />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('lists.descPlaceholder')}</label>
                  <input className="input-control" value={newDesc} onChange={e => setNewDesc(e.target.value)}
                    placeholder={t('lists.descPlaceholder')} style={{ width: '100%' }} />
                </div>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('deck.accentColor')}</label>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.2rem' }}>
                      {ACCENTS.map(a => (
                        <button key={a.hex} type="button" title={a.name}
                          onClick={() => setNewAccent(a.hex)}
                          style={{ width: '22px', height: '22px', borderRadius: '50%', background: a.hex, border: newAccent === a.hex ? '2px solid #fff' : '2px solid transparent', cursor: 'pointer' }} />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('lists.importOptional')}</label>
                  <textarea className="input-control" value={importText} onChange={e => setImportText(e.target.value)}
                    placeholder={t('lists.importPlaceholder')} rows={5}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }} />
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>{t('lists.importHint')}</div>
                </div>
                <button className="btn btn-primary" type="submit" disabled={creating || !newName.trim()}
                  style={{ fontWeight: 700, opacity: creating ? 0.6 : 1 }}>
                  {t('lists.create')}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ============================ DETAIL VIEW ============================
  const accent = activeList.accent_color || '#10b981';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem 1.5rem', border: `1px solid ${accent}40`, background: `linear-gradient(135deg, ${accent}14, rgba(15,23,42,0.8))` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', minWidth: 0 }}>
          <button className="btn btn-secondary btn-icon-only" onClick={() => { setActiveList(null); setListDetail(null); }} title={t('nav.dashboard')}><ChevronLeft size={16} /></button>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--text-strong)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeList.name}</h2>
            {activeList.description && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{activeList.description}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => handleExport('plain')}
            style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Copy size={14} /> {t('lists.exportPlain')}
          </button>
          <button className="btn btn-secondary" onClick={() => handleExport('detailed')}
            style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Copy size={14} /> {t('lists.exportDetailed')}
          </button>
          <button className="btn btn-secondary" onClick={openEdit}
            style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Pencil size={14} /> {t('lists.editList')}
          </button>
          <button className="btn btn-danger" onClick={handleDelete}
            style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Trash2 size={14} /> {t('deck.deleteDeck')}
          </button>
        </div>
      </div>

      {/* Card search to add */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '220px' }}>
            <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input type="text" className="input-control" placeholder={t('lists.searchPlaceholder')}
              value={searchQuery} onChange={e => handleSearchChange(e.target.value)}
              style={{ paddingLeft: '2.25rem', width: '100%', fontSize: '0.85rem' }} />
            {searching && <Search size={14} style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', animation: 'spin 1s linear infinite' }} />}
          </div>
        </div>
        {searchResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '320px', overflowY: 'auto' }}>
            {searchResults.map(card => (
              <div key={card.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.04)' }}>
                <CardImage card={card} alt={displayName(card)}
                  style={{ width: '34px', height: '48px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(card)}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{setReference(card) || ''}</div>
                </div>
                <button className="btn btn-primary" onClick={() => addCard(card)}
                  style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem', display: 'flex', alignItems: 'center', gap: '0.3rem', whiteSpace: 'nowrap' }}>
                  <Plus size={13} /> {t('lists.addCard')}
                </button>
              </div>
            ))}
          </div>
        )}
        {searchQuery.trim() && !searching && searchResults.length === 0 && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '0.5rem' }}>{t('lists.noSearchResults')}</div>
        )}
      </div>

      {/* Filter chips */}
      <div className="glass-panel" style={{ display: 'flex', gap: '0.5rem', padding: '0.6rem 0.9rem', flexWrap: 'wrap' }}>
        {[['all', t('lists.allCards')], ['missing', t('lists.missingOnly')], ['owned', t('lists.ownedOnly')]].map(([val, label]) => (
          <button key={val} type="button"
            className={`sub-nav-tab ${cardFilter === val ? 'active' : ''}`}
            onClick={() => setCardFilter(val)}
            style={{ padding: '0.35rem 0.9rem', fontSize: '0.78rem', fontWeight: 600, borderRadius: 'var(--radius-sm)' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Cards table */}
      {!listDetail ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spinner" /></div>
      ) : cards.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-secondary)' }}>
          <ListChecks size={40} style={{ opacity: 0.35, marginBottom: '0.75rem' }} />
          <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{t('lists.emptyList')}</div>
          <div style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>{t('lists.emptyListHint')}</div>
        </div>
      ) : (
        <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                <th style={{ textAlign: 'left', padding: '0.7rem 1rem', color: 'var(--text-muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('lists.cardCol')}</th>
                <th style={{ textAlign: 'left', padding: '0.7rem 0.5rem', color: 'var(--text-muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('lists.qty')}</th>
                <th style={{ textAlign: 'left', padding: '0.7rem 0.5rem', color: 'var(--text-muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('lists.owned')}</th>
                <th style={{ padding: '0.7rem 1rem' }} />
              </tr>
            </thead>
            <tbody>
              {cards.map(card => {
                const missing = Math.max(0, card.quantity - (card.owned_qty || 0));
                return (
                  <tr key={card.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '0.5rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <CardImage card={card} alt={displayName(card)}
                          style={{ width: '38px', height: '54px', borderRadius: '5px', objectFit: 'cover', flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{displayName(card)}</div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            {setReference(card) || ''}
                            {card.price_trend > 0 && <span style={{ marginLeft: '0.5rem' }}>${card.price_trend.toFixed(2)}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '0.5rem 0.5rem' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                        <button className="btn btn-secondary btn-icon-only" onClick={() => setQty(card.id, card.quantity - 1)}
                          style={{ width: '22px', height: '22px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Minus size={13} /></button>
                        <input type="number" min="0" value={card.quantity}
                          onChange={e => setQty(card.id, parseInt(e.target.value, 10) || 0)}
                          style={{ width: '52px', textAlign: 'center', fontSize: '0.85rem', fontWeight: 700, padding: '0.2rem', borderRadius: 'var(--radius-sm)', background: 'rgba(0,0,0,0.3)', color: 'var(--text-strong)', border: '1px solid rgba(255,255,255,0.15)' }} />
                        <button className="btn btn-secondary btn-icon-only" onClick={() => setQty(card.id, card.quantity + 1)}
                          style={{ width: '22px', height: '22px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={13} /></button>
                      </div>
                    </td>
                    <td style={{ padding: '0.5rem 0.5rem' }}>
                      {missing > 0 ? (
                        <span style={{ color: '#f87171', fontWeight: 700, fontSize: '0.8rem' }}>{t('lists.stillMissing', { count: missing })}</span>
                      ) : (card.owned_qty > 0 ? (
                        <span style={{ color: '#34d399', fontWeight: 700, fontSize: '0.8rem' }}>{t('lists.fullyOwned')}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>0</span>
                      ))}
                    </td>
                    <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>
                      <button className="btn btn-secondary btn-icon-only" onClick={() => removeCard(card.id)} title={t('lists.removeCard')}
                        style={{ width: '26px', height: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit modal */}
      {showEdit && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '420px', width: '100%', padding: '1.75rem', position: 'relative', border: '1px solid rgba(255,255,255,0.15)' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowEdit(false)}
              style={{ position: 'absolute', top: '0.75rem', right: '0.75rem' }}><X size={16} /></button>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-strong)', margin: '0 0 1rem' }}>{t('lists.editList')}</h3>
            <form onSubmit={handleUpdate} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('lists.name')}</label>
                <input className="input-control" value={editName} onChange={e => setEditName(e.target.value)} required style={{ width: '100%' }} />
              </div>
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('lists.descPlaceholder')}</label>
                <input className="input-control" value={editDesc} onChange={e => setEditDesc(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{t('deck.accentColor')}</label>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.2rem' }}>
                  {ACCENTS.map(a => (
                    <button key={a.hex} type="button" title={a.name}
                      onClick={() => setEditAccent(a.hex)}
                      style={{ width: '22px', height: '22px', borderRadius: '50%', background: a.hex, border: editAccent === a.hex ? '2px solid #fff' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowEdit(false)}>{t('lists.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ fontWeight: 700 }}>{t('lists.save')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Lists;
