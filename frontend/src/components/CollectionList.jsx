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
import {
  catalogDebounceMs,
  catalogRowsForQuery,
  loadCatalogCollection,
  mapWithConcurrency,
  reconcileCollectionHydration,
} from '../utils/collectionCatalogLoading';
import {
  collectionSessionCache,
  makeCollectionSessionQuery,
  waitForCollectionIdle,
} from '../utils/collectionSessionCache';
import { useMultiSelect } from '../utils/useMultiSelect';
import { useT } from '../utils/i18n';
import { analyze, compileQuery } from '../../../shared/scryfallQuery.js';
import { looksLikeSyntax } from '../utils/scryfallSyntax';
import CardInspectorModal from './CardInspectorModal';
import AddToDeckSelect from './AddToDeckSelect';
import PackPriceSplitter from './PackPriceSplitter';
import CardImage from './CardImage';
import MultiSelectDropdown from './MultiSelectDropdown';

const labelStyle = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' };
const INITIAL_RENDER_COUNT = 96;
const BACKGROUND_PAGE_SIZE = 2000;
const BACKGROUND_PAGE_CONCURRENCY = 2;
const VIRTUAL_OVERSCAN_ROWS = 4;
const GALLERY_CARD_INFO_HEIGHT = 49;
const LIST_ROW_HEIGHT = 82;

function computeVirtualRange(itemCount, columns, rowStride, scrollTop, viewportHeight) {
  const safeColumns = Math.max(1, columns);
  const rowCount = Math.ceil(itemCount / safeColumns);
  if (rowCount === 0) {
    return { startIndex: 0, endIndex: 0, startRow: 0, endRow: 0, rowCount: 0 };
  }

  const firstVisibleRow = Math.floor(Math.max(0, scrollTop) / rowStride);
  const lastVisibleRow = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / rowStride);
  const startRow = Math.max(0, Math.min(rowCount - 1, firstVisibleRow - VIRTUAL_OVERSCAN_ROWS));
  const endRow = Math.min(rowCount, Math.max(startRow + 1, lastVisibleRow + VIRTUAL_OVERSCAN_ROWS));

  return {
    startIndex: startRow * safeColumns,
    endIndex: Math.min(itemCount, endRow * safeColumns),
    startRow,
    endRow,
    rowCount,
  };
}

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

function CollectionList({ statsTrigger, onUpdate, showToast, token, selectedCardFilter, setSelectedCardFilter }) {
  const { t } = useT();
  const [tradeOnly, setTradeOnly] = useState(false);
  const initialQueryRef = useRef(makeCollectionSessionQuery({
    authKey: token,
    revision: statsTrigger,
    tradeOnly: false,
  }));
  const initialCacheRef = useRef(collectionSessionCache.read(initialQueryRef.current));
  const initialSetsRef = useRef(collectionSessionCache.readSets(initialQueryRef.current));
  const initialCache = initialCacheRef.current;
  const [collection, setCollection] = useState(() => initialCache?.rows || []);
  const [setsList, setSetsList] = useState(() => initialSetsRef.current?.sets || []);
  const [loading, setLoading] = useState(() => !initialCache);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hydrationStatus, setHydrationStatus] = useState(() => initialCache?.status || 'idle');
  const [hydrationError, setHydrationError] = useState(() => initialCache?.error || null);
  const fetchGenerationRef = useRef(0);
  const fetchAbortRef = useRef(null);
  const collectionHydrationRef = useRef({
    key: initialCache?.queryKey || null,
    status: initialCache?.status || 'idle',
  });

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
  // One unified box: a plain card name/number/set OR Scryfall syntax
  // (is:land color:g, otag:..., quoted phrases, -negation, (groups)). Syntax
  // is auto-detected from the text — no mode toggle. Real card names never
  // contain an operator token, a quote, a paren, or a leading "-", so the
  // detection cannot misfire on a name; a string that LOOKS like syntax but
  // does not parse is shown inline as an error and does not filter.
  const [searchFilter, setSearchFilter] = useState(() => selectedCardFilter || '');
  const [rarityFilter, setRarityFilter] = useState([]);
  const [conditionFilter, setConditionFilter] = useState([]);
  const [printingFilter, setPrintingFilter] = useState([]);
  const [setFilter, setSetFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [supertypeFilter, setSupertypeFilter] = useState([]);
  const [cmcFilter, setCmcFilter] = useState([]);
  const [languageFilter, setLanguageFilter] = useState([]);
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [favoriteOnly, setFavoriteOnly] = useState(false);

  // Live-catalog mode: the query contains an operator only Scryfall's
  // database can answer (otag:, availability:, artist: ...). Those cannot be
  // evaluated against the loaded rows, so the query goes to the server, which
  // resolves it against Scryfall and returns the user's OWN rows for the
  // matches. Debounced, because a half-typed tag is not a query yet — and
  // every half-typed query would otherwise be a real API call.
  const [liveState, setLiveState] = useState({
    queryKey: null,
    rows: null,
    loading: false,
    error: null,
    incomplete: false,
    total: null,
    cacheStatus: null,
  });
  const liveFetchRef = useRef(0);
  const liveAbortRef = useRef(null);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  // Multi-select / bulk actions — shared long-press + /api/collection/bulk logic.
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode,
    pressHandlers, longPressFired, runBulk,
  } = useMultiSelect({ showToast, onChanged: onUpdate });

  const collectionSessionQuery = useMemo(() => makeCollectionSessionQuery({
    authKey: token,
    revision: statsTrigger,
    tradeOnly,
  }), [token, statsTrigger, tradeOnly]);

  useEffect(() => {
    if (initialSetsRef.current?.setsReady) return undefined;
    let active = true;
    fetchSets(initialQueryRef.current, () => active);
    return () => { active = false; };
  // The set catalog is static collection-view metadata; card mutations should
  // not download it again.
  }, []);

  const fetchCollection = async (sessionQuery) => {
    const generation = ++fetchGenerationRef.current;
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    const cacheLease = collectionSessionCache.begin(sessionQuery);
    const cached = collectionSessionCache.read(sessionQuery);
    let partialRows = cached?.rows || [];
    let expectedTotal = cached?.total || partialRows.length;
    fetchAbortRef.current = controller;
    collectionHydrationRef.current = { key: sessionQuery.queryKey, status: 'loading' };
    setHydrationStatus('loading');
    setHydrationError(null);

    try {
      setLoading(partialRows.length === 0);
      setLoadingMore(partialRows.length > 0);
      if (partialRows.length) setCollection(partialRows);

      const params = new URLSearchParams({
        limit: String(INITIAL_RENDER_COUNT),
        offset: '0'
      });
      if (sessionQuery.tradeOnly) params.set('is_trade', '1');

      // Cold path: request only what can be painted immediately. This stays fast
      // even when the physical collection grows to hundreds of thousands of rows.
      const response = await fetchWithRetry(
        `/api/collection?${params}`,
        { signal: controller.signal }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const firstPage = await response.json();
      const total = Math.max(firstPage.length, parseInt(response.headers.get('X-Total-Count'), 10) || 0);
      if (generation !== fetchGenerationRef.current || controller.signal.aborted) return;
      partialRows = firstPage;
      expectedTotal = total;
      const firstStatus = firstPage.length < total ? 'partial' : 'complete';
      if (!collectionSessionCache.write(cacheLease, {
        rows: firstPage,
        total,
        status: firstStatus,
      })) return;
      if (firstStatus === 'complete' && !collectionSessionCache.read(sessionQuery)?.complete) {
        throw new Error('Incomplete collection hydration: duplicate or missing entry IDs');
      }
      setCollection(firstPage);
      setLoading(false);
      setHydrationStatus(firstStatus);
      collectionHydrationRef.current = { key: sessionQuery.queryKey, status: firstStatus };

      if (firstPage.length < total) {
        setLoadingMore(true);

        // Yield until after the bounded 96-row paint. requestIdleCallback's
        // timeout prevents starvation; browsers without it use a short timer.
        if (!await waitForCollectionIdle({ signal: controller.signal })) return;
        if (generation !== fetchGenerationRef.current || controller.signal.aborted) return;

        const pageOffsets = [];
        for (let offset = firstPage.length; offset < total; offset += BACKGROUND_PAGE_SIZE) {
          pageOffsets.push(offset);
        }

        // Fetch at most two slices concurrently. Large collections can require
        // dozens of pages; eagerly Promise.all-ing every request competes with
        // images and interactive API work even though we commit only once.
        let pages;
        try {
          pages = await mapWithConcurrency(
            pageOffsets,
            BACKGROUND_PAGE_CONCURRENCY,
            async (offset) => {
              const pageParams = new URLSearchParams({
                limit: String(BACKGROUND_PAGE_SIZE),
                offset: String(offset),
                count: '0'
              });
              if (sessionQuery.tradeOnly) pageParams.set('is_trade', '1');
              const pageResponse = await fetchWithRetry(
                `/api/collection?${pageParams}`,
                { signal: controller.signal }
              );
              if (!pageResponse.ok) throw new Error(`HTTP ${pageResponse.status}`);
              return pageResponse.json();
            }
          );
        } catch (backgroundError) {
          if (backgroundError?.name === 'AbortError' || controller.signal.aborted) throw backgroundError;

          // Never leave filters, totals, or bulk operations working on a silent
          // 96-row subset. If a page still fails after retries, fall back to the
          // compatible full endpoint; this slower path is only for recovery.
          const fallbackUrl = sessionQuery.tradeOnly ? '/api/collection?is_trade=1' : '/api/collection';
          const fallbackResponse = await fetchWithRetry(fallbackUrl, { signal: controller.signal });
          if (!fallbackResponse.ok) throw backgroundError;
          const fullCollection = await fallbackResponse.json();
          if (generation !== fetchGenerationRef.current || controller.signal.aborted) return;
          if (!collectionSessionCache.write(cacheLease, {
            rows: fullCollection,
            total: fullCollection.length,
            status: 'complete',
          })) return;
          if (!collectionSessionCache.read(sessionQuery)?.complete) {
            throw new Error('Incomplete collection hydration: duplicate or missing entry IDs');
          }
          collectionHydrationRef.current = { key: sessionQuery.queryKey, status: 'complete' };
          startTransition(() => {
            setCollection(current => generation === fetchGenerationRef.current && !controller.signal.aborted
              ? fullCollection : current);
            setHydrationStatus(current => generation === fetchGenerationRef.current && !controller.signal.aborted
              ? 'complete' : current);
            setHydrationError(current => generation === fetchGenerationRef.current && !controller.signal.aborted
              ? null : current);
          });
          return;
        }
        if (generation !== fetchGenerationRef.current || controller.signal.aborted) return;
        const fullCollection = firstPage.concat(...pages);
        partialRows = fullCollection;
        if (fullCollection.length !== total) {
          throw new Error(`Incomplete collection hydration: expected ${total}, received ${fullCollection.length}`);
        }
        if (!collectionSessionCache.write(cacheLease, {
          rows: fullCollection,
          total,
          status: 'complete',
        })) return;
        if (!collectionSessionCache.read(sessionQuery)?.complete) {
          throw new Error('Incomplete collection hydration: duplicate or missing entry IDs');
        }
        collectionHydrationRef.current = { key: sessionQuery.queryKey, status: 'complete' };
        startTransition(() => {
          setCollection(current => generation === fetchGenerationRef.current && !controller.signal.aborted
            ? fullCollection : current);
          setHydrationStatus(current => generation === fetchGenerationRef.current && !controller.signal.aborted
            ? 'complete' : current);
          setHydrationError(current => generation === fetchGenerationRef.current && !controller.signal.aborted
            ? null : current);
        });
      }
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted
        || generation !== fetchGenerationRef.current) {
        return;
      }
      collectionSessionCache.write(cacheLease, {
        rows: partialRows,
        total: expectedTotal,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      collectionHydrationRef.current = { key: sessionQuery.queryKey, status: 'error' };
      setHydrationStatus('error');
      setHydrationError(err instanceof Error ? err.message : String(err));
      console.error(err);
      showToast(t('collection.errLoad'));
    } finally {
      if (generation === fetchGenerationRef.current && !controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const fetchSets = async (sessionQuery, isActive = () => true) => {
    try {
      const response = await fetch('/api/sets');
      if (!response.ok) return;
      const sets = await response.json();
      if (!isActive()) return;
      collectionSessionCache.setSets(sessionQuery, sets);
      setSetsList(sets);
    } catch (err) {
      if (isActive()) console.error('Error fetching sets:', err);
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

  const activeFilterCount =
    [rarityFilter, conditionFilter, printingFilter,
    setFilter, typeFilter, supertypeFilter, cmcFilter, languageFilter]
      .filter(v => v.length > 0).length
    + (searchFilter.trim() ? 1 : 0)
    + (minPriceFilter !== '' ? 1 : 0)
    + (maxPriceFilter !== '' ? 1 : 0)
    + (tradeOnly ? 1 : 0)
    + (favoriteOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSearchFilter('');
    setRarityFilter([]); setConditionFilter([]);
    setPrintingFilter([]); setSetFilter([]); setTypeFilter([]); setSupertypeFilter([]);
    setCmcFilter([]); setLanguageFilter([]);
    setMinPriceFilter(''); setMaxPriceFilter('');
    setTradeOnly(false); setFavoriteOnly(false);
  };

  // The unified box, classified and compiled once per keystroke. Plain names
  // stay 'off' (the plain name/number/set match below does the work); a
  // string that looks like syntax but does not parse is 'error' — shown
  // inline and does not filter, so the list stays visible while the user
  // fixes it.
  //   local   — every operator is answerable from the stored rows; the
  //             compiled predicate filters the loaded rows in the browser.
  //   catalog — some operator (otag:, availability:, artist:, ...) only
  //             Scryfall's database can answer; the server resolves it live
  //             and returns the user's owned rows (see liveCatalog below).
  const scryfallPredicate = useMemo(() => {
    const text = searchFilter.trim();
    if (!text || !looksLikeSyntax(text)) return { mode: 'off' };
    let analysis;
    try {
      analysis = analyze(text);
    } catch (err) {
      return { mode: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    if (analysis.mode === 'catalog') return { mode: 'catalog', operators: analysis.operators };
    return { mode: 'local', operators: analysis.operators, test: compileQuery(text) };
  }, [searchFilter]);

  // No hint copy under the box (it made the panel jumbled on phones), so a
  // query that does not parse is named once via toast instead — and only
  // once per distinct bad string, not on every keystroke of it.
  const lastErrorToast = useRef('');
  useEffect(() => {
    if (scryfallPredicate.mode === 'error' && scryfallPredicate.error !== lastErrorToast.current) {
      lastErrorToast.current = scryfallPredicate.error;
      showToast(scryfallPredicate.error);
    }
  }, [scryfallPredicate, showToast]);

  // Catalog results replace the ordinary collection, so downloading both is
  // pure waste. Reconcile by data-generation key: catalog mode aborts a
  // partial ordinary hydration, and returning to any browser-filtered mode
  // restarts only when that hydration was aborted/partial or the key changed.
  const collectionHydrationKey = collectionSessionQuery.queryKey;
  useEffect(() => {
    if (scryfallPredicate.mode !== 'catalog') {
      const cached = collectionSessionCache.read(collectionSessionQuery);
      if (cached?.complete) {
        if (collectionHydrationRef.current.key !== collectionHydrationKey
          && ['loading', 'partial'].includes(collectionHydrationRef.current.status)) {
          fetchGenerationRef.current += 1;
          fetchAbortRef.current?.abort();
        }
        setCollection(cached.rows);
        if (cached.setsReady) setSetsList(cached.sets);
        setLoading(false);
        setLoadingMore(false);
        setHydrationStatus('complete');
        setHydrationError(null);
        collectionHydrationRef.current = { key: collectionHydrationKey, status: 'complete' };
        return;
      }
      if (cached) {
        setCollection(cached.rows);
        if (cached.setsReady) setSetsList(cached.sets);
        setHydrationStatus(cached.status);
        setHydrationError(cached.error);
        collectionHydrationRef.current = { key: collectionHydrationKey, status: cached.status };
      }
    }

    const decision = reconcileCollectionHydration(
      scryfallPredicate.mode,
      collectionHydrationKey,
      collectionHydrationRef.current,
    );
    collectionHydrationRef.current = decision.state;
    if (scryfallPredicate.mode === 'catalog') {
      if (decision.action === 'abort') {
        fetchGenerationRef.current += 1;
        fetchAbortRef.current?.abort();
      }
      setLoading(false);
      setLoadingMore(false);
    } else if (decision.action === 'start') {
      fetchCollection(collectionSessionQuery);
    }
  // fetchCollection intentionally keys its lifecycle through refs above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionHydrationKey, scryfallPredicate.mode]);

  // Each catalog generation owns an AbortController as well as a generation
  // guard. The first 96 rows paint immediately; capped 2000-row pages hydrate
  // in the background and commit together. Cached rows remain visible only
  // when their query key exactly matches the query being refreshed.
  const catalogQueryKey = searchFilter.trim();
  useEffect(() => {
    if (scryfallPredicate.mode !== 'catalog') {
      liveFetchRef.current += 1;
      liveAbortRef.current?.abort();
      setLiveState({
        queryKey: null, rows: null, loading: false, error: null,
        incomplete: false, total: null, cacheStatus: null,
      });
      return;
    }

    const generation = ++liveFetchRef.current;
    liveAbortRef.current?.abort();
    const controller = new AbortController();
    liveAbortRef.current = controller;
    const isCurrent = () => generation === liveFetchRef.current && !controller.signal.aborted;

    setLiveState(previous => ({
      queryKey: catalogQueryKey,
      rows: previous.queryKey === catalogQueryKey ? previous.rows : null,
      loading: true,
      error: null,
      incomplete: previous.queryKey === catalogQueryKey ? previous.incomplete : false,
      total: previous.queryKey === catalogQueryKey ? previous.total : null,
      cacheStatus: previous.queryKey === catalogQueryKey ? previous.cacheStatus : null,
    }));

    const timer = setTimeout(async () => {
      try {
        const result = await loadCatalogCollection({
          query: catalogQueryKey,
          signal: controller.signal,
          isCurrent,
          onFirstPage: first => {
            if (!isCurrent()) return;
            setLiveState({
              queryKey: catalogQueryKey,
              rows: first.rows,
              loading: first.incomplete,
              error: null,
              incomplete: first.incomplete,
              total: first.total,
              cacheStatus: first.cacheStatus,
            });
          },
          onIncomplete: partial => {
            if (!isCurrent()) return;
            setLiveState({
              queryKey: catalogQueryKey,
              rows: partial.rows,
              loading: false,
              error: t('collection.scryfallLiveFailed'),
              incomplete: true,
              total: partial.total,
              cacheStatus: partial.cacheStatus,
            });
            // Promise.all rejects on the failed page; stop any sibling page
            // requests that are still consuming this generation's capacity.
            controller.abort();
          },
        });
        if (!isCurrent()) return;
        startTransition(() => setLiveState(previous => isCurrent() ? {
            queryKey: catalogQueryKey,
            rows: result.rows,
            loading: false,
            error: null,
            incomplete: result.incomplete,
            total: result.total,
            cacheStatus: result.cacheStatus,
          } : previous));
      } catch (err) {
        if (err?.name === 'AbortError' || !isCurrent()) return;
        let message = t('collection.scryfallLiveFailed');
        if (err.status === 400) message = t('collection.scryfallInvalidQuery');
        else if (err.status === 429) message = t('collection.scryfallRateLimited');
        else if (err.payload?.error) message = err.payload.error;
        setLiveState(previous => ({
          ...previous,
          queryKey: catalogQueryKey,
          rows: err.stage === 'background' ? (previous.rows || []) : [],
          loading: false,
          error: message,
          incomplete: err.stage === 'background',
        }));
      }
    }, catalogDebounceMs(scryfallPredicate.operators));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [catalogQueryKey, scryfallPredicate, statsTrigger, t]);

  useEffect(() => () => {
    fetchGenerationRef.current += 1;
    fetchAbortRef.current?.abort();
    liveFetchRef.current += 1;
    liveAbortRef.current?.abort();
  }, []);

  const liveCatalog = scryfallPredicate.mode === 'catalog'
    ? catalogRowsForQuery(liveState, catalogQueryKey)
    : null;
  const liveLoading = scryfallPredicate.mode === 'catalog'
    && (liveState.queryKey !== catalogQueryKey || liveState.loading);
  const liveError = liveState.queryKey === catalogQueryKey ? liveState.error : null;
  const liveIncomplete = liveState.queryKey === catalogQueryKey ? liveState.incomplete : false;

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
    // The box speaks syntax: when it does, the predicate (local) or the live
    // server answer (catalog) IS the search — the plain name/number/set
    // substring match would double-filter on the whole operator string and
    // empty the list, so it only runs for plain text. 'error' also skips it:
    // an unparseable query must not hide the list while it is being fixed.
    const plainSearch = scryfallPredicate.mode === 'off';
    const result = baseCollection.filter(item => {
      const matchesSearch = !plainSearch ? true :
        item.name.toLowerCase().includes(searchLower) ||
        (item.printed_name || '').toLowerCase().includes(searchLower) ||
        (item.set_name || '').toLowerCase().includes(searchLower) ||
        (item.number || '').includes(searchFilter);
      const matchesScryfall = scryfallPredicate.mode === 'local' ? scryfallPredicate.test(item) : true;
      const matchesRarity = rarityFilter.length === 0 ? true : rarityFilter.includes(item.rarity);
      const matchesCondition = conditionFilter.length === 0 ? true : conditionFilter.includes(item.condition);
      const matchesPrinting = printingFilter.length === 0 ? true : printingFilter.includes(item.printing);
      const matchesSet = setFilter.length === 0 ? true : setFilter.includes(item.set_name);
      const matchesType = typeFilter.length === 0 ? true : typeFilter.some(t => (item.types || []).includes(t));
      const matchesSupertype = supertypeFilter.length === 0 ? true : supertypeFilter.includes(item.supertype);
      const matchesCmc = cmcFilter.length === 0 ? true : cmcFilter.includes(String(item.cmc));
      const matchesLanguage = languageFilter.length === 0 ? true : languageFilter.includes(item.language);
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

  // The collection scrolls with the document, so the virtualizer tracks the
  // viewport against the gallery/table's document offset. The spacer preserves
  // the full scroll range while only viewport rows plus a small overscan stay
  // mounted. Fixed row geometry is mirrored in index.css; ResizeObserver keeps
  // the responsive auto-fill column calculation in step with container width.
  const virtualRootRef = useRef(null);
  const virtualFrameRef = useRef(null);
  const [virtualWindow, setVirtualWindow] = useState({
    startIndex: 0,
    endIndex: INITIAL_RENDER_COUNT,
    startRow: 0,
    endRow: INITIAL_RENDER_COUNT,
    rowCount: 0,
    columns: 1,
    rowStride: LIST_ROW_HEIGHT,
    gap: 0,
    totalSize: 0,
  });

  useEffect(() => {
    const root = virtualRootRef.current;
    if (!root) return undefined;

    const updateVirtualWindow = () => {
      virtualFrameRef.current = null;
      const width = root.clientWidth;
      const gallery = viewMode === 'gallery';
      const gap = gallery ? (window.innerWidth >= 769 ? 20 : 12) : 0;
      const minCardWidth = window.innerWidth >= 769 ? 180 : 130;
      const columns = gallery
        ? Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)))
        : 1;
      const cardWidth = gallery ? (width - gap * (columns - 1)) / columns : width;
      const rowHeight = gallery ? (cardWidth / 0.718) + GALLERY_CARD_INFO_HEIGHT : LIST_ROW_HEIGHT;
      const rowStride = rowHeight + gap;
      const rootTop = root.getBoundingClientRect().top + window.scrollY;
      const localScrollTop = Math.max(0, window.scrollY - rootTop);
      const range = computeVirtualRange(
        displayCards.length,
        columns,
        rowStride,
        localScrollTop,
        window.innerHeight,
      );
      const totalSize = Math.max(0, range.rowCount * rowStride - gap);
      const next = { ...range, columns, rowStride, gap, totalSize };

      setVirtualWindow(previous => (
        previous.startIndex === next.startIndex
        && previous.endIndex === next.endIndex
        && previous.columns === next.columns
        && Math.abs(previous.rowStride - next.rowStride) < 0.5
        && Math.abs(previous.totalSize - next.totalSize) < 0.5
          ? previous
          : next
      ));
    };

    const scheduleVirtualUpdate = () => {
      if (virtualFrameRef.current == null) {
        virtualFrameRef.current = window.requestAnimationFrame(updateVirtualWindow);
      }
    };

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleVirtualUpdate);
    resizeObserver?.observe(root);
    window.addEventListener('scroll', scheduleVirtualUpdate, { passive: true });
    window.addEventListener('resize', scheduleVirtualUpdate);
    scheduleVirtualUpdate();

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('scroll', scheduleVirtualUpdate);
      window.removeEventListener('resize', scheduleVirtualUpdate);
      if (virtualFrameRef.current != null) {
        window.cancelAnimationFrame(virtualFrameRef.current);
        virtualFrameRef.current = null;
      }
    };
  }, [displayCards.length, viewMode, showFilters, selectMode, loadingMore, hydrationError, liveLoading]);

  const virtualCards = displayCards.slice(
    Math.min(virtualWindow.startIndex, displayCards.length),
    Math.min(virtualWindow.endIndex, displayCards.length),
  );
  const virtualTopSize = virtualWindow.startRow * virtualWindow.rowStride;
  const virtualBottomSize = Math.max(
    0,
    (virtualWindow.rowCount - virtualWindow.endRow) * virtualWindow.rowStride,
  );

  const totalValue = useMemo(
    () => displayCards.reduce((sum, item) => sum + (item.price_trend || 0) * (item.quantity || 1), 0),
    [displayCards]
  );
  const catalogResultsIncomplete = scryfallPredicate.mode === 'catalog'
    && (liveLoading || liveIncomplete);
  const ordinaryResultsIncomplete = scryfallPredicate.mode !== 'catalog'
    && hydrationStatus !== 'complete';
  const resultsIncomplete = catalogResultsIncomplete || ordinaryResultsIncomplete;
  const retryCollectionHydration = () => {
    collectionSessionCache.invalidate(collectionSessionQuery);
    collectionHydrationRef.current = { key: collectionHydrationKey, status: 'error' };
    fetchCollection(collectionSessionQuery);
  };

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
              {/* One box, two languages: plain card name/number/set, or
                  Scryfall syntax — auto-detected, no toggle, no hint copy.
                  The box IS the documentation: monospace + braces icon the
                  moment it holds a query. (A hint paragraph here wrapped to
                  ten lines on phones and made the whole panel jumbled.) */}
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  className="input-control"
                  placeholder={t('collection.searchPlaceholder')}
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  style={{
                    width: '100%',
                    paddingLeft: '2.5rem',
                    fontFamily: looksLikeSyntax(searchFilter.trim()) ? 'var(--font-mono, monospace)' : undefined,
                  }}
                />
                {looksLikeSyntax(searchFilter.trim())
                  ? <Braces size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  : <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />}
              </div>
            </Field>
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
                <MultiSelectDropdown
                  label={t('collection.fSet')}
                  allLabel={t('collection.allSets')}
                  value={setFilter}
                  onChange={setSetFilter}
                  options={uniqueSets.map(s => ({ value: s, label: s }))}
                />
              </Field>

              <Field label={t('collection.fSupertype')}>
                <MultiSelectDropdown
                  label={t('collection.fSupertype')}
                  allLabel={t('collection.allSupertypes')}
                  value={supertypeFilter}
                  onChange={setSupertypeFilter}
                  options={uniqueSupertypes.map(s => ({ value: s, label: s }))}
                />
              </Field>

              <Field label={t('collection.fType')}>
                <MultiSelectDropdown
                  label={t('collection.fType')}
                  allLabel={t('collection.allTypes')}
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={uniqueTypes.map(t => ({value: t, label: t}))}
                />
              </Field>

              <Field label={t('collection.fRarity')}>
                <MultiSelectDropdown
                  label={t('collection.fRarity')}
                  allLabel={t('collection.allRarities')}
                  value={rarityFilter}
                  onChange={setRarityFilter}
                  options={uniqueRarities.map(r => ({value: r, label: r}))}
                />
              </Field>

              <Field label={t('card.condition')}>
                <MultiSelectDropdown
                  label={t('card.condition')}
                  allLabel={t('collection.allConditions')}
                  value={conditionFilter}
                  onChange={setConditionFilter}
                  options={CONDITIONS.map(c => ({value: c, label: c}))}
                />
              </Field>

              <Field label={t('card.printing')}>
                <MultiSelectDropdown
                  label={t('card.printing')}
                  allLabel={t('collection.allPrintings')}
                  value={printingFilter}
                  onChange={setPrintingFilter}
                  options={PRINTING_OPTIONS}
                />
              </Field>

              {uniqueCmcs.length > 0 && (
                <Field label={t('collection.fManaValue')}>
                  <MultiSelectDropdown
                    label={t('collection.fManaValue')}
                    allLabel={t('collection.allManaValues')}
                    value={cmcFilter}
                    onChange={setCmcFilter}
                    options={uniqueCmcs.map(c => ({ value: String(c), label: String(c) }))}
                  />
                </Field>
              )}

              <Field label={t('card.language')}>
                <MultiSelectDropdown
                  label={t('card.language')}
                  allLabel={t('collection.allLanguages')}
                  value={languageFilter}
                  onChange={setLanguageFilter}
                  options={uniqueLanguages.map(l => ({ value: l, label: l }))}
                />
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

      {/* Result summary bar. Hidden while a catalog answer is in flight: its
          count would be the STALE result's count, which reads as wrong. */}
      {!loading && !liveLoading && !selectMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', fontSize: '0.78rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span>
            <strong style={{ color: 'var(--text-strong)' }}>{displayCards.length}</strong> {t('collection.cardUnit', { count: displayCards.length })}{loadingMore ? ` · ${t('common.loading')}` : ''}
            {scryfallPredicate.mode === 'catalog' && !liveError ? ` · ${t('collection.scryfallLiveNote')}` : ''}
            {scryfallPredicate.mode === 'catalog' && liveIncomplete ? ` · ${t('collection.scryfallLiveIncomplete')}` : ''}
            {liveError ? ` · ${liveError}` : ''}
          </span>
          {!resultsIncomplete && (
            <span>{t('collection.totalValue')} <strong style={{ color: 'var(--accent-yellow)' }}>${formatPrice(totalValue)}</strong></span>
          )}
        </div>
      )}

      {scryfallPredicate.mode !== 'catalog' && hydrationError && (
        <div className="glass-panel" role="alert" style={{ marginBottom: '0.85rem', padding: '0.75rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>{t('collection.errLoad')}</span>
          <button className="btn btn-secondary" onClick={retryCollectionHydration} style={{ fontSize: '0.72rem', padding: '0.3rem 0.7rem' }}>
            Retry
          </button>
        </div>
      )}

      {/* Updating pill: a catalog answer is on the way but we already have a
          result to show, so the list stays up with a small note instead of a
          full-screen spinner. */}
      {scryfallPredicate.mode === 'catalog' && liveLoading && displayCards.length > 0 && !liveError && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          <span>{displayCards.length} {t('collection.cardUnit', { count: displayCards.length })} · {t('collection.scryfallLiveNote')}{liveIncomplete ? ` · ${t('collection.scryfallLiveIncomplete')}` : ''} · {t('collection.scryfallLiveUpdating')}</span>
        </div>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div className="glass-panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count: selectedIds.size })}</span>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }}
            disabled={resultsIncomplete}
            onClick={() => setSelectedIds(new Set(filteredCollection.map(i => i.entry_id)))}
          >
            {t('bulk.selectAll', { count: filteredCollection.length })}
          </button>
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

      {/* The full-screen spinner only when there is nothing else to show.
          In catalog mode with a previous result, that list stays up while the
          new answer is in flight (the pill above carries the state); in
          local mode `loading` covers the initial fetch. */}
      {(loading || (liveLoading && !liveCatalog)) ? (
        <div className="spinner"></div>
      ) : displayCards.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          {scryfallPredicate.mode === 'catalog' ? (
            <p>
              {liveError || t('collection.scryfallLiveEmpty')}
              {liveIncomplete && <small style={{ display: 'block', marginTop: '0.5rem', opacity: 0.7 }}>{t('collection.scryfallLiveIncomplete')}</small>}
            </p>
          ) : (
            <p>{t('collection.noMatches')} {t(activeFilterCount > 0 ? 'collection.noMatchesFiltered' : 'collection.noMatchesEmpty')}</p>
          )}
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View */
        <div
          ref={virtualRootRef}
          className="collection-virtual-spacer"
          data-collection-virtual-spacer="gallery"
          style={{ height: `${virtualWindow.totalSize}px` }}
        >
          <div
            className="card-grid collection-virtual-grid"
            style={{
              position: 'absolute',
              inset: '0 0 auto',
              transform: `translateY(${virtualTopSize}px)`,
              gridTemplateColumns: `repeat(${virtualWindow.columns}, minmax(0, 1fr))`,
              gap: `${virtualWindow.gap}px`,
            }}
          >
          {virtualCards.map((item) => {
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
          </div>
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
              <tbody ref={virtualRootRef} data-collection-virtual-spacer="list">
                {virtualTopSize > 0 && (
                  <tr className="collection-virtual-list-spacer" aria-hidden="true">
                    <td colSpan={2} style={{ height: `${virtualTopSize}px` }} />
                  </tr>
                )}
                {virtualCards.map((item) => {
                  const selected = selectedIds.has(item.entry_id);
                  return (
                  <tr className="collection-virtual-list-row" key={item.entry_id} style={selected ? { background: 'rgba(255,71,71,0.12)' } : undefined}>
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
                {virtualBottomSize > 0 && (
                  <tr className="collection-virtual-list-spacer" aria-hidden="true">
                    <td colSpan={2} style={{ height: `${virtualBottomSize}px` }} />
                  </tr>
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
