import { useEffect, useMemo, useState } from 'react';
import { Mountain, Plus, Minus, Trash2, Copy, Wand2, RotateCcw, ClipboardPaste, Layers } from 'lucide-react';
import { MANA_TYPES, allocateMana } from '../utils/landMana.js';
import { sourceOdds } from '../utils/landOdds.js';
import { useT } from '../utils/i18n';

// Limited (40-card) land-base calculator. Ported from the standalone Land Desk
// tool; the allocation/odds engines are the same tested modules. Improvements:
// counts pips from a pasted decklist or a Bindarr deck, and shows every
// color's early-play odds at once.

const STORAGE_KEY = 'bindarr_limited_lands_v1';
const IDS = MANA_TYPES.map(m => m.id);
const zeros = () => Object.fromEntries(IDS.map(id => [id, 0]));
const fresh = () => ({ total: 17, deckSize: 40, pips: zeros(), existing: [] });
const whole = (n, max, min = 0) => Number.isInteger(n) && n >= min && n <= max;
const MANA_COLOR = { W: '#f8e7b9', U: '#0e68ab', B: '#a69f9d', R: '#d3202a', G: '#00733e', C: '#b8b3ae' };
const sym = id => `/mana/${id}.svg`;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!s) return fresh();
    const st = fresh();
    if (whole(s.total, 40)) st.total = s.total;
    if (whole(s.deckSize, 99, 40)) st.deckSize = s.deckSize;
    for (const id of IDS) if (whole(s.pips?.[id], 999)) st.pips[id] = s.pips[id];
    if (Array.isArray(s.existing)) st.existing = s.existing.slice(0, 40).filter(r => r && whole(r.quantity, 40, 1)
      && Array.isArray(r.produces) && r.produces.every(id => IDS.includes(id)))
      .map((r, i) => ({ uid: i + 1, name: String(r.name || ''), quantity: r.quantity, produces: [...new Set(r.produces)], tapped: !!r.tapped, conditional: !!r.conditional }));
    return st;
  } catch { return fresh(); }
}

const pct = p => `${Math.round(p * 100)}%`;

function Stepper({ value, onChange, min = 0, max = 999, label, big = false }) {
  const set = v => onChange(Math.max(min, Math.min(max, v)));
  return (
    <div className="ll-stepper" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button type="button" className="btn btn-secondary btn-icon-only" style={{ padding: big ? '0.5rem' : '0.3rem' }} aria-label={`${label} minus`} disabled={value <= min} onClick={() => set(value - 1)}><Minus size={big ? 16 : 13} /></button>
      <input type="number" className="form-input" aria-label={label} value={value} min={min} max={max}
        onChange={e => { const n = e.target.valueAsNumber; if (whole(n, max, min)) onChange(n); }}
        style={{ width: big ? 72 : 56, textAlign: 'center', fontWeight: 800, fontSize: big ? '1.4rem' : '1rem', padding: '0.3rem', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }} />
      <button type="button" className="btn btn-secondary btn-icon-only" style={{ padding: big ? '0.5rem' : '0.3rem' }} aria-label={`${label} plus`} disabled={value >= max} onClick={() => set(value + 1)}><Plus size={big ? 16 : 13} /></button>
    </div>
  );
}

const panelTitle = { margin: 0, fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-strong)' };
const eyebrow = { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase', margin: '0 0 0.25rem' };
const helper = { color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.45, margin: '0.5rem 0 0' };

export default function LimitedLands({ showToast }) {
  const { t } = useT();
  const [state, setState] = useState(load);
  const [undo, setUndo] = useState(null);
  const [paste, setPaste] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState('');
  const [decks, setDecks] = useState([]);
  const [deckPick, setDeckPick] = useState('');
  const [check, setCheck] = useState({ needed: 1, turn: 3, onDraw: false });

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage optional */ } }, [state]);
  useEffect(() => {
    fetch('/api/decks').then(r => r.ok ? r.json() : []).then(a => setDecks(Array.isArray(a) ? a.filter(d => (d.target_size || 100) <= 60) : [])).catch(() => {});
  }, []);

  const patch = fn => setState(s => { const n = structuredClone(s); fn(n); return n; });
  const existingCount = state.existing.reduce((a, l) => a + l.quantity, 0);
  const totalPips = IDS.reduce((a, id) => a + state.pips[id], 0);

  const { result, issue } = useMemo(() => {
    if (existingCount > state.total) return { result: null, issue: t('limited.overBudget') };
    try {
      const r = allocateMana(state.total, state.pips, state.existing.map(({ quantity, produces, tapped, conditional }) => ({ quantity, produces, tapped, conditional })));
      return { result: (r.hasPips || r.remainingBasics === 0) ? r : null, issue: '' };
    } catch { return { result: null, issue: t('limited.checkInputs') }; }
  }, [state, existingCount, t]);

  const analyze = async (text, source) => {
    setImporting(true); setImportNote('');
    try {
      const r = await fetch('/api/limited/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ list: text }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setUndo(state);
      patch(s => {
        s.pips = { ...zeros(), ...j.pips };
        s.existing = j.lands.map((l, i) => ({ uid: i + 1, ...l }));
        if (j.landCount >= 10 && j.landCount <= 20) s.total = j.landCount;
        if (j.deckSize >= 40 && j.deckSize <= 99) s.deckSize = j.deckSize;
      });
      const parts = [t('limited.importDone', { spells: j.spells, lands: j.lands.reduce((a, l) => a + l.quantity, 0), source })];
      if (j.notFound?.length) parts.push(t('limited.notFound', { names: j.notFound.slice(0, 5).join(', ') }));
      setImportNote(parts.join(' '));
    } catch (e) {
      setImportNote(t('limited.importFailed', { error: e.message }));
    } finally { setImporting(false); }
  };

  const loadDeck = async () => {
    if (!deckPick) return;
    const r = await fetch(`/api/decks/${deckPick}`); if (!r.ok) return;
    const d = await r.json();
    const text = (d.cards || []).filter(c => c.quantity > 0).map(c => `${c.quantity} ${c.name}`).join('\n');
    analyze(text, d.name);
  };

  const copyList = async () => {
    if (!result) return;
    const lines = [`${t('limited.title')} · ${state.total} ${t('limited.lands')}`, '',
      ...MANA_TYPES.filter(m => result.basics[m.id] > 0).map(m => `${result.basics[m.id]} ${m.land}`),
      ...state.existing.map(l => `${l.quantity} ${l.name || IDS.filter(id => l.produces.includes(id)).join('/') + ' land'}`)];
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); showToast?.(t('limited.copied'), 'success'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { /* reported below */ } ta.remove();
      showToast?.(ok ? t('limited.copied') : t('limited.copyFailed'), ok ? 'success' : 'error');
    }
  };

  const reset = () => { setUndo(state); setState(fresh()); setImportNote(''); };
  const nonland = state.deckSize - state.total;
  const activeColors = MANA_TYPES.filter(m => state.pips[m.id] > 0);
  const hints = [];
  if (result) {
    if (activeColors.filter(m => m.id !== 'C').length >= 3) hints.push(t('limited.hintThreeColor'));
    for (const m of activeColors) {
      const s = result.sources[m.id];
      if (s === 0) hints.push(t('limited.hintZero', { color: m.name }));
      else if (s <= 3) hints.push(t('limited.hintLow', { color: m.name, count: s }));
    }
    if (result.basics.C > 0) hints.push(t('limited.hintWastes'));
  }
  const curveNote = state.total === 17 ? t('limited.curve17') : state.total === 16 ? t('limited.curve16') : state.total === 18 ? t('limited.curve18') : t('limited.curveOther');

  const card = { padding: '1.25rem' };
  const manaBtn = (on, id) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0.3rem 0.5rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
    border: `1px solid ${on ? MANA_COLOR[id] : 'var(--border-glass)'}`, background: on ? `${MANA_COLOR[id]}33` : 'var(--surface-1)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.78rem',
  });

  return (
    <div className="limited-lands" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Mountain size={24} style={{ color: 'var(--accent-red)' }} /> {t('limited.title')}
          </h2>
          <p style={{ ...helper, marginTop: '0.25rem' }}>{t('limited.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {undo && <button type="button" className="btn btn-secondary" onClick={() => { setState(undo); setUndo(null); }}><RotateCcw size={15} /> {t('limited.undo')}</button>}
          <button type="button" className={`btn ${showImport ? 'btn-primary' : 'btn-secondary'}`} aria-expanded={showImport} onClick={() => setShowImport(v => !v)}><ClipboardPaste size={15} /> {t('limited.pasteList')}</button>
          <button type="button" className="btn btn-secondary" onClick={reset}>{t('limited.reset')}</button>
        </div>
      </div>

      {showImport && (
        <section className="glass-panel" style={{ padding: '0.75rem 1rem' }}>
            <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={3} placeholder={t('limited.pastePlaceholder')}
              style={{ width: '100%', marginTop: 0, padding: '0.5rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', resize: 'vertical', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
              <button type="button" className="btn btn-primary" disabled={!paste.trim() || importing} onClick={() => analyze(paste, t('limited.pastedList'))}><ClipboardPaste size={15} /> {importing ? t('limited.counting') : t('limited.countPips')}</button>
              {decks.length > 0 && (
                <div style={{ display: 'flex', gap: '0.4rem', flex: 1, minWidth: 220 }}>
                  <select value={deckPick} onChange={e => setDeckPick(e.target.value)} className="form-input" style={{ flex: 1, padding: '0.5rem', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
                    <option value="">{t('limited.pickDeck')}</option>
                    {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  <button type="button" className="btn btn-secondary" disabled={!deckPick || importing} onClick={loadDeck}><Layers size={15} /> {t('limited.load')}</button>
                </div>
              )}
            </div>
            {importNote && <p style={{ ...helper, color: 'var(--text-primary)' }}>{importNote}</p>}
            <p style={helper}>{t('limited.importHelp')}</p>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        {/* ---------- Inputs ---------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <section className="glass-panel" style={card}>
            <p style={eyebrow}>01 · {t('limited.stepTotal')}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <h3 style={panelTitle}>{t('limited.totalTitle')}</h3>
              <div style={{ display: 'flex', gap: 6 }}>
                {[16, 17, 18].map(n => (
                  <button key={n} type="button" className={`btn ${state.total === n ? 'btn-primary' : 'btn-secondary'}`} style={{ padding: '0.35rem 0.7rem' }} onClick={() => patch(s => { s.total = n; })}>{n}</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
              <Stepper big value={state.total} max={40} label={t('limited.totalTitle')} onChange={v => patch(s => { s.total = v; })} />
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('limited.skeleton', { lands: state.total, spells: Math.max(0, nonland), deck: state.deckSize })}</span>
            </div>
            <p style={helper}>{curveNote}</p>
          </section>

          <section className="glass-panel" style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div><p style={eyebrow}>02 · {t('limited.stepPips')}</p><h3 style={panelTitle}>{t('limited.pipsTitle')}</h3></div>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{t('limited.pipCount', { count: totalPips })}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.6rem', marginTop: '0.75rem' }}>
              {MANA_TYPES.map(m => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0.45rem 0.55rem', borderRadius: 'var(--radius-sm)', background: state.pips[m.id] ? `${MANA_COLOR[m.id]}1f` : 'var(--surface-1)', border: `1px solid ${state.pips[m.id] ? MANA_COLOR[m.id] + '66' : 'var(--border-glass)'}` }}>
                  <img src={sym(m.id)} alt={m.name} title={m.id === 'C' ? t('limited.colorlessCost') : m.name} width={22} height={22} />
                  <Stepper value={state.pips[m.id]} label={`${m.name} pips`} onChange={v => patch(s => { s.pips[m.id] = v; })} />
                </div>
              ))}
            </div>
            <p style={helper}>{t('limited.pipsHelp')}</p>
          </section>

          <section className="glass-panel" style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div><p style={eyebrow}>03 · {t('limited.stepLands')}</p><h3 style={panelTitle}>{t('limited.landsTitle')}</h3></div>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{t('limited.landCount', { count: existingCount })}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.75rem' }}>
              {state.existing.map((l, i) => (
                <div key={l.uid} style={{ padding: '0.6rem', borderRadius: 'var(--radius-sm)', background: 'var(--surface-1)', border: '1px solid var(--border-glass)' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Stepper value={l.quantity} min={1} max={40} label={`Land ${i + 1} quantity`} onChange={v => patch(s => { s.existing[i].quantity = v; })} />
                    <input value={l.name} placeholder={t('limited.landName')} onChange={e => { const v = e.target.value; patch(s => { s.existing[i].name = v; }); }}
                      style={{ flex: 1, minWidth: 120, padding: '0.4rem', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }} />
                    <button type="button" className="btn btn-secondary btn-icon-only" style={{ padding: '0.35rem' }} aria-label={t('limited.remove')} onClick={() => patch(s => { s.existing.splice(i, 1); })}><Trash2 size={14} /></button>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: '0.5rem' }}>
                    {MANA_TYPES.map(m => {
                      const on = l.produces.includes(m.id);
                      return <button key={m.id} type="button" aria-pressed={on} style={manaBtn(on, m.id)} onClick={() => patch(s => { const p = s.existing[i].produces; s.existing[i].produces = on ? p.filter(x => x !== m.id) : [...p, m.id]; })}><img src={sym(m.id)} alt="" width={14} height={14} />{m.id === 'C' ? '◇' : m.id}</button>;
                    })}
                    <button type="button" style={manaBtn(false, 'C')} onClick={() => patch(s => { s.existing[i].produces = ['W', 'U', 'B', 'R', 'G']; })}>{t('limited.anyColor')}</button>
                  </div>
                  <div style={{ display: 'flex', gap: '1rem', marginTop: '0.45rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={l.tapped} onChange={e => { const v = e.target.checked; patch(s => { s.existing[i].tapped = v; }); }} /> {t('limited.tapped')}</label>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={l.conditional} onChange={e => { const v = e.target.checked; patch(s => { s.existing[i].conditional = v; }); }} /> {t('limited.conditional')}</label>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-secondary" style={{ marginTop: '0.6rem' }} disabled={state.existing.length >= 40}
              onClick={() => patch(s => { s.existing.push({ uid: Date.now(), name: '', quantity: 1, produces: [], tapped: false, conditional: false }); })}><Plus size={15} /> {t('limited.addLand')}</button>
            <p style={{ ...helper, color: existingCount > state.total ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
              {t('limited.budget', { total: state.total, existing: existingCount, basics: state.total - existingCount })}
            </p>
            <p style={helper}>{t('limited.landsHelp')}</p>
          </section>
        </div>

        {/* ---------- Result ---------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', position: 'sticky', top: '1rem' }}>
          <section className="glass-panel" style={card}>
            <p style={eyebrow}>{t('limited.resultEyebrow')}</p>
            <h3 style={{ ...panelTitle, fontSize: '1.3rem' }}>{t('limited.resultTitle')}</h3>
            {!result ? (
              <div style={{ padding: '2rem 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: '0.75rem', opacity: 0.5 }}>{['W', 'U', 'B', 'R', 'G'].map(id => <img key={id} src={sym(id)} alt="" width={26} height={26} />)}</div>
                {issue || t('limited.empty')}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', margin: '0.75rem 0 0.5rem' }}>
                  <span style={{ fontSize: '2.6rem', fontWeight: 900, color: 'var(--text-strong)', lineHeight: 1 }}>{result.remainingBasics}</span>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('limited.basicsToAdd')}</span>
                </div>
                <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--surface-2)', marginBottom: '0.9rem' }}>
                  {MANA_TYPES.filter(m => result.basics[m.id] > 0).map(m => <span key={m.id} style={{ flex: result.basics[m.id], background: MANA_COLOR[m.id] }} />)}
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  {MANA_TYPES.filter(m => state.pips[m.id] > 0 || result.basics[m.id] > 0).map(m => (
                    <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.55rem 0.7rem', borderRadius: 'var(--radius-sm)', background: 'var(--surface-1)', border: '1px solid var(--border-glass)' }}>
                      <img src={sym(m.id)} alt="" width={26} height={26} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800, color: 'var(--text-strong)' }}>{m.land}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('limited.rowDetail', { pips: state.pips[m.id], sources: result.sources[m.id], untapped: result.untappedSources[m.id] })}</div>
                      </div>
                      <strong style={{ fontSize: '1.5rem', color: 'var(--text-strong)' }}>{result.basics[m.id]}</strong>
                    </li>
                  ))}
                </ul>
                <p style={helper}>{t('limited.equation', { basics: result.remainingBasics, existing: result.existingCount, total: state.total })}</p>
                {hints.length > 0 && (
                  <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.3)', fontSize: '0.8rem', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {hints.map(h => <span key={h}>{h}</span>)}
                  </div>
                )}
                <button type="button" className="btn btn-primary" style={{ width: '100%', marginTop: '0.9rem' }} onClick={copyList}><Copy size={15} /> {t('limited.copy')}</button>
              </>
            )}
          </section>

          {result && activeColors.length > 0 && (
            <section className="glass-panel" style={card}>
              <p style={eyebrow}>{t('limited.oddsEyebrow')}</p>
              <h3 style={panelTitle}>{t('limited.oddsTitle')}</h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '0.75rem 0' }}>
                {[['needed', [1, 2, 3], n => t('limited.symbols', { count: n })], ['turn', [1, 2, 3, 4, 5, 6, 7, 8], n => t('limited.turn', { n })]].map(([key, opts, lab]) => (
                  <select key={key} value={check[key]} onChange={e => { const v = Number(e.target.value); setCheck(c => ({ ...c, [key]: v })); }}
                    style={{ padding: '0.4rem', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
                    {opts.map(n => <option key={n} value={n}>{lab(n)}</option>)}
                  </select>
                ))}
                <div style={{ display: 'flex' }}>
                  {[false, true].map(d => <button key={String(d)} type="button" className={`btn ${check.onDraw === d ? 'btn-primary' : 'btn-secondary'}`} style={{ padding: '0.35rem 0.7rem' }} onClick={() => setCheck(c => ({ ...c, onDraw: d }))}>{d ? t('limited.onDraw') : t('limited.onPlay')}</button>)}
                </div>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {activeColors.map(m => {
                  const deck = Math.max(state.deckSize, state.total, 7);
                  const all = sourceOdds({ deck, sources: result.sources[m.id], needed: check.needed, turn: check.turn, onDraw: check.onDraw });
                  const un = sourceOdds({ deck, sources: result.untappedSources[m.id], needed: check.needed, turn: check.turn, onDraw: check.onDraw });
                  const good = all.probability >= 0.85, ok = all.probability >= 0.7;
                  const col = good ? 'var(--success)' : ok ? 'var(--accent-yellow)' : 'var(--accent-red)';
                  return (
                    <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <img src={sym(m.id)} alt={m.name} width={20} height={20} />
                      <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}><div style={{ width: pct(all.probability), height: '100%', background: col }} /></div>
                      <strong style={{ width: 44, textAlign: 'right', color: col }}>{pct(all.probability)}</strong>
                      {un.probability < all.probability - 0.005 && <span title={t('limited.untappedOnly')} style={{ fontSize: '0.72rem', color: 'var(--text-muted)', width: 64 }}>{t('limited.untappedShort', { p: pct(un.probability) })}</span>}
                    </li>
                  );
                })}
              </ul>
              <p style={helper}>{t('limited.oddsHelp', { seen: sourceOdds({ deck: Math.max(state.deckSize, 7), sources: 0, turn: check.turn, onDraw: check.onDraw }).seen, deck: state.deckSize })}</p>
            </section>
          )}

          <section className="glass-panel" style={{ ...card, display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
            <Wand2 size={18} style={{ color: 'var(--accent-yellow)', flexShrink: 0, marginTop: 2 }} />
            <p style={{ ...helper, margin: 0 }}>{t('limited.footnote')}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
