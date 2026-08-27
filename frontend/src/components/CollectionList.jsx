import { startTransition, useState, useEffect, useMemo, useRef } from 'react';
import { Search, Trash2, Edit2, LayoutGrid, List, SlidersHorizontal, X, MousePointerClick, Braces } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { formatPrice, priceText } from '../utils/formatPrice';
import { CONDITIONS, PRINTING_OPTIONS } from '../utils/cardOptions';
import { getPrintingBadgeLabel, getPrintingBadgeStyle, getFoilOverlayClass, getPrintingLabel } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import { buildCardListText } from '../utils/cardList';
import { fetchWithRetry } from '../utils/fetchWithRetry';
import { useMultiSelect } from '../utils/useMultiSelect';
import { useT } from '../utils/i18n';
import { compileQuery, classifyQuery } from '../../../shared/scryfallQuery.js';
import CardInspectorModal from './CardInspectorModal';
import AddToDeckSelect from './AddToDeckSelect';
import PackPriceSplitter from './PackPriceSplitter';
import CardImage from './CardImage';

const labelStyle = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' };
const INITIAL_RENDER_COUNT = 96;
const LOAD_MORE_RENDER_COUNT = 240;
const BACKGROUND_PAGE_SIZE = 2000;

// Maps each Sort By option to sortCardsByOrder criteria so ordering remains
// consistent (set = chronological via setsList, type = name order — there is no
// 'type' comparator in sortCardsByOrder, so the scheme falls back to name).
// 'qty-desc' isn't a card-order scheme, handled separately.
const SORT_CRITERIA = {
  'added-newest': [{ by: 'added_at', dir: 'desc' }, { by: 'entry_id', dir: 'desc' }],
  'added-oldest': [{ by: 'added_at', dir: 'asc' }],
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'price-desc': [{ by: 'price', dir: 'desc' }],
  'price-asc': [{ by: 'price', dir: 'asc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'rarity-desc': [{ by: 'rarity', dir: 'desc' }, { by: 'name', dir: 'asc' }],
  'rarity-asc': [{ by: 'rarity', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'type-asc': [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'language-asc': [{ by: 'language', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'favorite-first': [{ by: 'favorite', dir: 'desc' }, { by: 'added_at', dir: 'desc' }],
};

// Small labelled field wrapper to keep the filter grid uniform.
function Field({ label, children, style }) {
  return (
    <div className="form-group" style={{ marginBottom: 0, ...style }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function CollectionList({ statsTrigger, onUpdate, showToast, selectedCardFilter, setSelectedCardFilter }) {
  const { t } = useT();
  const [collection, setCollection] = useState([]);
  const [setsList, setSetsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const fetchGenerationRef = useRef(0);
  const fetchAbortRef = useRef(null);

  useEffect(() => {
    if (selectedCardFilter) {
      setSearchFilter(selectedCardFilter);
      // Reset after applying so they can clear search manually
      setSelectedCardFilter('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardFilter]);

  // UX view state
  const [viewMode, setViewMode] = useState('gallery'); // 'gallery' or 'list'
  const [inspectorCard, setInspectorCard] = useState(null);
  const [inspectorStartEdit, setInspectorStartEdit] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // Search & Filter state
  const [searchFilter, setSearchFilter] = useState('');
  // Scryfall-syntax mode: a raw operator query (is:land color:g r:r …) filters
  // the loaded rows instead of the plain name/number/set text box. Same idea
  // as the Add Cards toggle; the choice is remembered per browser.
  const [scryfallMode, setScryfallMode] = useState(() => localStorage.getItem('collection_scryfall_mode') === '1');
  const [scryfallQuery, setScryfallQuery] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  const [setFilter, setSetFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [supertypeFilter, setSupertypeFilter] = useState('');
  const [cmcFilter, setCmcFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [tradeOnly, setTradeOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);

  // Live-catalog mode: the query contains an operator only Scryfall's
  // database can answer (otag:, availability:, artist: ...). Those cannot be
  // evaluated against the loaded rows, so the query goes to the server, which
  // resolves it against Scryfall and returns the user's OWN rows for the
  // matches. Debounced, because a half-typed tag is not a query yet — and
  // every half-typed query would otherwise be a real API call.
  const [liveCatalog, setLiveCatalog] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState(null);
  const liveFetchRef = useRef(0);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  // Multi-select / bulk actions — shared long-press + /api/collection/bulk logic.
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode,
    pressHandlers, longPressFired, runBulk,
  } = useMultiSelect({ showToast, onChanged: onUpdate });

  useEffect(() => {
    fetchCollection();
    return () => {
      fetchGenerationRef.current += 1;
      fetchAbortRef.current?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger, tradeOnly]);

  useEffect(() => {
    fetchSets();
  // The set catalog is static collection-view metadata; card mutations should
  // not download it again.
  }, []);

  const fetchCollection = async () => {
    const generation = ++fetchGenerationRef.current;
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    try {
      setLoading(true);
      setLoadingMore(false);
      setVisibleCount(INITIAL_RENDER_COUNT);

      const params = new URLSearchParams({
        limit: String(INITIAL_RENDER_COUNT),
        offset: '0'
      });
      if (tradeOnly) params.set('is_trade', '1');

      // Cold path: request only what can be painted immediately. This stays fast
      // even when the physical collection grows to hundreds of thousands of rows.
      const response = await fetchWithRetry(
        `/api/collection?${params}`,
        { signal: controller.signal }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const firstPage = await response.json();
      const total = Math.max(firstPage.length, parseInt(response.headers.get('X-Total-Count'), 10) || 0);
      if (generation !== fetchGenerationRef.current) return;
      setCollection(firstPage);
      setLoading(false);

      if (firstPage.length < total) {
        setLoadingMore(true);
        const pageRequests = [];
        for (let offset = firstPage.length; offset < total; offset += BACKGROUND_PAGE_SIZE) {
          const pageParams = new URLSearchParams({
            limit: String(BACKGROUND_PAGE_SIZE),
            offset: String(offset),
            count: '0'
          });
          if (tradeOnly) pageParams.set('is_trade', '1');
          pageRequests.push(
            fetchWithRetry(`/api/collection?${pageParams}`, { signal: controller.signal })
              .then(pageResponse => {
                if (!pageResponse.ok) throw new Error(`HTTP ${pageResponse.status}`);
                return pageResponse.json();
              })
          );
        }

        // Fetch the remaining slices concurrently, then commit once. The page is
        // already interactive while this runs, and one transition avoids sorting
        // and regrouping the growing collection after every network chunk.
        let pages;
        try {
          pages = await Promise.all(pageRequests);
        } catch (backgroundError) {
          if (backgroundError?.name === 'AbortError' || controller.signal.aborted) throw backgroundError;

          // Never leave filters, totals, or bulk operations working on a silent
          // 96-row subset. If a page still fails after retries, fall back to the
          // compatible full endpoint; this slower path is only for recovery.
          const fallbackUrl = tradeOnly ? '/api/collection?is_trade=1' : '/api/collection';
          const fallbackResponse = await fetchWithRetry(fallbackUrl, { signal: controller.signal });
          if (!fallbackResponse.ok) throw backgroundError;
          const fullCollection = await fallbackResponse.json();
          if (generation !== fetchGenerationRef.current) return;
          startTransition(() => setCollection(fullCollection));
          return;
        }
        if (generation !== fetchGenerationRef.current) return;
        startTransition(() => setCollection(firstPage.concat(...pages)));
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      showToast(t('collection.errLoad'));
    } finally {
      if (generation === fetchGenerationRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const fetchSets = async () => {
    try {
      const response = await fetch('/api/sets');
      if (response.ok) setSetsList(await response.json());
    } catch (err) {
      console.error('Error fetching sets:', err);
    }
  };

  // Copy the selected cards as a text card list — "qty Name" (vanilla) or
  // "qty Name (SET) num" (detailed, ManaBox shape). The unstacked
  // filteredCollection is the source: in select mode every entry is its own
  // row, so nothing double-counts.
  const handleExportSelectionList = async (style) => {
    const rows = Array.from(selectedIds)
      .map(id => filteredCollection.find(i => i.entry_id === id))
      .filter(Boolean);
    const text = buildCardListText(rows, style);
    if (!text) { showToast(t('collection.errExportList')); return; }
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('collection.copiedList'));
    } catch (err) {
      console.error(err);
      showToast(t('collection.errExportList'));
    }
  };

  const handleDelete = async (entryId, cardName) => {
    if (!window.confirm(t('collection.confirmDeleteCard', { name: cardName }))) {
      return;
    }

    try {
      const response = await fetch(`/api/collection/${entryId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('collection.cardRemoved', { name: cardName }));
        onUpdate();
      } else {
        showToast(t('collection.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('common.errBackend'));
    }
  };

  const openEdit = (item) => {
    setInspectorCard(item);
    setInspectorStartEdit(true);
  };

  // Tap: swallowed if a long-press just armed selection; otherwise toggle (in
  // select mode) or open the inspector.
  const activateCard = (item, event) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) selectAt(item.entry_id, displayCards.map(i => i.entry_id), event?.shiftKey);
    else { setInspectorCard(item); setInspectorStartEdit(false); }
  };

  // Extract unique filter values from the loaded collection.
  const uniqueRarities = useMemo(
    () => Array.from(new Set(collection.map(item => item.rarity).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSets = useMemo(
    () => Array.from(new Set(collection.map(item => item.set_name).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueTypes = useMemo(
    () => Array.from(new Set(collection.flatMap(item => item.types || []).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSupertypes = useMemo(
    () => Array.from(new Set(collection.map(item => item.supertype).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueLanguages = useMemo(
    () => Array.from(new Set(collection.map(item => item.language).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueCmcs = useMemo(
    () => Array.from(new Set(collection.map(item => item.cmc).filter(v => v !== null && v !== undefined))).sort((a, b) => a - b),
    [collection]
  );

  const activeFilterCount = [
    rarityFilter, conditionFilter, printingFilter,
    setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter,
    minPriceFilter, maxPriceFilter
  ].filter(v => v !== '').length
    + (scryfallMode && scryfallQuery.trim() ? 1 : 0)
    + (tradeOnly ? 1 : 0) + (favoriteOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSearchFilter('');
    setScryfallQuery('');
    setRarityFilter(''); setConditionFilter('');
    setPrintingFilter(''); setSetFilter(''); setTypeFilter(''); setSupertypeFilter('');
    setCmcFilter(''); setLanguageFilter(''); setMinPriceFilter('');
    setMaxPriceFilter(''); setTradeOnly(false); setFavoriteOnly(false);
  };

  // The Scryfall-syntax query, classified and compiled once per keystroke.
  //   local   — every operator is answerable from the stored rows; the
  //             compiled predicate filters the loaded rows in the browser.
  //   catalog — some operator (otag:, availability:, artist:, ...) only
  //             Scryfall's database can answer; the server resolves it live
  //             and returns the user's owned rows (see liveCatalog below).
  //   error   — invalid syntax; shown inline and does not filter, so the list
  //             stays visible while the user fixes it.
  const scryfallPredicate = useMemo(() => {
    if (!scryfallMode || !scryfallQuery.trim()) return { mode: 'off' };
    let classification;
    try {
      classification = classifyQuery(scryfallQuery);
    } catch (err) {
      return { mode: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    if (classification.mode === 'catalog') return { mode: 'catalog' };
    return { mode: 'local', test: compileQuery(scryfallQuery) };
  }, [scryfallMode, scryfallQuery]);

  // The catalog query is the one that actually reaches Scryfall. Debounced,
  // because a half-typed tag is not a query yet — and every half-typed query
  // would otherwise be a real API call. Each new query supersedes in-flight
  // answers so a slow response can never paint over a newer one.
  useEffect(() => {
    if (scryfallPredicate.mode !== 'catalog') {
      liveFetchRef.current += 1;
      setLiveCatalog(null);
      setLiveLoading(false);
      setLiveError(null);
      return;
    }
    const generation = ++liveFetchRef.current;
    const timer = setTimeout(async () => {
      setLiveLoading(true);
      setLiveError(null);
      try {
        const params = new URLSearchParams();
        params.set('scope', 'collection');
        params.set('q', scryfallQuery.trim());
        const response = await fetchWithRetry(`/api/search?${params.toString()}`);
        if (generation !== liveFetchRef.current) return;
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          setLiveCatalog([]);
          if (response.status === 400) setLiveError(t('collection.scryfallInvalidQuery'));
          else if (response.status === 429) setLiveError(t('collection.scryfallRateLimited'));
          else setLiveError(errData.error || t('collection.scryfallLiveFailed'));
          return;
        }
        setLiveCatalog(await response.json());
      } catch (err) {
        if (err?.name === 'AbortError' || generation !== liveFetchRef.current) return;
        setLiveError(t('collection.scryfallLiveFailed'));
        setLiveCatalog([]);
      } finally {
        if (generation === liveFetchRef.current) setLiveLoading(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [scryfallPredicate, scryfallQuery, t]);

  // In catalog mode the answer only exists on the server: the live result
  // REPLACES the local rows — the binder behind it would read as "the query
  // did nothing." While it is resolving, the list is empty and the results
  // area shows the spinner (see below). A memo of its own, so the downstream
  // filter memo sees a stable identity unless an input actually changes.
  const baseCollection = useMemo(
    () => (scryfallPredicate.mode === 'catalog' ? (liveCatalog || []) : collection),
    [scryfallPredicate.mode, liveCatalog, collection]
  );

  // Filter + sort. Catalog-mode rows already came back filtered from the
  // server, so the local predicate only ever runs in local mode; an invalid
  // query shows its error and does not filter, so the list stays visible while
  // the user fixes the syntax.
  const filteredCollection = useMemo(() => {
    const searchLower = searchFilter ? searchFilter.toLowerCase() : '';
    const result = baseCollection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(searchLower) ||
                            (item.printed_name || '').toLowerCase().includes(searchLower) ||
                            (item.set_name || '').toLowerCase().includes(searchLower) ||
                            (item.number || '').includes(searchFilter);
      const matchesScryfall = scryfallPredicate.mode === 'local' ? scryfallPredicate.test(item) : true;
      const matchesRarity = rarityFilter === '' ? true : item.rarity === rarityFilter;
      const matchesCondition = conditionFilter === '' ? true : item.condition === conditionFilter;
      const matchesPrinting = printingFilter === '' ? true : item.printing === printingFilter;
      const matchesSet = setFilter === '' ? true : item.set_name === setFilter;
      const matchesType = typeFilter === '' ? true : (item.types || []).includes(typeFilter);
      const matchesSupertype = supertypeFilter === '' ? true : item.supertype === supertypeFilter;
      const matchesCmc = cmcFilter === '' ? true : String(item.cmc) === cmcFilter;
      const matchesLanguage = languageFilter === '' ? true : item.language === languageFilter;
      const matchesFavorite = favoriteOnly ? item.favorite === 1 : true;

      const price = item.price_trend || 0;
      const matchesMinPrice = minPriceFilter === '' ? true : price >= parseFloat(minPriceFilter);
      const matchesMaxPrice = maxPriceFilter === '' ? true : price <= parseFloat(maxPriceFilter);

      return matchesSearch && matchesScryfall && matchesRarity && matchesCondition &&
             matchesPrinting && matchesSet && matchesType && matchesSupertype &&
             matchesCmc && matchesLanguage && matchesFavorite && matchesMinPrice && matchesMaxPrice;
    });

    if (sortBy === 'qty-desc') {
      result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    } else if (sortBy !== 'added-newest') {
      // The server already guarantees added_at DESC, entry_id DESC. Preserve it
      // instead of constructing and comparing Date objects for every cold load.
      sortCardsByOrder(result, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest'], undefined, setsList);
    }
    return result;
  }, [baseCollection, searchFilter, scryfallPredicate, rarityFilter, conditionFilter, printingFilter, setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter, favoriteOnly, minPriceFilter, maxPriceFilter, sortBy, setsList]);

  // Group duplicate cards if stack option is active
  const processedCollection = useMemo(() => {
    if (!stackCards) return filteredCollection;

    const groups = {};
    filteredCollection.forEach(item => {
      let key = item.card_id;
      if (stackByCondition) key += `-${item.condition}`;
      if (stackByPrinting) key += `-${item.printing}`;

      if (!groups[key]) {
        groups[key] = { ...item };
      } else {
        groups[key].quantity += item.quantity;
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

  // In select mode, render the unstacked list so every entry is individually
  // selectable and bulk actions hit real entry_ids (stacking merges rows).
  const displayCards = selectMode ? filteredCollection : processedCollection;

  // Progressive rendering: a 20,000-card collection would otherwise mount every
  // tile at once (tens of thousands of DOM nodes + images) and freeze the page
  // for many seconds. Render a small first batch and extend ahead of the scroll
  // position. 96 is several desktop/mobile screens without asking the browser
  // to create and image-track hundreds of off-screen cards up front.
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDER_COUNT);
  const sentinelRef = useRef(null);

  // Reset to the first batch whenever the visible card set can change (filters,
  // sort, search, stacking, view mode, selection mode) or after a fresh fetch.
  useEffect(() => {
    setVisibleCount(INITIAL_RENDER_COUNT);
  }, [displayCards, viewMode, selectMode, collection]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= displayCards.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount(c => Math.min(c + LOAD_MORE_RENDER_COUNT, displayCards.length));
      }
    }, { rootMargin: '800px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [displayCards, visibleCount]);

  const visibleCards = displayCards.slice(0, visibleCount);
  const showSentinel = visibleCount < displayCards.length;

  const totalValue = useMemo(
    () => displayCards.reduce((sum, item) => sum + (item.price_trend || 0) * (item.quantity || 1), 0),
    [displayCards]
  );

  return (
    <div>
      {/* Header: sub-tabs + selection hint + view toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-strong)', padding: '0.45rem 0.5rem' }}>{t('nav.collection')}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Multi-select toggle (long-press cards is the primary path) */}
          <button
            className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            title={t('collection.selectHint')}
          >
            <MousePointerClick size={14} />
            {t(selectMode ? 'bulk.done' : 'collection.select')}
          </button>

          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('gallery')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.galleryView')}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('list')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.listView')}
            >
              <List size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Filter Panel */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem' }}>
        {/* Always-visible top bar: search + sort + filters toggle */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2.5fr) minmax(150px, 1fr) auto', gap: '0.75rem', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-end', minWidth: 0 }}>
            <Field label={t('collection.searchLabel')} style={{ flex: 1 }}>
              {scryfallMode ? (
                // Scryfall-syntax mode: a raw operator query replaces the plain
                // text box. Monospace on purpose — the query is a string with
                // operators in it, not a card name.
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text"
                      className="input-control"
                      placeholder={t('collection.scryfallPlaceholder')}
                      value={scryfallQuery}
                      onChange={(e) => setScryfallQuery(e.target.value)}
                      style={{ width: '100%', paddingLeft: '2.5rem', fontFamily: 'var(--font-mono, monospace)' }}
                    />
                    <Braces size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  </div>
                  <p style={{
                    fontSize: '0.7rem', margin: 0, lineHeight: 1.4,
                    color: scryfallPredicate.mode === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
                  }}>
                    {scryfallPredicate.mode === 'error' ? scryfallPredicate.error
                      : scryfallPredicate.mode === 'catalog' ? t('collection.scryfallLiveHint')
                      : t('collection.scryfallHint')}
                  </p>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    className="input-control"
                    placeholder={t('collection.searchPlaceholder')}
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    style={{ width: '100%', paddingLeft: '2.5rem' }}
                  />
                  <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                </div>
              )}
            </Field>
            <button
              className={`btn ${scryfallMode ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                const next = !scryfallMode;
                setScryfallMode(next);
                localStorage.setItem('collection_scryfall_mode', next ? '1' : '0');
              }}
              title={t('collection.scryfallToggle')}
              style={{ padding: '0.4rem 0.55rem', height: '40px', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', fontSize: '0.7rem' }}
            >
              <Braces size={14} /> {t('collection.scryfallToggle')}
            </button>
          </div>

          <Field label={t('collection.sortBy')}>
            <select className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {['added-newest', 'added-oldest', 'name-asc', 'name-desc', 'price-desc', 'price-asc', 'qty-desc', 'set-asc', 'number-asc', 'type-asc', 'rarity-desc', 'rarity-asc', 'language-asc', 'favorite-first']
                .map(key => <option key={key} value={key}>{t(`collection.sort.${key}`)}</option>)}
            </select>
          </Field>

          <button
            className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowFilters(s => !s)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <SlidersHorizontal size={15} />
            {t('collection.filters')}
            {activeFilterCount > 0 && (
              <span style={{ background: 'var(--accent-red)', color: 'var(--text-strong)', fontSize: '0.65rem', fontWeight: 900, borderRadius: '999px', padding: '1px 7px', minWidth: '18px', textAlign: 'center' }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-glass)' }}>
            {/* Selector filters grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>
              <Field label={t('collection.fSet')}>
                <select className="select-control" value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
                  <option value="">{t('collection.allSets')}</option>
                  {uniqueSets.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>

              <Field label={t('collection.fSupertype')}>
                <select className="select-control" value={supertypeFilter} onChange={(e) => setSupertypeFilter(e.target.value)}>
                  <option value="">{t('collection.allSupertypes')}</option>
                  {uniqueSupertypes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>

              <Field label={t('collection.fType')}>
                <select className="select-control" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">{t('collection.allTypes')}</option>
                  {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>

              <Field label={t('collection.fRarity')}>
                <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                  <option value="">{t('collection.allRarities')}</option>
                  {uniqueRarities.map(rarity => (
                    <option key={rarity} value={rarity}>{rarity}</option>
                  ))}
                </select>
              </Field>

              <Field label={t('card.condition')}>
                <select className="select-control" value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)}>
                  <option value="">{t('collection.allConditions')}</option>
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>

              <Field label={t('card.printing')}>
                <select className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                  <option value="">{t('collection.allPrintings')}</option>
                  {PRINTING_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>

              {uniqueCmcs.length > 0 && (
                <Field label={t('collection.fManaValue')}>
                  <select className="select-control" value={cmcFilter} onChange={(e) => setCmcFilter(e.target.value)}>
                    <option value="">{t('collection.allManaValues')}</option>
                    {uniqueCmcs.map(c => <option key={c} value={String(c)}>{c}</option>)}
                  </select>
                </Field>
              )}

              <Field label={t('card.language')}>
                <select className="select-control" value={languageFilter} onChange={(e) => setLanguageFilter(e.target.value)}>
                  <option value="">{t('collection.allLanguages')}</option>
                  {uniqueLanguages.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>

              <Field label={t('collection.fMinPrice')}>
                <input type="number" className="input-control" placeholder={t('collection.minPricePlaceholder')} value={minPriceFilter} onChange={(e) => setMinPriceFilter(e.target.value)} />
              </Field>

              <Field label={t('collection.fMaxPrice')}>
                <input type="number" className="input-control" placeholder={t('collection.maxPricePlaceholder')} value={maxPriceFilter} onChange={(e) => setMaxPriceFilter(e.target.value)} />
              </Field>
            </div>

            {/* Options row: stacking + trade + clear */}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="stackCardsOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                  {t('collection.stackDuplicates')}
                </label>
              </div>

              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByConditionOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByCondition')}
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByPrintingOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByPrinting')}
                    </label>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="tradeOnlyOpt" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="tradeOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>
                  {t('collection.tradeOnly')}
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="favoriteOnlyOpt" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="favoriteOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: '#facc15', fontWeight: 600 }}>
                  {t('collection.favoritesOnly')}
                </label>
              </div>

              {activeFilterCount > 0 && (
                <button className="btn btn-secondary" onClick={clearAllFilters} style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={13} /> {t('collection.clearFilters')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Result summary bar */}
      {!loading && !liveLoading && !selectMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', fontSize: '0.78rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span>
            <strong style={{ color: 'var(--text-strong)' }}>{displayCards.length}</strong> {t('collection.cardUnit', { count: displayCards.length })}{loadingMore ? ` · ${t('common.loading')}` : ''}
            {scryfallPredicate.mode === 'catalog' && !liveError ? ` · ${t('collection.scryfallLiveNote')}` : ''}
            {liveError ? ` · ${liveError}` : ''}
          </span>
          <span>{t('collection.totalValue')} <strong style={{ color: 'var(--accent-yellow)' }}>${formatPrice(totalValue)}</strong></span>
        </div>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div className="glass-panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count: selectedIds.size })}</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setSelectedIds(new Set(filteredCollection.map(i => i.entry_id)))}>{t('bulk.selectAll', { count: filteredCollection.length })}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={clearSelection}>{t('bulk.clear')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => handleExportSelectionList('plain')} title={t('settings.cardlistHint')}>{t('collection.exportListPlain')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => handleExportSelectionList('detailed')} title={t('settings.cardlistHint')}>{t('collection.exportListDetailed')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('delete', null, t('bulk.confirmDelete', { count: selectedIds.size }))}>{t('bulk.delete')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('trade', null)}>{t('bulk.markTrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('untrade', null)}>{t('bulk.untrade')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('condition', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setCondition')}</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('printing', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setPrinting')}</option>
            {PRINTING_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <PackPriceSplitter
            entryIds={Array.from(selectedIds)}
            showToast={showToast}
            onApplied={() => { clearSelection(); onUpdate(); }}
          />
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <AddToDeckSelect
            onAdd={(id) => runBulk('add_to_deck', id)}
            disabled={!selectedIds.size}
            style={{ fontSize: '0.72rem', maxWidth: '160px', padding: '0.3rem 0.4rem' }}
          />
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', marginLeft: 'auto' }} onClick={exitSelectMode}>{t('bulk.done')}</button>
        </div>
      )}

      {loading || liveLoading ? (
        <div className="spinner"></div>
      ) : displayCards.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          {scryfallPredicate.mode === 'catalog' ? (
            <p>{liveError || t('collection.scryfallLiveEmpty')}</p>
          ) : (
            <p>{t('collection.noMatches')} {t(activeFilterCount > 0 ? 'collection.noMatchesFiltered' : 'collection.noMatchesEmpty')}</p>
          )}
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View */
        <div className="card-grid">
          {visibleCards.map((item) => {
            const rarityStyle = getCardRarityBorder(item.rarity);
            const selected = selectedIds.has(item.entry_id);

            return (
              <div
                key={item.entry_id}
                className="tcg-card tilt-card-wrapper"
                style={{ cursor: 'pointer', touchAction: 'pan-y' }}
                onClick={(e) => activateCard(item, e)}
                {...pressHandlers(item.entry_id)}
              >
                <div className="tcg-card-inner" style={{ ...rarityStyle, ...(selected ? { outline: '3px solid var(--accent-red)', outlineOffset: '2px' } : {}) }}>
                  {selectMode && (
                    <div style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 20, width: '22px', height: '22px', borderRadius: '50%', background: selected ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.8rem', fontWeight: 900 }}>{selected ? '✓' : ''}</div>
                  )}
                  <CardImage card={item} className="tcg-card-image" loading="lazy" draggable={false} />
                  {getFoilOverlayClass(item.printing) && (
                    <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {item.quantity > 1 && (
                    <div className="tcg-card-quantity-tag">x{item.quantity}</div>
                  )}

                  {/* Rarity badge (shared tier system) */}
                  <span style={{
                    position: 'absolute',
                    top: '6px',
                    left: '6px',
                    fontSize: '0.55rem',
                    fontWeight: 900,
                    padding: '2px 4px',
                    borderRadius: '3px',
                    zIndex: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                    ...getRarityBadgeStyle(item.rarity)
                  }}>
                    {getRarityBadgeLabel(item.rarity)}
                  </span>

                  {/* Overlay Tags */}
                  <div style={{
                    position: 'absolute',
                    bottom: '6px',
                    left: '6px',
                    right: '6px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '4px',
                    pointerEvents: 'none'
                  }}>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: 800,
                      padding: '2px 5px',
                      borderRadius: '3px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      color: 'var(--text-strong)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      textTransform: 'uppercase'
                    }}>
                      {item.condition === 'Near Mint' ? 'NM' :
                       item.condition === 'Lightly Played' ? 'LP' :
                       item.condition === 'Moderately Played' ? 'MP' :
                       item.condition === 'Heavily Played' ? 'HP' : 'DMG'}
                    </span>
                    {item.printing !== 'Normal' && (
                      <span style={{
                        fontSize: '0.6rem',
                        fontWeight: 800,
                        padding: '2px 5px',
                        borderRadius: '3px',
                        ...getPrintingBadgeStyle(item.printing),
                        border: '1px solid rgba(255, 255, 255, 0.2)'
                      }}>
                        {getPrintingBadgeLabel(item.printing)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="tcg-card-info">
                  <div className="tcg-card-name">{getCardDisplayName(item.name, item.language, item.printed_name)}</div>
                  <div className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{item.set_name} • #{item.number}</span>
                    <span className="tcg-card-price">{priceText(item.price_trend, item.price_currency)}</span>
                  </div>
                </div>
              </div>
            );
          })}
          {showSentinel && <div ref={sentinelRef} style={{ height: 1, clear: 'both' }} aria-hidden="true" />}
        </div>
      ) : (
        /* Traditional List Table View */
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowY: 'auto' }}>
            <table className="collection-table" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>{t('collection.colCard')}</th>
                  <th style={{ width: '70px', textAlign: 'right' }}>{t('collection.colQtyValue')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleCards.map((item) => {
                  const selected = selectedIds.has(item.entry_id);
                  return (
                  <tr key={item.entry_id} style={selected ? { background: 'rgba(255,71,71,0.12)' } : undefined}>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelect(item.entry_id)}
                            style={{ width: '18px', height: '18px', flexShrink: 0, cursor: 'pointer' }}
                          />
                        )}
                        <div
                          onClick={(e) => activateCard(item, e)}
                          {...pressHandlers(item.entry_id)}
                          style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', cursor: 'pointer', touchAction: 'pan-y', ...getCardRarityBorder(item.rarity) }}
                        >
                          <CardImage card={item} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} draggable={false} />
                          {getFoilOverlayClass(item.printing) && (
                            <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div onClick={(e) => activateCard(item, e)} {...pressHandlers(item.entry_id)} style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{getCardDisplayName(item.name, item.language, item.printed_name)}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span>{item.set_name} • #{item.number}</span>
                            <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 3px', borderRadius: '3px', flexShrink: 0, ...getRarityBadgeStyle(item.rarity) }}>
                              {getRarityBadgeLabel(item.rarity)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                            {getPrintingLabel(item.printing)} • {item.condition}
                          </div>
                          {!selectMode && (
                            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '2px' }}>
                              <button className="btn btn-secondary btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => openEdit(item)} title={t('common.edit')}>
                                <Edit2 size={9} />
                              </button>
                              <button className="btn btn-danger btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => handleDelete(item.entry_id, getCardDisplayName(item.name, item.language, item.printed_name))} title={t('common.delete')}>
                                <Trash2 size={9} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: '0.6rem' }}>
                      {item.quantity > 1 && (
                        <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      )}
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>{priceText(item.price_trend, item.price_currency)}</div>
                    </td>
                  </tr>
                  );
                })}
                {showSentinel && (
                  <tr><td colSpan={2} style={{ padding: 0 }}><div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Card Detail Inspector Modal (Private Authorized View) */}
      <CardInspectorModal
        card={inspectorCard}
        startInEdit={inspectorStartEdit}
        onClose={() => { setInspectorCard(null); setInspectorStartEdit(false); }}
        onUpdate={onUpdate}
        showToast={showToast}
      />
    </div>
  );
}

export default CollectionList;
