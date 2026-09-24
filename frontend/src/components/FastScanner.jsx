import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap, ZapOff, ScanLine, Check, X, SwitchCamera, Camera, Sparkles, Trash2, Send } from 'lucide-react';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { priceText } from '../utils/formatPrice';
import { displayName } from '../utils/languages';
import { useT } from '../utils/i18n';
import { FRAME_MAX, fitContain, quadPath } from '../utils/fastScan';
import { loadClientScan, readOnDevice, lastFrameJpeg, hydrateResults, needsServer } from '../utils/clientScan';

// Fast scan. One request per scan: the frame goes up once, the cardscan
// sidecar detects, warps and OCRs every card from the same decoded pixels, and
// cards already identified on the table come back from its identity cache.
// Identity is text-proven (title + collector footer) against Scryfall's full
// printing index, so an answer is an exact printing or nothing.
//
// On-device first: when the phone can run it (utils/clientScan.js), the same
// title + collector-number proof runs locally on a still, in-frame card and
// only the Scryfall id goes to the backend for prices. Anything it cannot
// prove, or a device that cannot load it, uses the server path unchanged.

const AUTO_GAP_MS = 60;
const AUTO_IDLE_MS = 350;

async function grabJpeg(source, sw, sh, canvasRef) {
  const k = Math.min(1, FRAME_MAX / Math.max(sw, sh));
  const w = Math.round(sw * k), h = Math.round(sh * k);
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(w, h);
    oc.getContext('2d').drawImage(source, 0, 0, w, h);
    return oc.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  }
  const c = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.88));
}

export default function FastScanner({ onAddSuccess, showToast }) {
  const { t } = useT();
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const autoRef = useRef(false);
  const timerRef = useRef(null);
  const seenIdsRef = useRef(new Map()); // card.id -> last seen ms (auto de-dupe)
  const onDeviceRef = useRef(false);

  const [service, setService] = useState(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('fastscan.device') || '');
  const [cameraOn, setCameraOn] = useState(false);
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  // Mode switch (like a camera app's photo/video): the side button picks
  // Single or Auto; the shutter acts in that mode. In Auto the shutter starts
  // and stops the continuous loop.
  const [mode, setMode] = useState('auto');   // always opens in Auto
  const [auto, setAuto] = useState(false);   // auto loop running
  const [lists, setLists] = useState([]);
  const [dest, setDest] = useState(() => localStorage.getItem('fastscan.dest') || 'collection');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(0);
  const [latency, setLatency] = useState(null);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState([]);
  const [onDevice, setOnDevice] = useState(false);
  // Change printing: tap a scanned card -> every physical printing of that
  // name (same search the manual add uses) -> tap one to swap it in place.
  const [editKey, setEditKey] = useState(null);
  const [prints, setPrints] = useState(null);   // null = loading, [] = none

  useEffect(() => {
    fetch('/api/lists').then(r => (r.ok ? r.json() : [])).then(d => setLists(Array.isArray(d) ? d : (d.lists || []))).catch(() => {});
  }, []);
  // One-time on-device download, started once the camera is on so opening the
  // tab alone costs nothing. Failure just leaves the server path in charge.
  useEffect(() => {
    if (!cameraOn || onDeviceRef.current) return;
    let live = true;
    loadClientScan().then(r => {
      if (!live) return;
      onDeviceRef.current = r.ok; setOnDevice(r.ok);
      if (!r.ok) console.info('[fastscan] on-device reader unavailable:', r.error);
    });
    return () => { live = false; };
  }, [cameraOn]);
  useEffect(() => {
    fetch('/api/cardscan/status').then(r => setService(r.ok)).catch(() => setService(false));
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    streamRef.current = null;
    setCameraOn(false); setTorch(false);
  }, []);
  useEffect(() => () => { autoRef.current = false; clearTimeout(timerRef.current); stopCamera(); }, [stopCamera]);

  const startCamera = useCallback(async (id = deviceId) => {
    setError('');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(t('fastscan.insecure', { origin: window.location.origin })); return;
    }
    stopCamera();
    const video = { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } };
    if (id) video.deviceId = { exact: id }; else video.facingMode = { ideal: 'environment' };
    try {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
      catch (e) { if (!id) throw e; stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      setTorchOk(!!caps.torch);
      if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      setCameraOn(true);
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === 'videoinput'));
    } catch (e) {
      console.error('camera', e);
      setError(t('fastscan.cameraDenied'));
    }
  }, [deviceId, stopCamera, t]);

  const cycleCamera = () => {
    if (devices.length < 2) return;
    const i = devices.findIndex(d => d.deviceId === deviceId);
    const next = devices[(i + 1) % devices.length].deviceId;
    setDeviceId(next); localStorage.setItem('fastscan.device', next); startCamera(next);
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch); } catch { setTorchOk(false); }
  };

  const drawOverlay = useCallback((frame, candidates, byNumber) => {
    const c = overlayRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!frame || !candidates?.length) return;
    const fit = fitContain(frame, W, H, 'cover');
    for (const cand of candidates) {
      const r = byNumber.get(cand.number);
      const good = r?.ok;
      const color = good ? '#34d399' : cand.eligible ? '#fbbf24' : 'rgba(255,255,255,0.45)';
      const pts = quadPath(cand, fit);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = good ? 18 : 8;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath(); ctx.stroke();
      ctx.shadowBlur = 0;
      if (good) {
        ctx.fillStyle = 'rgba(52,211,153,0.10)'; ctx.fill();
        const label = displayName(r.card);
        ctx.font = '600 13px -apple-system, system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 16;
        const [lx, ly] = pts[0];
        const y = Math.max(4, ly - 28);
        ctx.fillStyle = 'rgba(10,14,24,0.78)';
        ctx.beginPath(); ctx.roundRect(lx, y, tw, 22, 11); ctx.fill();
        ctx.fillStyle = '#ecfdf5'; ctx.fillText(label, lx + 8, y + 15);
      }
    }
  }, []);

  const scan = useCallback(async (source, { autoPass = false } = {}) => {
    if (busyRef.current) return { busy: true };
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return { busy: true };
    busyRef.current = true; setBusy(true);
    if (!autoPass) setError('');
    const t0 = performance.now();
    try {
      let out = null;
      // Shutter press: hedge. The server read starts now, alongside the
      // on-device one, instead of only after the phone gives up — the old
      // sequential fallback is where the 2 s+ scans came from (a ~1.2 s local
      // miss, then a full server read). Auto passes stay sequential so the
      // 60 ms loop does not flood the 2-core sidecar.
      const abort = new AbortController();
      const serverRead = async (blobP) => {
        const r = await fetch('/api/cardscan/frame', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: await blobP, signal: abort.signal });
        if (r.status === 429) return { busy: true };
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || t('fastscan.serviceError'));
        return j;
      };
      const hedged = onDeviceRef.current && !autoPass ? serverRead(grabJpeg(source, sw, sh, canvasRef)) : null;
      hedged?.catch(() => {});
      if (onDeviceRef.current) {
        const local = await readOnDevice(source, sw, sh, { requireStill: autoPass });
        if (local?.error) console.warn('[fastscan] on-device read failed:', local.error);
        // Proven on the phone (or an auto pass the stillness gate held back):
        // done. Anything else — unproven card, no card on a shutter press,
        // failure — goes to the server with the same frame.
        if (!needsServer(local, { autoPass })) {
          out = { ...local, results: await hydrateResults(local.results).catch(() => null) };
          if (!out.results) out = null;
        }
      }
      if (out) abort.abort();
      else if (hedged) out = await hedged;
      else out = await serverRead((async () => (onDeviceRef.current && await Promise.resolve(lastFrameJpeg()).catch(() => null)) || grabJpeg(source, sw, sh, canvasRef))());
      if (out.busy) return { busy: true };
      const ms = Math.round(performance.now() - t0);
      const byNumber = new Map(out.results.map(x => [x.number, x]));
      drawOverlay(out.frame, out.candidates, byNumber);
      const hits = out.results.filter(x => x.ok && x.card);
      const eligible = out.candidates.filter(c => c.eligible).length;
      if (!out.candidates.length) setHint(t('fastscan.hintNoCard'));
      else if (!eligible) setHint(t('fastscan.hintAdjust', { reason: out.candidates[0].status }));
      else if (!hits.length) setHint(t('fastscan.hintHold'));
      else setHint('');

      // Auto: a card that stays on the table must not be re-added every pass.
      const now = Date.now();
      const fresh = hits.filter(h => {
        if (!autoPass) return true;
        const last = seenIdsRef.current.get(h.card.id);
        return !last || now - last > 4000;
      });
      for (const h of hits) seenIdsRef.current.set(h.card.id, now);
      if (fresh.length) {
        setLatency(ms);
        setFlash(f => f + 1);
        navigator.vibrate?.(18);
        const rows = fresh.map(h => ({ key: `${h.card.id}-${now}-${Math.random().toString(36).slice(2, 7)}`, card: h.card, added: false }));
        setResults(prev => [...rows, ...prev].slice(0, 80));
      } else if (!autoPass) {
        setLatency(ms);
      }
      return { matched: fresh.length, none: !out.candidates.length };
    } catch (e) {
      setError(e.message || String(e));
      return { error: true };
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, [drawOverlay, t]);

  const autoLoop = useCallback(async () => {
    if (!autoRef.current) return;
    const v = videoRef.current;
    const r = v && v.readyState >= 2 ? await scan(v, { autoPass: true }) : { busy: true };
    if (!autoRef.current) return;
    timerRef.current = setTimeout(autoLoop, r.none || r.error ? AUTO_IDLE_MS : AUTO_GAP_MS);
  }, [scan]);

  const setAutoRunning = (next) => {
    setAuto(next); autoRef.current = next;
    clearTimeout(timerRef.current);
    if (next) { seenIdsRef.current.clear(); autoLoop(); }
  };
  const toggleMode = () => {
    const next = mode === 'auto' ? 'single' : 'auto';
    if (auto) setAutoRunning(false);
    setMode(next);
  };
  const onShutter = () => {
    if (mode === 'auto') setAutoRunning(!auto);
    else scan(videoRef.current);
  };



  const chooseDest = async (value) => {
    if (value !== '__new') { setDest(value); localStorage.setItem('fastscan.dest', value); return; }
    const name = window.prompt(t('fastscan.newListPrompt'));
    if (!name || !name.trim()) return;
    const r = await fetch('/api/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    const j = await r.json().catch(() => ({}));
    const newId = j.id ?? j.list?.id;
    if (!r.ok || newId == null) { showToast?.(t('fastscan.sendFailed')); return; }
    setLists(prev => [...prev, { id: newId, name: name.trim() }]);
    setDest(String(newId)); localStorage.setItem('fastscan.dest', String(newId));
  };

  // Send every unsent scan to the chosen destination in one request.
  const sendAll = async () => {
    const rows = results.filter(r => !r.sent);
    if (!rows.length || sending) return;
    setSending(true);
    try {
      let r;
      if (dest === 'collection') {
        r = await fetch('/api/collection/bulk-add', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            card_ids: rows.map(row => ({ card_id: row.card.id, quantity: 1, purchase_price: resolveCardPrice(row.card, 'Normal') })),
            quantity: 1, condition: 'Near Mint', printing: 'Normal', language: 'English',
          }),
        });
      } else {
        r = await fetch(`/api/lists/${encodeURIComponent(dest)}/cards/bulk`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cards: rows.map(row => ({ card_id: row.card.id, quantity: 1 })) }),
        });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'send failed');
      const failed = new Set((j.failed || []).map(f => (typeof f === 'object' ? f.card_id : f)));
      const keys = new Set(rows.filter(row => !failed.has(row.card.id)).map(row => row.key));
      setResults(prev => prev.map(x => (keys.has(x.key) ? { ...x, sent: true } : x)));
      const where = dest === 'collection' ? t('fastscan.destCollection') : (lists.find(l => String(l.id) === dest)?.name || t('fastscan.destList'));
      showToast?.(t('fastscan.sent', { count: keys.size, where }));
      if (dest === 'collection') onAddSuccess?.();
    } catch (e) {
      showToast?.(t('fastscan.sendFailed'));
      console.error(e);
    } finally { setSending(false); }
  };

  const openPrintings = async (row) => {
    if (row.sent) return;
    setEditKey(row.key); setPrints(null);
    try {
      const qs = new URLSearchParams({ name: row.card.name, prints: '1', scope: 'internet', limit: '250' });
      const r = await fetch(`/api/search?${qs}`);
      const list = r.ok ? await r.json() : [];
      const same = (Array.isArray(list) ? list : []).filter(c => c.name === row.card.name);
      setPrints(same.length ? same : [row.card]);
    } catch { setPrints([row.card]); }
  };
  const choosePrinting = (card) => {
    setResults(prev => prev.map(x => (x.key === editKey ? { ...x, card } : x)));
    setEditKey(null); setPrints(null);
  };
  const editing = results.find(r => r.key === editKey);

  if (service === false) {
    return <div className="fs-offline glass-panel">{t('fastscan.unavailable')}</div>;
  }

  const pending = results.filter(r => !r.sent).length;
  const priceOf = (card) => Number(resolveCardPrice(card, 'Normal')) || 0;
  const total = results.reduce((sum, r) => sum + priceOf(r.card), 0);
  const currency = results[0]?.card?.price_currency;
  const destValid = dest === 'collection' || lists.some(l => String(l.id) === dest);

  return (
    <div className="fs">
      <div className={`fs-viewfinder${cameraOn ? ' is-live' : ''}`}>
        <video ref={videoRef} playsInline muted className="fs-video" />
        <canvas ref={overlayRef} className="fs-overlay" />
        <div key={flash} className={flash ? 'fs-flash' : ''} />

        <div className="fs-topbar">
          {results.length > 0 && <span className="fs-pill fs-pill-value">{priceText(total, currency)} · {results.length}</span>}
          {latency != null && <span className="fs-pill"><Sparkles size={12} /> {latency} ms</span>}
          {auto && <span className="fs-pill fs-pill-live"><span className="fs-dot" /> {t('fastscan.autoOn')}</span>}
          {onDevice && <span className="fs-pill" title={t('fastscan.onDeviceHint')}>{t('fastscan.onDevice')}</span>}
          <span className="fs-spacer" />
          {torchOk && (
            <button type="button" className="fs-icon" onClick={toggleTorch} aria-label={t('fastscan.torch')}>
              {torch ? <ZapOff size={18} /> : <Zap size={18} />}
            </button>
          )}
          {devices.length > 1 && (
            <button type="button" className="fs-icon" onClick={cycleCamera} aria-label={t('fastscan.camera')}>
              <SwitchCamera size={18} />
            </button>
          )}
        </div>

        {!cameraOn && (
          <div className="fs-empty">
            <div className="fs-empty-icon"><Camera size={28} /></div>
            <div className="fs-empty-title">{t('fastscan.emptyTitle')}</div>
            <div className="fs-empty-sub">{t('fastscan.emptySub')}</div>
            <button type="button" className="fs-cta" onClick={() => startCamera()}>{t('fastscan.startCamera')}</button>
          </div>
        )}

        {cameraOn && (hint || error) && <div className={`fs-hint${error ? ' is-error' : ''}`}>{error || hint}</div>}

        <div className="fs-dock">
          <span className="fs-dock-side" aria-hidden="true" />
          <button
            type="button"
            className={`fs-shutter${busy ? ' is-busy' : ''}${mode === 'auto' ? ' is-auto-mode' : ''}${auto ? ' is-auto' : ''}`}
            disabled={!cameraOn}
            onClick={onShutter}
            aria-label={mode === 'auto' ? t(auto ? 'fastscan.autoStop' : 'fastscan.autoStart') : t('fastscan.scan')}
          ><span /></button>
          <button type="button" className={`fs-icon fs-dock-side${mode === 'auto' ? ' is-on' : ''}`} onClick={toggleMode} aria-pressed={mode === 'auto'} aria-label={t('fastscan.modeToggle')}>
            {mode === 'auto' ? <ScanLine size={20} /> : <Camera size={20} />}
            <span className="fs-dock-label">{mode === 'auto' ? t('fastscan.autoShort') : t('fastscan.single')}</span>
          </button>
        </div>
      </div>

      <div className="fs-tray">
        <div className="fs-tray-head">
          <div>
            <div className="fs-tray-title">{t('fastscan.results', { count: results.length })}</div>
            <div className="fs-tray-total">{priceText(total, currency)}</div>
          </div>
          {results.length > 0 && (
            <button type="button" className="fs-ghost" onClick={() => setResults([])} aria-label={t('fastscan.clear')}><Trash2 size={14} /></button>
          )}
        </div>
        {results.length === 0 ? (
          <div className="fs-tray-empty">{t('fastscan.trayEmpty')}</div>
        ) : (
          <ul className="fs-cards">
            {results.map(row => (
              <li key={row.key} className={`fs-card${row.sent ? ' is-added' : ''}`}>
                <div className="fs-card-art">
                  {row.card.image_url ? <img src={row.card.image_url} alt="" loading="lazy" /> : null}
                  {!row.sent && (
                    <button type="button" className="fs-card-edit" onClick={() => openPrintings(row)} aria-label={t('fastscan.changePrinting')} />
                  )}
                  <button type="button" className="fs-card-x" onClick={() => setResults(prev => prev.filter(r => r.key !== row.key))} aria-label={t('fastscan.dismiss')}><X size={12} /></button>
                  <span className="fs-card-price">{priceText(priceOf(row.card), row.card.price_currency)}</span>
                  {row.sent && <span className="fs-card-badge"><Check size={14} /></span>}
                </div>
                <div className="fs-card-name">{displayName(row.card)}</div>
                <div className="fs-card-meta">{String(row.card.set_id || '').toUpperCase()} · #{row.card.number}</div>
              </li>
            ))}
          </ul>
        )}
        {editing && (
          <div className="fs-sheet-backdrop" onClick={() => setEditKey(null)}>
            <div className="fs-sheet glass-panel" role="dialog" aria-modal="true" aria-label={t('fastscan.changePrinting')} onClick={e => e.stopPropagation()}>
              <div className="fs-sheet-head">
                <div>
                  <div className="fs-tray-title">{displayName(editing.card)}</div>
                  <div className="fs-card-meta">{t('fastscan.changePrinting')}{prints ? ` · ${prints.length}` : ''}</div>
                </div>
                <button type="button" className="fs-ghost" onClick={() => setEditKey(null)} aria-label={t('fastscan.dismiss')}><X size={16} /></button>
              </div>
              {prints == null ? (
                <div className="fs-tray-empty">{t('fastscan.loadingPrintings')}</div>
              ) : (
                <ul className="fs-cards fs-sheet-grid">
                  {prints.map(c => (
                    <li key={c.id} className={`fs-card${c.id === editing.card.id ? ' is-current' : ''}`}>
                      <button type="button" className="fs-print" onClick={() => choosePrinting(c)} aria-pressed={c.id === editing.card.id}>
                        <div className="fs-card-art">
                          {c.image_url ? <img src={c.image_url} alt="" loading="lazy" /> : null}
                          <span className="fs-card-price">{priceText(priceOf(c), c.price_currency)}</span>
                          {c.id === editing.card.id && <span className="fs-card-badge"><Check size={14} /></span>}
                        </div>
                        <div className="fs-card-name">{c.set_name || String(c.set_id || '').toUpperCase()}</div>
                        <div className="fs-card-meta">{String(c.set_id || '').toUpperCase()} · #{c.number}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <div className="fs-send">
          <select className="fs-select" value={destValid ? dest : 'collection'} onChange={(e) => chooseDest(e.target.value)} aria-label={t('fastscan.sendTo')}>
            <option value="collection">{t('fastscan.destCollection')}</option>
            {lists.length > 0 && (
              <optgroup label={t('fastscan.destLists')}>
                {lists.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
              </optgroup>
            )}
            <option value="__new">{t('fastscan.newList')}</option>
          </select>
          <button type="button" className="fs-cta fs-cta-sm" disabled={!pending || sending} onClick={sendAll}>
            <Send size={14} /> {pending ? t('fastscan.sendCount', { count: pending }) : t('fastscan.allSent')}
          </button>
        </div>
      </div>
    </div>
  );
}
