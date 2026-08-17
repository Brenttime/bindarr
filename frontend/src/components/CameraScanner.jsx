import { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Zap, ZapOff, Settings, ScanLine, Layers, ListFilter } from 'lucide-react';
import confetti from 'canvas-confetti';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { CONDITIONS, getPrintings } from '../utils/cardOptions';
import CardEntryFields from './CardEntryFields';
import CardInspectorModal from './CardInspectorModal';
import { useBackGuard } from '../utils/useBackGuard';
import { useMultiSelect } from '../utils/useMultiSelect';
import { LANGUAGES, langName } from '../utils/languages';
import { requestDetect, stopDetect, smoothQuad, quadDrift, DETECT_W } from '../utils/cardDetector';
import { defaultGame, gameOptions, showGamePicker } from '../utils/games';
import { isNative } from '../apiBase';
import { useT } from '../utils/i18n';
// Centered card-shaped guide box, styled in CSS (.scan-card-guide): card ratio
// with margin, centered by the overlay's flex. The crop maps the box's on-screen
// rect (getBoundingClientRect) into the frame, so its size is driven by CSS.
// Confidence gates for the server match. When ORB geometric verification ran
// (verified=true), gate on inlier count; otherwise on CLIP cosine similarity.
// Below the gate the scan shows the candidates for manual selection.
const SCAN_MATCH_MIN_SCORE = 0.55;
const SCAN_MATCH_MIN_INLIERS = 12;
// Margin around the guide box when cropping. The box is an aim hint and a card
// can overhang it, so the crop runs slightly wider than the box itself.
const CROP_PAD = 0.05;
// Live-outline cadence. Detection is local, so this is bounded by CPU rather
// than by a network round trip: ~80ms per frame on a desktop, ~300ms on a phone.
// The loop is self-pacing, so a slower device simply updates less often.
const DETECT_INTERVAL_MS = 80;
// How still the corners must be, in normalised units, to count a frame as steady.
const STEADY_DRIFT = 0.012;
// Consecutive steady frames before auto-capture will fire.
const STEADY_FRAMES_NEEDED = 3;
// Scan-detail presets (quick↔accurate slider). Higher index = more upload
// resolution, deeper server CLIP recall + more ORB features, longer cooldown:
// slower but more accurate. Lower = faster, less accurate. Turbo keeps ORB
// verify but with the fewest recall candidates + features — leanest ORB pass.
const SCAN_PROFILES = [
  // uploadW floors at 720 even on the fastest preset: the guide crop is already
  // most of the way down from the capture, so a 400px upload delivered a ~250px
  // card, and exact-printing measures 76.0% at 250px against 91.0% at 420px.
  // That is 15 points given away for a few KB of JPEG, not a speed/accuracy
  // trade — recallK and orb below are where the real trade lives.
  { label: 'Turbo',    uploadW: 720,  cooldown: 400,  countdown: 0, recallK: 28,  orb: 240, cadence: 2000 },
  { label: 'Fast',     uploadW: 800,  cooldown: 1200, countdown: 1, recallK: 60,  orb: 300 },
  { label: 'Balanced', uploadW: 900,  cooldown: 2000, countdown: 2, recallK: 120, orb: 400 },
  { label: 'Accurate', uploadW: 1280, cooldown: 3000, countdown: 2, recallK: 250, orb: 500 },
];

function CameraScanner({ onAddSuccess, showToast }) {
  const { t } = useT();

  const [stream, setStream] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanMatches, setScanMatches] = useState([]);
  
  // UX scan history & effects states
  const [recentScans, setRecentScans] = useState([]);
  // Tap a recent scan to view/edit it; long-press to delete. Inspector reuses the
  // shared collection edit/delete modal (needs an entry-shaped object with entry_id).
  const [inspectorEntry, setInspectorEntry] = useState(null);
  // Long-press multi-select + bulk actions, same as the collection page.
  const recentSelect = useMultiSelect({
    showToast,
    onChanged: ({ ids, action }) => {
      onAddSuccess();
      // Recent scans is a local list: prune deleted tiles. Moves leave the tile
      // (its placement label just goes stale until the next scan).
      if (action === 'delete') setRecentScans(prev => prev.filter(s => !ids.includes(s.entry_id)));
    },
  });
  const [scanFlash, setScanFlash] = useState(null); // 'capture', 'error', or null
  // Fixed-cadence capture countdown (Turbo): ms remaining until the next photo,
  // or null when the metronome isn't running. Drives the countdown ring.
  const [captureCountdown, setCaptureCountdown] = useState(null);
  // Draggable/rotatable scan guide: translate (px, relative to centered) + angle
  // (deg). Lets the user aim the crop at an off-center or tilted card.
  // Latest detector result for the live outline, or null. Kept small on purpose:
  // { detected, quad(0..1 of the CROP), pick }.
  const [detectQuad, setDetectQuad] = useState(null);
  const [showDetectOutline, setShowDetectOutline] = useState(() => localStorage.getItem('scan_outline') !== '0');
  const outlineCanvas = useRef(null);   // one canvas, reused every update
  const smoothed = useRef(null);        // eased corners, what actually gets drawn
  const lastRawQuad = useRef(null);     // previous RAW detection, for drift
  const steadyFrames = useRef(0);       // consecutive low-drift detections
  const bestFrame = useRef(null);       // latest { sharp, fill, steady } for capture gating
  const [guideOffset, setGuideOffset] = useState({ x: 0, y: 0 });
  const [guideAngle, setGuideAngle] = useState(0);
  const [guideScale, setGuideScale] = useState(1);
  const guidePtrs = useRef(new Map());     // active pointerId -> {x,y}
  const guideGesture = useRef(null);        // snapshot taken at each pointer-count change
  
  // Camera active states
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraErrorKey, setCameraErrorKey] = useState('');
  const [autoScan, setAutoScan] = useState(false);
  const [showScanSettings, setShowScanSettings] = useState(false);
  // Scan detail level: index into SCAN_PROFILES. Persisted; default Balanced.
  const [scanDetail, setScanDetail] = useState(() => {
    const v = parseInt(localStorage.getItem('scan_detail'), 10);
    return Number.isInteger(v) && v >= 0 && v < SCAN_PROFILES.length ? v : 2;
  });
  const profile = SCAN_PROFILES[scanDetail];
  // Torch/Flashlight control
  const [isTorchOn, setIsTorchOn] = useState(false);
  // Manual exposure: caps ({min,max,step}) if the track exposes
  // exposureCompensation, else null (slider hidden). value = current setting.
  const [exposureCaps, setExposureCaps] = useState(null);
  const [exposure, setExposure] = useState(0);
  const [cardLayout, setCardLayout] = useState(() => (defaultGame() === 'mtg' ? 'mtg' : 'modern'));
  // Per-set index prep state for MTG set-scoped matching: 'idle'|'building'|'ready'.
  const [setPrep, setSetPrep] = useState('idle');
  // Build progress while status==='building': { total, done, status } or null.
  const [setBuildProgress, setSetBuildProgress] = useState(null);
  // Why a set index could not be built, when setPrep === 'error'.
  const [setBuildError, setSetBuildError] = useState(null);
  // Which game the current layout belongs to. 'mtg' is its own layout; every
  // other layout value is a Pokémon sub-layout.
  const scanGame = cardLayout === 'mtg' ? 'mtg' : 'pokemon';
  // Which language of card is being fed in. Card art is language-specific, so
  // this selects which set index the scan is matched against — and it becomes the
  // language each added copy is recorded as. Remembered across sessions because
  // people scan a language at a time.
  const [scanLang, setScanLangState] = useState(() => localStorage.getItem('scanner_lang') || 'en');
  const setScanLang = (code) => { setScanLangState(code); localStorage.setItem('scanner_lang', code); };
  // Set-scoped scanning across one OR MORE sets (both games). Persisted per game
  // as a comma-joined code list so switching Pokémon<->MTG restores that game's
  // sets. Scanning within the chosen sets (~300 cards each) is far more accurate
  // than a global search.
  const [scanSetCodes, setScanSetCodesState] = useState([]);
  // Set codes do not carry across languages (Japan has sets the West never got),
  // so they are remembered per game AND language. English keeps the original key
  // so an existing scanner setup is not forgotten.
  const setsKey = (game, lang) => (lang === 'en' ? `scanner_set_${game}` : `scanner_set_${game}_${lang}`);
  const persistSets = (arr) => { setScanSetCodesState(arr); localStorage.setItem(setsKey(scanGame, scanLang), arr.join(',')); };
  const addSetCode = (code) => { const c = (code || '').trim(); if (c && !scanSetCodes.some(x => x.toLowerCase() === c.toLowerCase())) persistSets([...scanSetCodes, c]); };
  const removeSetCode = (code) => persistSets(scanSetCodes.filter(c => c !== code));
  const scanSetParam = scanSetCodes.join(',');
  const [setInput, setSetInput] = useState('');
  const [setList, setSetList] = useState([]);        // {id,name,...} for the active game
  // What a no-set-code scan can currently recognise for this game+language, so the
  // scanner can say whether leaving the set blank will work AT ALL rather than
  // letting the user find out by getting no match. Readable by any logged-in user.
  const [indexStatus, setIndexStatus] = useState(null);
  const [setSearchOpen, setSetSearchOpen] = useState(false);
  // Code fed to the scanner: pokemontcg.io set id as-is; for MTG the bare
  // Scryfall code (sets.id is stored prefixed as "mtg-<code>").
  const setScanCode = (s) => scanGame === 'mtg' ? (s.ptcgo_code || (s.id || '').replace(/^mtg-/, '')) : s.id;
  const setQuery = setInput.trim().toLowerCase();
  const setSuggestions = setQuery
    ? setList.filter(s => !scanSetCodes.some(c => c.toLowerCase() === (setScanCode(s) || '').toLowerCase())
        && [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase().includes(setQuery))).slice(0, 8)
    : [];
  // Resolve a code to its set record so the UI can show the full name next to
  // the code (e.g. "Foundations (FDN)"). Falls back to the bare code for
  // free-typed sets not in the cached list.
  const labelForCode = (code) => { const m = setList.find(s => (setScanCode(s) || '').toLowerCase() === code.toLowerCase()); return m ? `${m.name} (${setScanCode(m)})` : code; };
  const setLabelJoined = scanSetCodes.map(labelForCode).join(', ');

  const [debugHashImg, setDebugHashImg] = useState('');
  const [debugCandidates, setDebugCandidates] = useState([]);
  const [debugScoped, setDebugScoped] = useState(null); // set code if set-scoped, false if global, null if n/a

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const currentScanId = useRef(0);

  // Auto-capture duplicate guard: a physical card lingers in frame across the
  // 3s auto-scan cycle. lastAddedId = the card just auto-added; a repeat match
  // of it means "same card again" — confirm a real 2nd copy vs a re-scan.
  // resolvedDupId = a repeat we already settled; skip it silently until a
  // different card appears (stops a re-prompt loop while it stays in view).
  const lastAddedIdRef = useRef(null);
  const resolvedDupIdRef = useRef(null);
  const beepCtxRef = useRef(null); // reused AudioContext for the scan cue
  const handleCaptureRef = useRef(null); // always the latest handleCapture, for timers
  // Same trick for the capture gate: the metronome interval closes over its first
  // render, so it needs a ref to reach the current predicate.
  const frameWorthCaptureRef = useRef(null);
  const captureBlockedRef = useRef(false); // true while a modal/picker/drawer is up
  const loadingRef = useRef(false); // mirrors `loading` for the metronome interval

  // Instant feedback cue: flash the guide-box border, click, and (on mobile)
  // vibrate. 'capture' fires the instant the photo is grabbed so the user can
  // move the card immediately; 'error' marks a failed/no-match scan. Web Audio
  // only (no asset/lib); no-ops if the browser blocks audio until a gesture.
  const signal = (type) => {
    setScanFlash(type);
    setTimeout(() => setScanFlash(null), type === 'capture' ? 400 : 1500);
    if (type === 'capture' && navigator.vibrate) navigator.vibrate(30);
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = beepCtxRef.current || (beepCtxRef.current = new AC());
      const play = () => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = type === 'capture' ? 'square' : 'sine';
        osc.frequency.value = type === 'error' ? 300 : 660; // capture = crisp click
        osc.connect(gain); gain.connect(ctx.destination);
        const dur = type === 'capture' ? 0.05 : 0.15; // short = click, long = tone
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        osc.start(); osc.stop(ctx.currentTime + dur);
      };
      // Mobile auto-suspends the context between non-gesture captures; resume is
      // async, so scheduling into a suspended context is silent. Play only once
      // it's actually running.
      if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {});
      else play();
    } catch { /* audio unavailable — visual flash still fires */ }
  };

  const handleCancelScan = () => {
    currentScanId.current += 1;
    setLoading(false);
    setScanStatus('Scan cancelled.');
    setTimeout(() => {
      setScanStatus(prev => prev === 'Scan cancelled.' ? '' : prev);
    }, 2000);
  };

  // Guide box drag/rotate/scale. Pointer capture on the box routes all move/up
  // events here. One finger = move; two fingers = pinch-scale + twist-rotate +
  // drag by the midpoint. Snapshot is re-taken on every pointer-count change so
  // switching finger count rebases smoothly.
  const snapshotGuideGesture = () => {
    const el = document.querySelector('.scan-card-guide');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const base = {
      startOffset: guideOffset, startAngle: guideAngle, startScale: guideScale,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
    };
    const pts = [...guidePtrs.current.values()];
    if (pts.length >= 2) {
      const [p, q] = pts;
      guideGesture.current = {
        mode: 'pinch', ...base,
        d0: Math.hypot(q.x - p.x, q.y - p.y) || 1,
        a0: Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI,
        mid0: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
      };
    } else if (pts.length === 1) {
      guideGesture.current = { mode: 'move', ...base, startX: pts[0].x, startY: pts[0].y };
    } else {
      guideGesture.current = null;
    }
  };
  const onGuidePointerDown = (e) => {
    guidePtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshotGuideGesture();
    e.stopPropagation();
  };
  const onGuidePointerMove = (e) => {
    if (!guidePtrs.current.has(e.pointerId)) return;
    guidePtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = guideGesture.current;
    if (!g) return;
    const pts = [...guidePtrs.current.values()];
    if (g.mode === 'pinch' && pts.length >= 2) {
      const [p, q] = pts;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const a = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      setGuideScale(Math.min(3, Math.max(0.3, g.startScale * (d / g.d0))));
      setGuideAngle(g.startAngle + (a - g.a0));
      setGuideOffset({ x: g.startOffset.x + (mid.x - g.mid0.x), y: g.startOffset.y + (mid.y - g.mid0.y) });
    } else if (g.mode === 'move') {
      setGuideOffset({ x: g.startOffset.x + (e.clientX - g.startX), y: g.startOffset.y + (e.clientY - g.startY) });
    }
  };
  const onGuidePointerUp = (e) => {
    guidePtrs.current.delete(e.pointerId);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    snapshotGuideGesture(); // rebase any remaining finger
  };
  const resetGuide = () => { setGuideOffset({ x: 0, y: 0 }); setGuideAngle(0); setGuideScale(1); };

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  // The rest of the ORB list, shown beside the countdown. Scanning a whole set
  // means many near-identical cards, and the one in hand is regularly not ORB's
  // first pick — so the runners-up stay one tap away instead of requiring an undo.
  const [autoAddAlternatives, setAutoAddAlternatives] = useState([]);
  // The picker opens compact and expands on request rather than dumping eight
  // cards at once.
  const [showAllMatches, setShowAllMatches] = useState(false);
  const PICKER_PREVIEW = 4;
  // The last scan's full candidate list, kept after the picker closes so the
  // add drawer can go back to it. openQuickAdd clears scanMatches, which is why
  // reaching the alternatives from the drawer was impossible.
  const [lastMatches, setLastMatches] = useState([]);
  // True while the "different printing" lookup is in flight.
  const [findingPrintings, setFindingPrintings] = useState(false);
  // Tap the countdown popup to pause auto-add and tweak these before adding
  // (slower tiers only — Turbo adds instantly with no overlay).
  const [autoAddEditing, setAutoAddEditing] = useState(false);
  const [autoAddCond, setAutoAddCond] = useState('Near Mint');
  const [autoAddPrint, setAutoAddPrint] = useState('Normal');
  // Duplicate-scan confirm: set to the repeat-matched card; dupQty = copies to add.
  const [dupConfirmCard, setDupConfirmCard] = useState(null);
  const [dupQty, setDupQty] = useState(1);

  useBackGuard(scanMatches.length > 0, () => setScanMatches([]));
  useBackGuard(!!dupConfirmCard, () => setDupConfirmCard(null));
  useBackGuard(!!inspectorEntry, () => setInspectorEntry(null));
  useBackGuard(recentSelect.selectMode, recentSelect.exitSelectMode);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('Normal');
  // Language of the copy being added. Defaults to whatever is being scanned, so a
  // Japanese run does not have to be corrected card by card.
  const [language, setLanguage] = useState(() => langName(localStorage.getItem('scanner_lang') || 'en'));
  const [purchasePrice, setPurchasePrice] = useState(0);

  // Keep a ref mirroring the latest stream so the unmount cleanup below (whose
  // closure is fixed from the first render) can always stop the live tracks.
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Clean up camera stream on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // On game switch: restore that game's remembered set and load its set list
  // (for the search autocomplete).
  useEffect(() => {
    setScanSetCodesState((localStorage.getItem(setsKey(scanGame, scanLang)) || '').split(',').map(s => s.trim()).filter(Boolean));
    setSetInput('');
    setSetSearchOpen(false);
    fetch(`/api/sets?game=${scanGame}&lang=${encodeURIComponent(scanLang)}`).then(r => r.ok ? r.json() : []).then(setSetList).catch(() => setSetList([]));
    // Whether scanning without a set code can work here at all.
    setIndexStatus(null);
    fetch(`/api/scan-index-status?game=${scanGame}&lang=${encodeURIComponent(scanLang)}&coverage=1`)
      .then(r => r.ok ? r.json() : null).then(setIndexStatus).catch(() => setIndexStatus(null));
  }, [scanGame, scanLang]);

  // When a set code is set, build/verify that set's index on the server so scans
  // match within just that set (~300 cards) — accurate and fast. Polls until the
  // one-time build finishes.
  useEffect(() => {
    if (!scanSetParam) { setSetPrep('idle'); setSetBuildProgress(null); setSetBuildError(null); return; }
    let cancelled = false, timer, debounce;
    const poll = async () => {
      try {
        const r = await fetch('/api/prepare-set', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: scanGame, set: scanSetParam, lang: scanLang }),
        });
        const d = await r.json();
        if (cancelled) return;
        if (d.ready) { setSetPrep('ready'); setSetBuildProgress(null); setSetBuildError(null); return; }
        // Unbuildable (no such set in this language, or the provider has no card
        // data for it). Stop polling and say so — retrying cannot help, and the
        // silent "fetching card list" spinner is what made this look like a hang.
        if (d.failed) { setSetPrep('error'); setSetBuildProgress(null); setSetBuildError(d.error || 'This set could not be indexed.'); return; }
        setSetPrep('building');
        setSetBuildProgress(d.progress || null);
        setSetBuildError(d.failures && d.failures.length ? d.failures[0].error : null);
        timer = setTimeout(poll, 1000);
      } catch { if (!cancelled) setSetPrep('idle'); }
    };
    debounce = setTimeout(() => { setSetPrep('building'); poll(); }, 200);
    return () => { cancelled = true; clearTimeout(debounce); if (timer) clearTimeout(timer); };
  }, [scanGame, scanSetParam, scanLang]);

  // Detect manual-exposure support on the live track. Present on most Android
  // Chrome back cameras; absent on iOS Safari and many desktop webcams (slider
  // then stays hidden). Reads the current value so the slider starts in place.
  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof track.getCapabilities !== 'function') { setExposureCaps(null); return; }
    const ec = track.getCapabilities().exposureCompensation;
    if (ec && typeof ec.min === 'number' && typeof ec.max === 'number') {
      setExposureCaps({ min: ec.min, max: ec.max, step: ec.step || (ec.max - ec.min) / 100 || 0.1 });
      const cur = track.getSettings?.().exposureCompensation;
      setExposure(typeof cur === 'number' ? cur : 0);
    } else {
      setExposureCaps(null);
    }
  }, [stream]);

  // Bind the camera stream to the video element when both are ready
  useEffect(() => {
    if (cameraActive && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      // Explicitly call play to ensure the stream plays on all mobile browsers
      videoRef.current.play().catch(err => {
        console.error('Error playing video stream:', err);
      });
    }
  }, [cameraActive, stream]);

  // Auto-Add Countdown Effect
  useEffect(() => {
    let intervalId;
    if (autoAddEditing) {
      // Paused for manual edit: freeze the countdown, don't fire.
    } else if (autoAddCountdown !== null && autoAddCountdown > 0) {
      intervalId = setInterval(() => {
        setAutoAddCountdown(prev => prev - 1);
      }, 1000);
    } else if (autoAddCountdown === 0 && autoAddTargetCard) {
      const cardToTrigger = autoAddTargetCard;
      setAutoAddTargetCard(null);
      setAutoAddCountdown(null);
      setAutoAddAlternatives([]);   // the choice is made; don't leak it to the next card
      autoAddCard(cardToTrigger);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddCountdown, autoAddTargetCard, autoAddEditing]);

  // Fixed-cadence metronome (Turbo): fire a capture every profile.cadence ms
  // with a visible countdown, independent of scan timing. `loading` is NOT a
  // dep, so the tick keeps a steady beat; handleCapture no-ops while a previous
  // scan is still running (its own loading guard), so ticks never overlap — if
  // a scan ever runs longer than the cadence, that tick is simply skipped.
  useEffect(() => {
    if (!profile.cadence || !cameraActive || !autoScan) { setCaptureCountdown(null); return; }
    const cadence = profile.cadence;
    let nextFireAt = Date.now() + cadence;
    setCaptureCountdown(cadence);
    const STEP = 100;
    // Time-based metronome (one stable interval). The countdown is time-until-
    // next-capture. When it hits 0 we fire — unless a scan is still running
    // (loadingRef) or a modal is up (captureBlockedRef), in which case the ring
    // holds at 0 and we fire the instant it's free. So the ring sweeps down ONCE
    // per capture (no phantom resets), and the true cadence is max(cadence,
    // lookupTime): a slow lookup just delays the next fire, never overlaps.
    const id = setInterval(() => {
      if (captureBlockedRef.current) return; // modal/picker/drawer: hold
      const remaining = nextFireAt - Date.now();
      if (remaining > 0) { setCaptureCountdown(remaining); return; }
      if (loadingRef.current) { setCaptureCountdown(0); return; } // scan busy: wait
      // Hold the beat until the frame is worth spending a scan on.
      if (!frameWorthCaptureRef.current?.()) { setCaptureCountdown(0); return; }
      handleCaptureRef.current?.();
      nextFireAt = Date.now() + cadence;
      setCaptureCountdown(cadence);
    }, STEP);
    return () => { clearInterval(id); setCaptureCountdown(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, autoScan, scanDetail]);

  // Is this moment worth taking the picture?
  //
  // What local detection buys beyond the outline. Auto-scan used to fire on a
  // timer and send whatever frame the clock landed on — including motion-blurred
  // ones, which measurably produced confident WRONG answers that no amount of
  // recall tuning could rescue. Now it waits for the detector to have a
  // card-shaped quad that has stopped moving.
  //
  // Permissive by default: if the outline is off, or nothing has been seen yet,
  // say yes. A scanner that refuses to take pictures is worse than one that
  // occasionally takes a mediocre one.
  const frameWorthCapturing = () => {
    if (!showDetectOutline) return true;              // outline off: no opinion
    const b = bestFrame.current;
    if (!b) return true;                              // nothing seen: do not stall
    if (Date.now() - b.at > 1500) return true;        // stale read: do not stall
    return b.steady >= STEADY_FRAMES_NEEDED && b.fill >= 0.7;
  };

  // After-completion scheduler (non-Turbo tiers): capture cooldown ms after the
  // previous scan finishes (loading drops).
  useEffect(() => {
    if (profile.cadence) return;
    let timerId;
    if (cameraActive && autoScan && !isDrawerOpen && !loading && scanMatches.length === 0 && !autoAddTargetCard && !dupConfirmCard) {
      timerId = setTimeout(() => {
        // Re-check at fire time, not schedule time — the card may have moved
        // during the cooldown. If it is not worth it, look again shortly rather
        // than burning a scan; the retry is what keeps auto-scan feeling
        // continuous instead of stalling.
        if (frameWorthCapturing()) handleCaptureRef.current?.();
        else timerId = setTimeout(() => handleCaptureRef.current?.(), 300);
      }, profile.cooldown);
    }
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches, autoAddTargetCard, dupConfirmCard, scanDetail]);

  // Live "where does the scanner think the card is" outline.
  //
  // Every crop failure used to be invisible until after the shutter: you framed a
  // card, got a wrong answer, and had no way to see the detector had locked onto a
  // sleeve edge or nothing at all. This closes that loop.
  //
  // The cost model is the entire design, because the first attempt at this froze
  // the app. Per update it does exactly one canvas draw and one async encode:
  //   · ONE canvas, reused (allocating per frame exhausts mobile canvas memory,
  //     after which new canvases come back blank rather than failing)
  //   · toBlob, not toDataURL — the latter is a SYNCHRONOUS JPEG encode
  //   · no getImageData anywhere — each call is a GPU readback
  //   · self-pacing: the next request is scheduled after the last one lands, so a
  //     slow phone or a slow network stretches the interval instead of queueing
  //   · paused entirely while a real scan is running; that result is what matters
  // Roughly 1.5 requests/second of small JPEGs, and nothing synchronous.
  useEffect(() => {
    if (!cameraActive || !showDetectOutline) { setDetectQuad(null); return; }
    let stopped = false;
    let timer;

    // Applied when the worker answers, not when the frame was submitted.
    const onDetectResult = (found) => {
      if (stopped) return;
      if (!found.detected) {
        steadyFrames.current = 0;
        smoothed.current = null;
        lastRawQuad.current = null;
        bestFrame.current = null;
        setDetectQuad(null);
        return;
      }
      // Drift is measured between RAW results; the smoothed quad is only what
      // gets drawn, and easing it would make everything look steady.
      const drift = quadDrift(lastRawQuad.current, found.quad);
      lastRawQuad.current = found.quad;
      smoothed.current = smoothQuad(smoothed.current, found.quad);
      steadyFrames.current = drift < STEADY_DRIFT ? steadyFrames.current + 1 : 0;
      bestFrame.current = {
        at: Date.now(),
        sharp: found.sharp || 0,
        fill: found.pick?.fill ?? 0,
        steady: steadyFrames.current,
      };
      setDetectQuad({ ...found, quad: smoothed.current });
    };

    const tick = () => {
      if (stopped) return;
      try {
        const guideElement = document.querySelector('.scan-card-guide');
        // Skip while a scan owns the pipeline, or before the video has a frame to
        // copy: videoWidth is set at metadata, but there are no pixels until
        // readyState reaches HAVE_CURRENT_DATA, and drawing early yields black.
        const v = videoRef.current;
        if (!loadingRef.current && guideElement && v?.videoWidth && v.readyState >= 2) {
          if (!outlineCanvas.current) outlineCanvas.current = document.createElement('canvas');
          const c = buildFramedCanvas(v, guideElement, DETECT_W, outlineCanvas.current);
          // Fire-and-forget: the worker answers on its own schedule and a frame
          // is skipped rather than queued while one is in flight. Queueing would
          // only produce results describing a scene that has already moved.
          if (c) requestDetect(c, onDetectResult);
        }
      } catch {
        // A dropped preview frame is not worth surfacing; the next tick retries.
        if (!stopped) setDetectQuad(null);
      }
      // Self-pacing: schedule from the END of the work, so a slow device stretches
      // the interval instead of queueing frames it cannot keep up with.
      if (!stopped) timer = setTimeout(tick, DETECT_INTERVAL_MS);
    };
    timer = setTimeout(tick, 400);   // let the camera settle before the first look
    return () => { stopped = true; clearTimeout(timer); stopDetect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, showDetectOutline]);

  const updateAdvancedConstraints = (track, newAdvancedProps) => {
    try {
      const currentConstraints = track.getConstraints();
      let advanced = currentConstraints.advanced ? [...currentConstraints.advanced] : [];
      let advObj = advanced.length > 0 ? { ...advanced[0] } : {};
      
      for (const [key, value] of Object.entries(newAdvancedProps)) {
        if (value === null || value === undefined) {
          delete advObj[key];
        } else {
          advObj[key] = value;
        }
      }
      
      // Apply ONLY the advanced set. Re-sending the top-level resolution
      // constraints (facingMode/width/height) makes many Android Chrome builds
      // reset the track and silently drop torch/focus. applyConstraints leaves
      // any field we don't name untouched, so the resolution stays put.
      track.applyConstraints({
        advanced: [advObj]
      }).catch(err => console.warn('applyConstraints error:', err));
    } catch (e) {
      console.warn('updateAdvancedConstraints error:', e);
    }
  };

  // Torch gets its own path (not the shared merge) so it applies the bare
  // `advanced: [{ torch }]` constraint and surfaces the real reason on-screen —
  // the user can't open a phone console. iOS Safari never reports caps.torch,
  // so those users get a clear "not supported" instead of a dead button.
  const toggleTorch = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) { showToast(t('scan.errCameraNotReady')); return; }
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    if (!caps.torch) {
      showToast(t('scan.errNoTorch'));
      return;
    }
    const next = !isTorchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setIsTorchOn(next);
    } catch (err) {
      showToast(t('scan.errTorch', { error: err.name || err.message || t('scan.unknownError') }));
    }
  };

  // Exposure bias. exposureCompensation is an EV offset on top of continuous
  // auto-exposure; in 'manual' mode the camera drives exposure by exposureTime/ISO
  // and ignores the compensation, so the slider must stay in continuous mode.
  const changeExposure = (val) => {
    setExposure(val);
    const track = stream?.getVideoTracks?.()[0];
    if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: val });
  };

  const startCamera = async () => {
    setCameraErrorKey('');
    setScanMatches([]);
    setScanStatus('');
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
    // getUserMedia only exists in a secure context. Served over plain HTTP on a
    // LAN address (the usual Docker setup, http://host:3001) navigator.mediaDevices
    // is undefined, and the browser never shows a permission prompt at all — so
    // "check your permissions" sends people hunting for a setting that is fine.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraErrorKey('scan.errCameraInsecure');
      showToast(t('scan.errCameraInsecure', { origin: window.location.origin, port: window.location.port || '80' }));
      return;
    }
    try {
      const constraints = {
        video: {
          facingMode: 'environment', // Use back camera on phones
          // 1080p, not 720p. The guide box crops to roughly a third of the frame,
          // so 720p delivered a ~250px-wide card to a pipeline whose reference
          // images are 500px — and accuracy falls off a cliff right there.
          // Measured on 100 MTG cards: exact-printing 76.0% at a 250px card,
          // 91.0% at 420px, 90.0% at 800px. `ideal` rather than `min` so a camera
          // that cannot manage it degrades instead of failing getUserMedia.
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      };
      
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);
      setCameraActive(true);
    } catch (err) {
      console.error('Error opening camera:', err);
      setCameraErrorKey('scan.errCameraPermissions');
      showToast(t('scan.errCameraAccess'));
    }
  };

  const stopCamera = () => {
    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track && isTorchOn) {
        updateAdvancedConstraints(track, { torch: false });
      }
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setCameraActive(false);
    setAutoScan(false); // Reset autoScan on camera stop
    setIsTorchOn(false);
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
  };

  const autoAddCard = async (card, qty = 1, overrides = null) => {
    // Mark the dup guard BEFORE the await: a fast cooldown can fire the next
    // capture before this POST resolves, and a match of the same card must hit
    // the duplicate path instead of auto-adding a second time.
    lastAddedIdRef.current = card.id;
    try {
      const autoPrinting = overrides?.printing || ((card.rarity || '').toLowerCase().includes('holo') ? 'Holofoil' : 'Normal');
      const autoCondition = overrides?.condition || 'Near Mint';
      // The card's own language when the provider reported one, else the language
      // being scanned. Auto-add used to hard-code English, which quietly filed
      // every Japanese card as an English copy.
      const autoLanguage = card.language || langName(scanLang);
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: card.id,
          quantity: qty,
          condition: autoCondition,
          printing: autoPrinting,
          language: autoLanguage,
          // price_trend is whichever finish the TCG API returned first (usually
          // Normal), not necessarily the Holofoil finish just chosen above —
          // resolve against the printing actually being recorded.
          purchase_price: resolveCardPrice(card, autoPrinting),
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const qtyLabel = qty > 1 ? `${qty}× ` : '';
        const placementLabel = data.placement?.label || null;
        if (placementLabel) {
          showToast(t('scan.addedTo', { qty: qtyLabel, name: card.name, place: placementLabel }));
        } else if (data.container_full) {
          showToast(t('scan.addedFull', { qty: qtyLabel, name: card.name }));
        } else {
          showToast(t('scan.autoAdded', { qty: qtyLabel, name: card.name, set: card.set_name }));
        }

        // Append to recent scans history log. entry_id (the last inserted row)
        // lets the recent-scans price splitter target these exact entries and the
        // inspector edit/delete the entry. Carry the entry fields it was saved with.
        setRecentScans(prev => [{
          ...card, card_id: card.id, placementLabel, entry_id: data.id,
          quantity: qty, condition: autoCondition, printing: autoPrinting,
          language: autoLanguage, purchase_price: resolveCardPrice(card, autoPrinting), location_id: null,
        }, ...prev].slice(0, 10));

        // Brief confetti blast for ultra-rares
        const rarity = (card.rarity || '').toLowerCase();
        if (rarity.includes('secret') || rarity.includes('ultra') || (card.price_trend || 0) > 15) {
          confetti({ particleCount: 50, spread: 40, origin: { y: 0.8 } });
        }
        
        onAddSuccess(); // Refresh stats
      } else {
        showToast(t('scan.errAutoAdd', { name: card.name }));
        signal('error');
      }
    } catch (err) {
      console.error('Auto-add error:', err);
      showToast(t('scan.errAutoAddGeneric'));
      signal('error');
    }
  };

  // Resolves the landscape-to-portrait camera stream rotation bug on mobile devices.
  // It creates a canvas matching the visual orientation on the user's screen.
  // Pass maxW to downscale the output (cheap enough to run every frame for the
  // live detection loop); omit it for a full-resolution capture.
  const getOrientedVideoCanvas = (video, maxW = 0) => {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const canvas = document.createElement('canvas');

    const videoRect = video.getBoundingClientRect();
    const streamRatio = videoWidth / videoHeight;
    const visualRatio = videoRect.width / videoRect.height;

    // Stream orientation rotation applies to mobile devices (iOS/Android)
    // where physical camera sensors deliver landscape raw frames while displayed in portrait.
    // Desktop webcams deliver unrotated frames matching the screen layout.
    const isMobile = isNative || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const isRotated = isMobile && ((streamRatio > 1.0 && visualRatio < 1.0) || (streamRatio < 1.0 && visualRatio > 1.0));

    // Oriented output dimensions, then an optional uniform downscale.
    const outW = isRotated ? videoHeight : videoWidth;
    const outH = isRotated ? videoWidth : videoHeight;
    const scale = (maxW && outW > maxW) ? maxW / outW : 1;
    canvas.width = Math.max(1, Math.round(outW * scale));
    canvas.height = Math.max(1, Math.round(outH * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale); // subsequent coords are in unscaled (oriented) space

    if (isRotated) {
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate(90 * Math.PI / 180);
      ctx.drawImage(video, -videoWidth / 2, -videoHeight / 2, videoWidth, videoHeight);
    } else {
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
    }

    return canvas;
  };

  // The guide-box region of the current frame, oriented and deskewed to the box.
  //
  // ONE implementation, shared by the capture and by the live overlay. The
  // overlay's whole value is that it shows what the SCAN will see, so if it
  // framed the picture even slightly differently it would be confidently
  // misleading — and a preview that lies is worse than none.
  //
  // `maxW` downscales for the overlay (a detection frame needs far fewer pixels
  // than a match does); `target` reuses a canvas rather than allocating one per
  // frame, which is what mobile browsers punish by handing back BLANK canvases
  // once their per-tab canvas memory is exhausted.
  const buildFramedCanvas = (video, guideElement, maxW = 0, target = null) => {
    if (!video?.videoWidth || !guideElement) return null;
    const oc = getOrientedVideoCanvas(video);
    const videoRect = video.getBoundingClientRect();
    const guideRect = guideElement.getBoundingClientRect();
    // Cover-transform mapping from displayed video px to oriented-canvas px
    // (matches object-fit:cover on the preview).
    const k = Math.max(videoRect.width / oc.width, videoRect.height / oc.height);
    const offX = (videoRect.width - oc.width * k) / 2;
    const offY = (videoRect.height - oc.height * k) / 2;
    // Box centre (rotation is about the element centre, so the rotated AABB
    // centre from getBoundingClientRect is still the true centre).
    const cx = ((guideRect.left + guideRect.width / 2) - videoRect.left - offX) / k;
    const cy = ((guideRect.top + guideRect.height / 2) - videoRect.top - offY) / k;
    // offsetWidth/Height are the unscaled layout size; the CSS scale transform
    // does not change them, so fold guideScale in here.
    const fullW = Math.max(1, Math.round((guideElement.offsetWidth * guideScale / k) * (1 + 2 * CROP_PAD)));
    const fullH = Math.max(1, Math.round((guideElement.offsetHeight * guideScale / k) * (1 + 2 * CROP_PAD)));
    const s = (maxW && fullW > maxW) ? maxW / fullW : 1;
    const destW = Math.max(1, Math.round(fullW * s));
    const destH = Math.max(1, Math.round(fullH * s));

    const canvas = target || document.createElement('canvas');
    canvas.width = destW;                       // also resets pixels + transform
    canvas.height = destH;
    const fctx = canvas.getContext('2d');
    // Sample the (possibly rotated, off-centre) box region upright: dest centre
    // maps to the box centre, undo the box rotation, draw the frame. Pixels past
    // the box come through black; the server auto-detects the card inside.
    fctx.scale(s, s);
    fctx.translate(fullW / 2, fullH / 2);
    fctx.rotate(-(guideAngle * Math.PI) / 180);
    fctx.translate(-cx, -cy);
    fctx.drawImage(oc, 0, 0);
    return canvas;
  };

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  // Is this resolved card the printing ORB reported? Set + number is the
  // identity; the name is not checked because the index and the provider can
  // spell it differently, which is exactly the disagreement that used to make
  // candidates vanish.
  const sameCard = (card, cand) => !!card && !!cand
    && String(card.number) === String(cand.number)
    && (String(card.set_id).toLowerCase() === String(cand.set).toLowerCase()
      || String(card.set_name || '').toLowerCase() === String(cand.set).toLowerCase());

  // Turn ORB candidates into full cards, preserving ORB's order so the options
  // on screen line up one-for-one with the match list. Each lookup is by the
  // matched printing, never by name as well: the index stores the name from when
  // the set was built, and one re-spelling would drop the candidate entirely.
  //
  // Failures resolve to null rather than throwing — one unresolvable candidate
  // must not take the other seven down with it.
  const resolveCandidates = async (cands, game, lang) => Promise.all(
    cands.map(async (cand) => {
      // Already hydrated server-side (exact set+number hit in card_cache).
      if (cand.card) return { ...cand.card, __match: { inliers: cand.inliers, score: cand.score } };
      const p = new URLSearchParams({ game, lang });
      if (cand.set && cand.number) {
        p.append('set', cand.set);
        p.append('number', cand.number);
      } else if (cand.name) {
        p.append('name', cand.name);
      } else return null;
      try {
        const res = await fetch(`/api/search?${p.toString()}`);
        if (!res.ok) return null;
        const m = await res.json();
        // Keep the row that IS this candidate. A set+number query should return
        // exactly one, but never assume — taking m[0] blindly is how a different
        // printing reached the picker.
        const hit = cand.number ? m.find(c => sameCard(c, cand)) : m[0];
        return hit ? { ...hit, __match: { inliers: cand.inliers, score: cand.score } } : null;
      } catch { return null; }
    })
  );

  const applyMatches = async (matches, notFoundMsg, autoSingle = false) => {
    setScanMatches(matches);
    setShowAllMatches(false);   // each scan's picker opens compact again
    if (matches.length === 0) {
      // Nothing in frame — the resolved-duplicate card has left, so clear the
      // skip guard; re-presenting it later should prompt again, not skip forever.
      resolvedDupIdRef.current = null;
      setScanStatus(notFoundMsg);
      signal('error');
      return;
    }
    setScanStatus('');
    if (matches.length === 1 && (scanGame !== 'mtg' || autoSingle)) {
      if (autoScan) {
        const id = matches[0].id;
        if (id === resolvedDupIdRef.current) {
          // Same card we already handled, still sitting in frame — wait for a
          // different card before doing anything.
          setScanMatches([]);
          setScanStatus('Same card still in view — swap in the next card.');
          return;
        }
        if (id === lastAddedIdRef.current) {
          // Repeat of the card just auto-added: could be a real second copy or
          // just the same card lingering. Make the user decide.
          setDupConfirmCard(matches[0]);
          setDupQty(1);
          setScanMatches([]);
          return;
        }
        // A different card is now in frame — clear the skip guard so the old
        // resolved-duplicate card is scannable again later.
        resolvedDupIdRef.current = null;
        // countdown 0 (Turbo): add immediately, no confirm-modal idle. Higher
        // tiers show the countdown overlay so the user can cancel a mis-scan.
        if (profile.countdown === 0) {
          autoAddCard(matches[0]);
        } else {
          setAutoAddTargetCard(matches[0]);
          setAutoAddCountdown(profile.countdown);
        }
        setScanMatches([]);
      } else {
        openQuickAdd(matches[0]);
      }
    }
  };

  const handleCapture = async () => {
    if (loading || !videoRef.current || !cameraActive) return;

    setLoading(true);
    const scanId = ++currentScanId.current;
    setScanMatches([]);
    setScanStatus('Initializing scanner...');

    const video = videoRef.current;
    
    const guideElement = document.querySelector('.scan-card-guide');
    if (!guideElement) {
      setLoading(false);
      setScanStatus('Error: Guide box overlay not found.');
      return;
    }

    // 1. Capture the guide-box region, oriented and deskewed to the box.
    const framedCanvas = buildFramedCanvas(video, guideElement);
    if (!framedCanvas) {
      setLoading(false);
      setScanStatus('Error: could not read a camera frame.');
      return;
    }
    // Picture is now taken — fire the instant cue (click + vibrate + flash) so
    // the user can move the card immediately, before the server lookup runs.
    signal('capture');

    try {
      // Identify by image (server-side). Send the WHOLE oriented frame (downscaled)
      // so the server can auto-detect + deskew the card before matching — the guide
      // box is just an aim hint.
      {
        setScanStatus('Matching card image...');
        {
          // Downscale the frame for upload; server auto-crops the card. Keep it
          // fairly high-res so a far/small card still has enough pixels to match.
          const up = document.createElement('canvas');
          const s = Math.min(1, profile.uploadW / framedCanvas.width);
          up.width = Math.round(framedCanvas.width * s);
          up.height = Math.round(framedCanvas.height * s);
          up.getContext('2d').drawImage(framedCanvas, 0, 0, up.width, up.height);
          const imageData = up.toDataURL('image/jpeg', 0.85);
          setDebugHashImg(imageData);
          try {
            const resp = await fetch('/api/scan-match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ game: scanGame, image: imageData, set: scanSetParam, lang: scanLang, recallK: profile.recallK, orb: profile.orb }),
            });
            if (scanId !== currentScanId.current) return;
            if (resp.ok) {
              const { game: matchGame, verified, candidates, crop, scoped, englishOnly } = await resp.json();
              console.log('Scan candidates:', matchGame, scanLang, scoped ? `(set-scoped ${scanSetParam})` : '(GLOBAL)', verified ? 'ORB' : 'CLIP', candidates);
              if (crop) setDebugHashImg(crop); // show the server's auto-cropped card
              setDebugScoped(scoped ? scanSetParam : false);
              setDebugCandidates((candidates || []).map(c => ({ ...c, verified })));
              // The whole-game indexes only exist in English, so a non-English scan
              // needs a set selected (its index builds on demand). Say that plainly
              // instead of leaving the user re-scanning a card that cannot match.
              if (englishOnly) {
                setScanStatus(`${langName(scanLang)} scanning needs a set selected — pick the set you are feeding in above.`);
                return;
              }
              const top = candidates && candidates[0];
              const confident = top && (verified ? top.inliers >= SCAN_MATCH_MIN_INLIERS : top.score >= SCAN_MATCH_MIN_SCORE);
              // Printing ambiguity: basic lands (and other low-art cards) share one
              // big symbol + frame, so ORB scores nearly tie across every printing
              // of the same card. A near-tied same-name runner-up means the image
              // can't tell the printings apart — so DON'T auto-add the top pick's
              // set; fall through to the picker and let the user choose the set.
              const second = candidates && candidates[1];
              const ambiguousPrinting = top && second && top.name === second.name
                && (top.set !== second.set || top.number !== second.number)
                && (verified ? second.inliers >= top.inliers * 0.7 : second.score >= top.score - 0.02);
              if (candidates && candidates.length > 0) {
                // Resolve the WHOLE ORB list to real cards, once, and use it for
                // both outcomes. The confident path used to resolve only the top
                // pick, which meant the auto-add overlay had nothing to offer if
                // it guessed wrong — and when scanning a whole set, the card in
                // hand often is not ORB's first choice.
                const confidentPick = confident && !ambiguousPrinting;
                // Turbo (countdown 0) adds instantly with no overlay, so there is
                // nowhere to put alternatives — resolving eight cards per scan
                // would be pure latency on the fastest tier. Everywhere else the
                // whole list is resolved, because the countdown shows it.
                const wanted = (confidentPick && profile.countdown === 0)
                  ? candidates.slice(0, 1)
                  : candidates.slice(0, 8);
                // Only announce a fetch if one is actually needed; anything the
                // server pre-hydrated resolves without a round-trip.
                if (wanted.some(c => !c.card)) setScanStatus(t('scan.fetchingCandidates'));
                const resolved = await resolveCandidates(wanted, matchGame, scanLang);
                if (scanId !== currentScanId.current) return;
                const validCandidates = resolved.filter(Boolean);
                // Remembered for the add drawer, which otherwise loses every
                // alternative the moment a card is chosen.
                setLastMatches(validCandidates);

                if (validCandidates.length > 0) {
                  // Confident: auto-add the top pick, but keep the rest on screen
                  // beside the countdown so a wrong guess is one tap to correct
                  // rather than an undo after the fact.
                  if (confidentPick && sameCard(validCandidates[0], top)) {
                    setAutoAddAlternatives(validCandidates.slice(1));
                    await applyMatches([validCandidates[0]], '', true);
                    return;
                  }
                  setAutoAddAlternatives([]);
                  await applyMatches(validCandidates, '', false);
                  return;
                }
              }
            }
          } catch (e) { console.warn('scan-match request failed:', e); }
        }
      }

      setScanStatus('No confident match. Try again or search manually.');
      // Frame no longer shows a recognizable card — clear the skip guard so the
      // resolved-duplicate card isn't skipped forever once re-presented.
      resolvedDupIdRef.current = null;
      signal('error');
    } catch (err) {
      console.error('Scan match failed:', err);
      if (scanId === currentScanId.current) setScanStatus('Scan failed. Please search manually.');
    } finally {
      if (scanId === currentScanId.current) setLoading(false);
    }
  };
  // Keep the ref pointing at the latest handleCapture so timers (metronome /
  // cooldown) always invoke the current closure, never a stale one.
  handleCaptureRef.current = handleCapture;
  frameWorthCaptureRef.current = frameWorthCapturing;
  // Metronome reads this (not effect deps) to decide whether to fire a capture,
  // so a modal/picker/drawer pauses the beat without restarting the interval.
  captureBlockedRef.current = isDrawerOpen || scanMatches.length > 0 || !!autoAddTargetCard || !!dupConfirmCard;
  loadingRef.current = loading;

  const openQuickAdd = (card) => {
    setScanMatches([]);
    setSelectedCard(card);
    setPurchasePrice(0);
    const rarity = (card.rarity || '').toLowerCase();
    if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || rarity.includes('shining')) {
      setPrinting('Holofoil');
    } else {
      setPrinting('Normal');
    }
    setLanguage(card.language || langName(scanLang));
    setIsDrawerOpen(true);
  };

  // "Right card, wrong printing."
  //
  // ORB matches ARTWORK, and the same illustration is reprinted across sets — so
  // a confident, geometrically perfect match can still name the wrong printing:
  // Fossil #25 Lapras and Base #10 Lapras share an image the scanner cannot tell
  // apart, and neither can a person at a glance. The scan candidates do not help
  // here either, because they are ranked by how the picture looks; every printing
  // of that art looks identical.
  //
  // So this asks a different question than the scanner did: forget the image,
  // give me every printing of this NAME. `prints=1` makes Scryfall return each
  // printing rather than one per card; the Pokémon providers list printings by
  // name already.
  const findOtherPrintings = async () => {
    if (!selectedCard || findingPrintings) return;
    setFindingPrintings(true);
    try {
      const p = new URLSearchParams({
        game: selectedCard.game || scanGame,
        lang: scanLang,
        name: selectedCard.name,
        prints: '1',
        // Ask the PROVIDER, not the cache. Every provider's search returns the
        // local cache whole if it holds a single matching row, which for a name
        // search means "the printings you happen to have looked at before" — and
        // the printing being hunted for is by definition not one of those. On a
        // freshly cleared cache that answered "Lapras" with a dozen modern sets
        // and no Base or Fossil at all. Falls back to cache if the provider is
        // unreachable, so this cannot end up worse than before.
        scope: 'internet',
      });
      const res = await fetch(`/api/search?${p.toString()}`);
      const raw = res.ok ? await res.json() : [];
      // Printings the provider has no image for sort last rather than being
      // dropped: this is a picker you choose from by LOOKING, so an art-less row
      // is nearly useless at the top — but the card is real and still addable, so
      // hiding it would make a printing unreachable.
      const found = [...raw].sort((a, b) => (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0));
      // One result means the only printing is the one already open — say so
      // rather than opening a picker with a single card in it.
      if (found.length <= 1) { showToast(t('scan.noOtherPrintings')); return; }
      setLastMatches(found);
      closeDrawer();
      setScanMatches(found);
      setShowAllMatches(true);
    } catch {
      showToast(t('scan.noOtherPrintings'));
    } finally {
      setFindingPrintings(false);
    }
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setScanMatches([]);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('Normal');
    setLanguage(langName(scanLang));
    setPurchasePrice(0);
    // Restart camera on close only if stream was stopped
    if (!stream || !cameraActive) {
      startCamera();
    }
  };

  const removeRecentTile = (entryId) => setRecentScans(prev => prev.filter(s => s.entry_id !== entryId));
  // Tap: open the inspector, unless a long-press just armed selection or we're
  // already selecting (then toggle). Long-press + bulk actions come from the hook.
  const activateRecent = (item) => {
    if (recentSelect.longPressFired.current) { recentSelect.longPressFired.current = false; return; }
    if (recentSelect.selectMode) recentSelect.toggleSelect(item.entry_id);
    else setInspectorEntry(item);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard) return;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quantity, 10),
          condition,
          printing,
          language,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const placementLabel = data.placement?.label || null;
        if (placementLabel) {
          showToast(t('scan.addedToPlain', { name: selectedCard.name, place: placementLabel }));
        } else if (data.container_full) {
          showToast(t('scan.addedFullPlain', { name: selectedCard.name }));
        } else {
          showToast(t('search.addedToCollection', { name: selectedCard.name }));
        }

        // Append to recent scans history. Carry entry_id + saved fields so the
        // strip supports tap-to-edit / long-press-delete like the auto-add path.
        setRecentScans(prev => [{
          ...selectedCard, card_id: selectedCard.id, placementLabel, entry_id: data.id,
          quantity: parseInt(quantity, 10), condition, printing, language,
          purchase_price: parseFloat(purchasePrice) || 0, location_id: null,
        }, ...prev].slice(0, 10));

        const rarity = (selectedCard.rarity || '').toLowerCase();
        const price = selectedCard.price_trend || 0;
        if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || price > 10) {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }

        onAddSuccess();
        closeDrawer();
      } else {
        showToast(t('search.errAddCard'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('scan.errSaveCard'));
    }
  };

  return (
    <div className="scanner-container">



      {/* Camera Window */}
      {!cameraActive ? (
        <div 
          className="camera-preview-wrapper" 
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          onClick={startCamera}
        >
          {cameraErrorKey ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <AlertTriangle size={48} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                {t(cameraErrorKey, { origin: window.location.origin, port: window.location.port || '80' })}
              </p>
              <button className="btn btn-primary" onClick={startCamera}>
                <RefreshCw size={14} /> Retry Camera
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Camera size={48} style={{ color: 'var(--accent-red)', marginBottom: '1rem', opacity: 0.8 }} />
              <p style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>{t('scan.readyTitle')}</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{t('scan.readyHint')}</p>
              <button className="btn btn-primary">
                {t('scan.activateCamera')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div className="camera-preview-wrapper camera-active">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-video"
            />
            
            {/* Torch Toggle Overlay Button */}
            <button
                type="button"
                className={`btn ${isTorchOn ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  position: 'absolute',
                  top: '1rem',
                  right: '1rem',
                  zIndex: 20,
                  borderRadius: '50%',
                  padding: '0.6rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                }}
                onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
              >
                {isTorchOn ? <Zap size={18} /> : <ZapOff size={18} />}
              </button>

            {/* Fixed-cadence countdown ring (Turbo): depletes over profile.cadence
                and resets each capture, so the next-photo beat is visible. */}
            {captureCountdown !== null && (() => {
              const total = profile.cadence || 1000;
              const frac = Math.max(0, Math.min(1, captureCountdown / total));
              const R = 18, C = 2 * Math.PI * R;
              return (
                <div style={{ position: 'absolute', top: '1rem', left: '1rem', zIndex: 20, width: 44, height: 44, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))' }}>
                  <svg width="44" height="44" viewBox="0 0 44 44">
                    <circle cx="22" cy="22" r={R} fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
                    <circle
                      cx="22" cy="22" r={R} fill="none"
                      stroke="var(--accent-red)" strokeWidth="3" strokeLinecap="round"
                      strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
                      transform="rotate(-90 22 22)"
                      style={{ transition: 'stroke-dashoffset 0.1s linear' }}
                    />
                  </svg>
                </div>
              );
            })()}

            {/* Outline Box Guides */}
            <div className="camera-overlay">
              <style>{`
                @keyframes border-flash-success {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--type-grass); box-shadow: 0 0 25px rgba(74, 222, 128, 0.6); }
                }
                @keyframes border-flash-error {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--accent-red); box-shadow: 0 0 25px var(--accent-red-glow); }
                }
                @keyframes border-flash-capture {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  50% { border-color: #fff; box-shadow: 0 0 30px rgba(255, 255, 255, 0.9); }
                }
              `}</style>
              <div
                className="scan-card-guide"
                onPointerDown={onGuidePointerDown}
                onPointerMove={onGuidePointerMove}
                onPointerUp={onGuidePointerUp}
                onPointerCancel={onGuidePointerUp}
                style={{
                  pointerEvents: 'auto',
                  cursor: 'move',
                  touchAction: 'none',
                  transform: `translate(${guideOffset.x}px, ${guideOffset.y}px) rotate(${guideAngle}deg) scale(${guideScale})`,
                  animation: scanFlash === 'capture' ? 'border-flash-capture 0.4s ease-in-out' : scanFlash === 'error' ? 'border-flash-error 1.5s ease-in-out' : 'none'
                }}
              >
                {loading && <div className="scan-line"></div>}
                {/* Live detection outline.

                    Drawn as a child of the guide box, so it inherits the box's
                    translate/rotate/scale for free and needs no coordinate maths
                    of its own — the earlier attempt mapped screen coordinates by
                    hand and got them wrong. Inset by -CROP_PAD on each side
                    because the quad is normalised to the CROP, which is the box
                    plus that margin.

                    Green = the detector has a card-like quad and the scan will
                    work from it. No outline = it has nothing, which is the state
                    worth seeing before pressing the shutter rather than after. */}
                {showDetectOutline && detectQuad?.detected && detectQuad.quad && (
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    style={{
                      position: 'absolute',
                      left: `${-CROP_PAD * 100}%`,
                      top: `${-CROP_PAD * 100}%`,
                      width: `${(1 + 2 * CROP_PAD) * 100}%`,
                      height: `${(1 + 2 * CROP_PAD) * 100}%`,
                      pointerEvents: 'none',
                      overflow: 'visible',
                    }}
                  >
                    <polygon
                      points={detectQuad.quad.map(p => `${p.x * 100},${p.y * 100}`).join(' ')}
                      fill="rgba(74,222,128,0.15)"
                      stroke="rgb(74,222,128)"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                )}
              </div>
              {(guideOffset.x !== 0 || guideOffset.y !== 0 || guideAngle !== 0 || guideScale !== 1) && (
                <button
                  type="button"
                  onClick={resetGuide}
                  style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'auto', zIndex: 10, fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-strong)', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 999, padding: '0.25rem 0.7rem', cursor: 'pointer' }}
                >
                  {t('scan.resetBox')}
                </button>
              )}
            </div>
          </div>

          {/* Settings panel (toggled by the gear in the action row): game, set,
              scan detail, exposure. Kept off the camera view so it stays clean. */}
          {showScanSettings && (
          <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem', order: 2, position: 'relative', zIndex: setSearchOpen ? 40 : undefined }}>
            {showGamePicker() && (
              <div className="sub-nav-tabs" style={{ marginBottom: 0 }}>
                {gameOptions().map(({ value, short }) => (
                  <button
                    key={value}
                    type="button"
                    className={`sub-nav-tab ${scanGame === value ? 'active' : ''}`}
                    style={{ padding: '0.5rem', fontSize: '0.8rem', fontWeight: 700 }}
                    onClick={() => setCardLayout(value === 'mtg' ? 'mtg' : 'modern')}
                  >
                    {short}
                  </button>
                ))}
              </div>
            )}

            {/* Scan language. Card art is language-specific, so this picks which
                set index the scan is matched against — and the language each
                added copy is recorded as. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <label htmlFor="scan-language" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                {t('scan.cardLanguage')}
              </label>
              <select
                id="scan-language"
                className="select-control"
                value={scanLang}
                onChange={(e) => {
                  const code = e.target.value;
                  setScanLang(code);
                  setLanguage(langName(code));
                }}
                style={{ fontSize: '0.8rem' }}
              >
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
              {/* How scanning works, stated from the actual index state rather than
                  assumed. This used to hardcode "the whole-game index only covers
                  English art", which stopped being true once indexes became
                  per-language — and was untranslated besides. */}
              {(() => {
                if (scanSetCodes.length) {
                  return (
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.35 }}>
                      {t('scan.modeSetScoped', { count: scanSetCodes.length })}
                    </p>
                  );
                }
                if (!indexStatus) return null;
                const cov = indexStatus.coverage;
                if (indexStatus.codeFreeScanning) {
                  return (
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.35 }}>
                      {cov
                        ? t('scan.modeGlobalPartial', { covered: cov.embedded, total: cov.total })
                        : t('scan.modeGlobal')}
                    </p>
                  );
                }
                return (
                  <p style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', margin: 0, lineHeight: 1.35 }}>
                    {t('scan.modeNeedsSet', { language: langName(scanLang) })}
                  </p>
                );
              })()}
            </div>

            {/* Set search (both games): pick a set to build a per-set index
                for accurate one-step scans. Free text also works as an
                exact-id escape hatch for sets not yet cached. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', position: 'relative' }}>
              {(() => {
                const bp = setBuildProgress;
                const pct = bp && bp.total > 0 ? Math.round((bp.done / bp.total) * 100) : null;
                const isFetching = setPrep === 'building' && (pct === null || bp?.status === 'fetching');
                const displayPct = isFetching ? 15 : (pct || 0);

                let text;
                if (!scanSetCodes.length) {
                  text = 'Highly recommended: pick your set(s) below. Scans are far more accurate scoped to your sets — without it we search every set and may misidentify the card.';
                } else if (setPrep === 'building') {
                  text = isFetching
                    ? `Preparing ${setLabelJoined}… fetching card list. Scans work meanwhile.`
                    : `Indexing ${setLabelJoined}: ${bp.done}/${bp.total} cards (${pct}%). Scans work meanwhile.`;
                } else if (setPrep === 'ready') {
                  text = `${setLabelJoined} ready: exact matches within your set${scanSetCodes.length > 1 ? 's' : ''}.`;
                } else if (setPrep === 'error') {
                  text = setBuildError || `${setLabelJoined} could not be indexed.`;
                } else {
                  text = setLabelJoined;
                }
                const textColor = setPrep === 'error' ? 'var(--accent-red)'
                  : !scanSetCodes.length ? 'var(--accent-yellow)'
                  : setPrep === 'ready' ? 'var(--type-grass)'
                  : 'var(--text-secondary)';
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <p style={{ fontSize: '0.75rem', color: textColor, margin: 0, textAlign: 'center', fontWeight: 600 }}>
                      {text}
                    </p>
                    {/* A set that failed but sits alongside ones still building:
                        the bar below keeps reporting the buildable ones. */}
                    {setPrep === 'building' && setBuildError && (
                      <p style={{ fontSize: '0.7rem', color: 'var(--accent-red)', margin: 0, textAlign: 'center' }}>
                        {setBuildError}
                      </p>
                    )}
                    {setPrep === 'building' && (
                      <div style={{ padding: '0.45rem 0.65rem', background: 'rgba(0,0,0,0.35)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                          <span>{isFetching ? 'Fetching Card List...' : `Indexing Cards (${bp?.done || 0}/${bp?.total || 0})`}</span>
                          <span style={{ color: 'var(--accent-yellow)' }}>{isFetching ? 'Please wait' : `${pct}%`}</span>
                        </div>
                        <div style={{ height: '10px', width: '100%', background: 'rgba(255,255,255,0.08)', borderRadius: '5px', overflow: 'hidden', position: 'relative' }}>
                          <div style={{
                            height: '100%',
                            width: `${displayPct}%`,
                            background: 'linear-gradient(90deg, #ef4444, #f59e0b, #10b981)',
                            borderRadius: '5px',
                            transition: 'width 0.3s ease',
                            boxShadow: '0 0 10px rgba(245, 158, 11, 0.6)'
                          }} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              {scanSetCodes.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  {scanSetCodes.map((code) => (
                    <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.5rem', fontSize: '0.7rem', fontWeight: 600, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--type-grass)', borderRadius: '999px', color: 'var(--text-strong)' }}>
                      {labelForCode(code)}
                      <button type="button" onClick={() => removeSetCode(code)} aria-label={`Remove ${code}`} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '0.85rem' }}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t('scan.addSet')}</label>
                <input
                  type="text"
                  value={setInput}
                  onChange={(e) => { setSetInput(e.target.value); setSetSearchOpen(true); }}
                  onFocus={() => setSetSearchOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const q = setInput.trim().toLowerCase();
                      if (!q) return;
                      // Snap a typed name/code to the canonical dropdown code so
                      // "Foundations" and "FDN" don't build twice; else add as-is.
                      const m = setList.find(s => [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase() === q));
                      addSetCode(m ? setScanCode(m) : setInput.trim());
                      setSetInput(''); setSetSearchOpen(false);
                    }
                  }}
                  onBlur={() => setTimeout(() => {
                    setSetSearchOpen(false);
                    const q = setInput.trim().toLowerCase();
                    if (!q) return;
                    const m = setList.find(s => [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase() === q));
                    if (m) { addSetCode(setScanCode(m)); setSetInput(''); }
                  }, 150)}
                  placeholder={t(scanGame === 'mtg' ? 'scan.setSearchMtg' : 'scan.setSearchPokemon')}
                  style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.75rem', background: 'rgba(255,255,255,0.06)', border: `1px solid ${scanSetCodes.length ? 'var(--type-grass)' : 'var(--border-glass)'}`, borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)' }}
                />
                {scanSetCodes.length > 0 && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '0.2rem 0.4rem' }} onClick={() => { persistSets([]); setSetInput(''); setSetSearchOpen(false); }}>{t('bulk.clear')}</button>
                )}
              </div>
              {setSearchOpen && setSuggestions.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: '0.2rem', background: 'var(--bg-elevated, #1c1c22)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', maxHeight: '220px', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                  {setSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={() => { addSetCode(setScanCode(s)); setSetInput(''); setSetSearchOpen(false); }}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', width: '100%', padding: '0.4rem 0.6rem', background: 'none', border: 'none', color: 'var(--text-strong)', fontSize: '0.75rem', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0 }}>{setScanCode(s)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Live outline of what the detector currently sees. On by default:
                it turns aiming into a feedback loop, and it is the only way a bad
                crop is visible BEFORE the shutter rather than inferred from a
                wrong answer afterwards. Off is offered because it costs a small
                request roughly every 650ms. */}
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.showDetectOutline')}</span>
              <input
                type="checkbox"
                checked={showDetectOutline}
                onChange={(e) => { setShowDetectOutline(e.target.checked); localStorage.setItem('scan_outline', e.target.checked ? '1' : '0'); }}
                style={{ accentColor: 'var(--type-grass)' }}
              />
            </label>

            {/* Scan Detail: quick↔accurate tradeoff. Lower = faster upload,
                shorter cooldown, shallower server match; higher = more accurate. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.detail')}</span>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-red)' }}>{profile.label}</span>
              </div>
              <input
                type="range"
                min="0"
                max={SCAN_PROFILES.length - 1}
                step="1"
                value={scanDetail}
                onChange={(e) => { const v = parseInt(e.target.value, 10); setScanDetail(v); localStorage.setItem('scan_detail', String(v)); }}
                style={{ width: '100%', accentColor: 'var(--accent-red)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                <span>{t('scan.detailQuick')}</span>
                <span>{t('scan.detailSlow')}</span>
              </div>
            </div>

            {/* Manual exposure: only rendered when the camera track supports it
                (Android Chrome back cams). Auto-exposure stays default until you
                move this. */}
            {exposureCaps && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.exposure')}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem' }}
                    onClick={() => {
                      const track = stream?.getVideoTracks?.()[0];
                      if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: null });
                      const cur = track?.getSettings?.().exposureCompensation;
                      setExposure(typeof cur === 'number' ? cur : 0);
                    }}
                  >
                    {t('scan.auto')}
                  </button>
                </div>
                <input
                  type="range"
                  min={exposureCaps.min}
                  max={exposureCaps.max}
                  step={exposureCaps.step}
                  value={exposure}
                  onChange={(e) => changeExposure(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-red)' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  <span>{t('scan.darker')}</span>
                  <span>{t('scan.brighter')}</span>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Scan crop + candidate diagnostics — only render when we actually have
              a crop/candidates, so an empty dashed box doesn't eat vertical space on phone. */}
          {cameraActive && (debugHashImg || debugCandidates.length > 0) && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
              {/* Hash-match diagnostics: what was cropped + the ranked candidates. */}
              {(debugHashImg || debugCandidates.length > 0) && (
                <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                  {debugHashImg && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.hashedCrop')}</span>
                      <img src={debugHashImg} style={{ width: '52px', maxHeight: '80px', objectFit: 'contain', background: '#111', borderRadius: '3px', border: '1px solid var(--border-glass-hover)' }} alt="Hashed crop" />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                    {debugScoped !== null && (
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: debugScoped ? 'var(--type-grass)' : 'var(--accent-red)' }}>
                        {debugScoped ? `✓ Set-scoped: ${debugScoped}` : '✗ GLOBAL search (not scoped to a set)'}
                      </span>
                    )}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Top matches ({debugCandidates[0]?.verified ? 'ORB inliers' : 'similarity'}, higher = closer)</span>
                    {debugCandidates.length === 0 ? (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('scan.noCandidates')}</span>
                    ) : debugCandidates.slice(0, 3).map((cd, i) => {
                      const pass = cd.verified ? cd.inliers >= SCAN_MATCH_MIN_INLIERS : cd.score >= SCAN_MATCH_MIN_SCORE;
                      const label = cd.verified ? `${cd.inliers} inl` : (cd.score != null ? cd.score.toFixed(2) : '?');
                      return (
                        <div key={i} style={{ fontSize: '0.7rem', color: i === 0 ? '#fff' : 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ color: pass ? 'var(--type-grass)' : 'var(--accent-red)', fontWeight: 700 }}>{label}</span>
                          {' '}{cd.name} <span style={{ color: 'var(--text-muted)' }}>({cd.set} #{cd.number})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
            <button className="btn btn-secondary" onClick={stopCamera} style={{ flex: 1 }} title={t('scan.stopCamera')}>
              {t('scan.stop')}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={autoScan}
              className="btn btn-secondary"
              onClick={() => setAutoScan(!autoScan)}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0 0.7rem', borderColor: autoScan ? 'var(--type-grass)' : undefined, color: autoScan ? 'var(--type-grass)' : undefined }}
              title={t('scan.autoCaptureHint')}
            >
              <ScanLine size={15} />
              <span style={{ fontSize: '0.72rem', fontWeight: 700 }}>{t('scan.auto')}</span>
              <span style={{ width: 28, height: 15, borderRadius: 999, background: autoScan ? 'var(--type-grass)' : 'rgba(255,255,255,0.22)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 2, left: autoScan ? 15 : 2, width: 11, height: 11, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
              </span>
            </button>
            {loading ? (
              <button className="btn btn-primary" onClick={handleCancelScan} style={{ flex: 2, backgroundColor: 'var(--accent-red)', borderColor: 'var(--accent-red)' }}>
                {t('scan.cancelScan')}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleCapture} style={{ flex: 2 }}>
                {t('scan.captureIdentify')}
              </button>
            )}
            <button
              type="button"
              className={`btn ${showScanSettings ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowScanSettings(s => !s)}
              title={t('scan.settingsHint')}
              aria-label={t('scan.settings')}
              style={{ flexShrink: 0, padding: '0 0.7rem', position: 'relative' }}
            >
              <Settings size={16} />
              {!scanSetCodes.length && <span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-yellow)' }} />}
            </button>
          </div>
        </div>
      )}

      {/* Scan Status Log */}
      {scanStatus && (
        <div className="glass-panel" style={{ width: '100%', padding: '1rem', borderLeft: '3px solid var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {loading && <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>}
          <span style={{ fontSize: '0.85rem', color: 'var(--text-strong)', fontWeight: 500 }}>{scanStatus}</span>
        </div>
      )}

      {/* Auto Add Countdown Overlay. Tap the card (before the countdown ends) to
          pause auto-add and adjust condition/printing before it's saved. */}
      {autoAddTargetCard && (autoAddCountdown !== null || autoAddEditing) && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: '1rem'
          }}
        >
          <div className="glass-panel animate-fade-in" style={{ maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-red)' }}>
            <div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>{t(autoAddEditing ? 'scan.adjustAndAdd' : 'scan.exactMatch')}</span>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: '0.25rem 0 0.5rem 0' }}>{autoAddTargetCard.name}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{autoAddTargetCard.set_name} • #{autoAddTargetCard.number}</p>
            </div>

            <div
              onClick={() => {
                if (autoAddEditing) return;
                // Pause and open the editor with sensible defaults.
                setAutoAddCond('Near Mint');
                setAutoAddPrint((autoAddTargetCard.rarity || '').toLowerCase().includes('holo') ? 'Holofoil' : 'Normal');
                setAutoAddEditing(true);
              }}
              style={{ position: 'relative', width: '115px', aspectRatio: 0.718, margin: '0.5rem 0', cursor: autoAddEditing ? 'default' : 'pointer' }}
              title={autoAddEditing ? undefined : 'Tap to change condition/foil'}
            >
              <img src={autoAddTargetCard.image_url} alt={autoAddTargetCard.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />
              {!autoAddEditing && (
                <div style={{
                  position: 'absolute',
                  top: '-10px',
                  right: '-10px',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-red)',
                  border: '2px solid #fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-strong)',
                  fontWeight: 900,
                  fontSize: '1rem',
                  boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
                }}>
                  {autoAddCountdown}
                </div>
              )}
            </div>

            {autoAddEditing ? (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.6rem' }}>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, textAlign: 'left' }}>
                    <label>{t('card.condition')}</label>
                    <select className="select-control" value={autoAddCond} onChange={(e) => setAutoAddCond(e.target.value)}>
                      {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, textAlign: 'left' }}>
                    <label>{t('card.printing')}</label>
                    <select className="select-control" value={autoAddPrint} onChange={(e) => setAutoAddPrint(e.target.value)}>
                      {getPrintings(autoAddTargetCard.game || autoAddTargetCard.supertype).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const card = autoAddTargetCard;
                      const overrides = { condition: autoAddCond, printing: autoAddPrint };
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      setAutoAddEditing(false);
                      autoAddCard(card, 1, overrides);
                    }}
                    style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('search.addToCollection')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      setAutoAddEditing(false);
                      showToast(t('scan.autoAddCancelled'));
                    }}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('scan.autoAddingIn', { seconds: autoAddCountdown })}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('scan.tapToChange')}</span>
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const card = autoAddTargetCard;
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      setAutoAddAlternatives([]);
                      autoAddCard(card);
                    }}
                    style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('scan.addNow')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      setAutoAddAlternatives([]);
                      showToast(t('scan.autoAddCancelled'));
                    }}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* The rest of the ORB list, in ORB's order.
                Auto-add commits to the strongest match, and within a single set
                — many cards, one frame, near-identical art — that is regularly
                not the card in hand. Showing the runners-up here turns a wrong
                guess into one tap instead of an add-then-undo. Hidden while
                editing condition/foil, where the choice has already been made. */}
            {!autoAddEditing && autoAddAlternatives.length > 0 && (
              <div style={{ width: '100%', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
                  {t('scan.notThisOne')}
                </span>
                <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
                  {autoAddAlternatives.map(alt => (
                    <button
                      key={alt.id}
                      type="button"
                      onClick={() => {
                        // Cancel the countdown and hand this card to the normal
                        // add flow, so condition/quantity work exactly as usual.
                        setAutoAddTargetCard(null);
                        setAutoAddCountdown(null);
                        setAutoAddAlternatives([]);
                        openQuickAdd(alt);
                      }}
                      title={`${alt.name} · ${alt.set_name} #${alt.number}`}
                      style={{ flex: '0 0 auto', width: '68px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'center' }}
                    >
                      <img
                        src={alt.image_url}
                        alt={alt.name}
                        style={{ width: '100%', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--border-glass-hover)' }}
                      />
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', marginTop: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        #{alt.number}
                      </div>
                    </button>
                  ))}
                </div>
                {/* The strip is a quick pick; this opens the full list in the
                    normal picker. Offered even on a confident match, because
                    "confident" is a score, not a promise — and when the whole set
                    looks alike it is regularly the wrong card. */}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    const all = [autoAddTargetCard, ...autoAddAlternatives];
                    setAutoAddTargetCard(null);
                    setAutoAddCountdown(null);
                    setAutoAddAlternatives([]);
                    setScanMatches(all);
                    setShowAllMatches(true);
                  }}
                  style={{ alignSelf: 'center', fontSize: '0.7rem', padding: '0.3rem 0.7rem' }}
                >
                  {t('scan.seeAllMatches', { n: autoAddAlternatives.length + 1 })}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Duplicate-Scan Confirm Overlay: the just-added card was scanned again. */}
      {dupConfirmCard && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: '1rem'
          }}
        >
          <div className="glass-panel animate-fade-in" style={{ maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-yellow)' }}>
            <div>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>{t('scan.sameCardAgain')}</span>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: '0.25rem 0 0.5rem 0' }}>{dupConfirmCard.name}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{dupConfirmCard.set_name} • #{dupConfirmCard.number}</p>
            </div>

            <img src={dupConfirmCard.image_url} alt={dupConfirmCard.name} style={{ width: '110px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />

            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('scan.repeatHint')}
            </p>

            {/* Quantity stepper: number of ADDITIONAL copies to add now. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDupQty(q => Math.max(1, q - 1))}
                style={{ width: '36px', padding: '0.35rem 0', fontSize: '1rem', fontWeight: 800 }}
              >−</button>
              <span style={{ minWidth: '2.5rem', fontSize: '1.4rem', fontWeight: 900, color: 'var(--text-strong)' }}>{dupQty}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDupQty(q => Math.min(99, q + 1))}
                style={{ width: '36px', padding: '0.35rem 0', fontSize: '1rem', fontWeight: 800 }}
              >+</button>
            </div>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const card = dupConfirmCard;
                  const qty = dupQty;
                  // Mark handled so the same card lingering in frame won't re-prompt.
                  resolvedDupIdRef.current = card.id;
                  setDupConfirmCard(null);
                  autoAddCard(card, qty);
                }}
                style={{ width: '100%', fontSize: '0.85rem', padding: '0.55rem 0' }}
              >
                Add {dupQty} more {dupQty === 1 ? 'copy' : 'copies'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  resolvedDupIdRef.current = dupConfirmCard.id;
                  setDupConfirmCard(null);
                  showToast(t('scan.discardedRepeat'));
                }}
                style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem 0' }}
              >
                Discard — same card, keep scanning
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  resolvedDupIdRef.current = dupConfirmCard.id;
                  setDupConfirmCard(null);
                  setAutoScan(false);
                  showToast(t('scan.secondPhoto'));
                }}
                style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem 0' }}
              >
                Done — that was another photo of the same card
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scan Results Suggestions Popup Modal */}
      {scanMatches.length > 0 && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(5px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{ maxWidth: '560px', width: '100%', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <h3 style={{ fontSize: '1.1rem', color: 'var(--text-strong)', margin: 0 }}>{t('scan.identifiedTitle')}</h3>
              <button 
                className="btn btn-secondary btn-icon-only" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  if (!stream || !cameraActive) startCamera();
                }} 
                style={{ borderRadius: '50%' }}
                title={t('scan.closeRescan')}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {t('scan.selectCorrect')}
              </p>
              
              {/* Manual search fallback within the modal */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input 
                  type="text" 
                  placeholder={t('scan.manualSearchPlaceholder')} 
                  className="input-control"
                  style={{ flex: 1, padding: '0.4rem 0.5rem', fontSize: '0.8rem' }}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      const q = e.target.value.trim();
                      const p = new URLSearchParams({ game: scanGame, lang: scanLang });

                      if (scanGame === 'mtg') {
                        // Very simple fallback: try to parse set code and number if format looks like "SET 123"
                        const match = q.match(/^([A-Z0-9]{3,5})\s+(\d+[A-Z★]?)$/i);
                        if (match) {
                          p.append('set', match[1]);
                          p.append('number', match[2]);
                        } else {
                          p.append('name', q);
                        }
                      } else {
                         // Pokemon: just try name or number
                         if (/^\d+$/.test(q)) p.append('number', q);
                         else p.append('name', q);
                      }
                      
                      const searchResponse = await fetch(`/api/search?${p.toString()}`);
                      if (searchResponse.ok) {
                        const m = await searchResponse.json();
                        if (m.length) {
                          setScanMatches(m);
                        } else {
                          showToast(t('scan.errManualSearch'));
                        }
                      }
                    }
                  }}
                />
              </div>
            </div>

            {/* Strongest matches first — the same order, and the same cards, as
                the ORB match list. Only the first few are shown: eight cards at
                once is a wall to read while holding the card you are trying to
                identify, and the answer is usually near the top. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '1rem', maxHeight: '350px', overflowY: 'auto', padding: '0.25rem' }}>
              {(showAllMatches ? scanMatches : scanMatches.slice(0, PICKER_PREVIEW)).map(card => (
                <div key={card.id} className="tcg-card" onClick={() => openQuickAdd(card)} style={{ cursor: 'pointer' }}>
                  <div className="tcg-card-inner" style={{ border: '1px solid var(--border-glass-hover)' }}>
                    <img src={card.image_url} alt={card.name} className="tcg-card-image" />
                  </div>
                  <div className="tcg-card-info" style={{ textAlign: 'center', marginTop: '0.5rem' }}>
                    <div className="tcg-card-name" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-strong)' }}>{card.name}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</div>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-yellow)', marginTop: '0.2rem' }}>${formatPrice(card.price_trend)}</div>
                  </div>
                </div>
              ))}
            </div>

            {scanMatches.length > PICKER_PREVIEW && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowAllMatches(v => !v)}
                style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              >
                {showAllMatches
                  ? t('scan.showFewer')
                  : t('scan.seeMoreMatches', { n: scanMatches.length - PICKER_PREVIEW })}
              </button>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
              <button 
                className="btn btn-primary" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  if (!stream || !cameraActive) startCamera();
                }} 
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
              >
                <RefreshCw size={14} />
                <span>{t('scan.rescan')}</span>
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  setAutoScan(false);
                  if (!stream || !cameraActive) startCamera();
                }}
                style={{ flex: 1 }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Scans History Panel */}
      {recentScans.length > 0 && (
        <div className="glass-panel" style={{ width: '100%', marginTop: '1rem' }}>
          <h3 style={{ fontSize: '1rem', color: 'var(--text-strong)', marginBottom: '0.85rem', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t('scan.recentScans')}</span>
            {recentSelect.selectMode
              ? <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={recentSelect.exitSelectMode}>{t('bulk.done')}</button>
              : <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => setRecentScans([])}>{t('scan.clearHistory')}</button>}
          </h3>

          {/* Bulk action bar (select mode). Same actions/endpoint as the collection page. */}
          {recentSelect.selectMode && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginBottom: '0.6rem' }}>
              <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.8rem', marginRight: '0.25rem' }}>{recentSelect.selectedIds.size} selected</span>
              <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('delete', null, t('bulk.confirmDelete', { count: recentSelect.selectedIds.size }))}>{t('bulk.delete')}</button>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('trade', null)}>{t('bulk.markTrade')}</button>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('list_type', 'wishlist')}>{t('bulk.moveToWishlist')}</button>
            </div>
          )}

          {/* Horizontal strip of recent scans, card-shaped like the box tiles.
              Tap = edit; long-press = multi-select (shared with collection page). */}
          <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.4rem' }}>
            {recentScans.map((item, idx) => {
              const selected = recentSelect.selectMode && recentSelect.selectedIds.has(item.entry_id);
              return (
              <div
                key={idx}
                onClick={() => activateRecent(item)}
                {...recentSelect.pressHandlers(item.entry_id)}
                title={t('scan.tapEditHoldSelect')}
                style={{ flex: '0 0 auto', width: '76px', display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: 'pointer', userSelect: 'none', WebkitTouchCallout: 'none', opacity: recentSelect.selectMode && !selected ? 0.55 : 1 }}
              >
                <img
                  src={item.image_url}
                  alt={item.name}
                  draggable={false}
                  style={{ width: '76px', height: '106px', objectFit: 'cover', borderRadius: '4px', border: selected ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)', boxShadow: selected ? '0 0 12px var(--accent-red-glow)' : '0 2px 6px rgba(0,0,0,0.3)', pointerEvents: 'none' }}
                />
                <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--accent-yellow)', textAlign: 'center' }}>${formatPrice(item.price_trend)}</div>
                {item.placementLabel && (
                  <div style={{ fontSize: '0.55rem', color: '#ffc107', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.placementLabel}>{item.placementLabel}</div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {inspectorEntry && (
        <CardInspectorModal
          card={inspectorEntry}
          onClose={() => setInspectorEntry(null)}
          onUpdate={onAddSuccess}
          onDeleted={removeRecentTile}
          showToast={showToast}
        />
      )}

      {/* Drawer Overlay for Selected Card */}
      <div className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ color: 'var(--text-strong)', fontSize: '1.25rem', margin: 0 }}>{t('scan.addScannedTitle')}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>{getCardDisplayName(selectedCard.name, language, selectedCard.printed_name)} ({selectedCard.set_name} • #{selectedCard.number})</p>
              </div>
              <button className="btn btn-secondary btn-icon-only" onClick={closeDrawer} style={{ borderRadius: '50%' }}>
                <X size={18} />
              </button>
            </div>

            {/* Three Column Layout (No vertical scroll) */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="quick-add-grid" style={{ gridTemplateColumns: '200px 1fr' }}>
                
                {/* Column 1: Card Preview (Smaller card: width 150px) */}
                <div className="quick-add-preview">
                  <img 
                    src={selectedCard.image_url} 
                    alt={selectedCard.name} 
                    className="quick-add-preview-img"
                  />
                  <div className="quick-add-preview-info">
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TCG Market ({printing})</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)', margin: '0.1rem 0' }}>
                      ${formatPrice(resolveCardPrice(selectedCard, printing))}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      Rarity: <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{selectedCard.rarity || 'Common'}</span>
                    </div>
                  </div>
                </div>

                {/* Column 2: Card Properties Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div className="quick-add-section-title">{t('scan.cardProperties')}</div>
                  
                  <CardEntryFields
                    variant="stacked"
                    game={selectedCard.game || selectedCard.supertype}
                    quantity={quantity} purchasePrice={purchasePrice} condition={condition} printing={printing} language={language}
                    onQuantity={setQuantity} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting} onLanguage={setLanguage}
                  />
                </div>
              </div>

              {/* Submit Buttons.
                  The two on the left are the "this isn't quite right" escapes,
                  and they answer different questions. "Other matches" goes back
                  to what the scanner saw — useful when it picked the wrong CARD.
                  "Different printing" ignores the image entirely and lists every
                  printing of this name — the only thing that helps when the art
                  is identical across sets and the scanner had nothing to go on. */}
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem', marginTop: '0.5rem' }}>
                {lastMatches.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => { closeDrawer(); setScanMatches(lastMatches); setShowAllMatches(true); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    <ListFilter size={14} /> {t('scan.backToMatches', { n: lastMatches.length })}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={findOtherPrintings}
                  disabled={findingPrintings}
                  title={t('scan.otherPrintingsHint')}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <Layers size={14} /> {findingPrintings ? t('scan.fetchingCandidates') : t('scan.otherPrintings')}
                </button>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} style={{ padding: '0.5rem 1.5rem' }}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 2rem' }}>{t('search.addToCollection')}</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default CameraScanner;
