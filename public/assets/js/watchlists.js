/* Watchlists — TradingView-style ticker lists, saved in this browser.

   In the UI a "folder" here is called a watchlist and a "section" a
   subtitle; the code and the saved format keep the original names so
   existing browsers' lists load unchanged.

   Shared by the Overview v2 watchlist card (watchlist-card.js) and the
   Settings editor (watchlist-settings.js). Everything that changes a state
   is pure (takes a state, returns a new one) so the Node tests can exercise
   it without a browser; only read()/write() touch storage.

   A folder can be bookmarked with one of TradingView's flag colours.
   Bookmarked folders always list first, in their own relative order.

   Sections divide a folder's list into labelled groups. Like TradingView's
   own list format they live in `tickers` as "###Name" entries, so they
   reorder and delete exactly like symbols; symbolsOf() skips them. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'mc_watchlists_v1';
  var CHANGE_EVENT = 'watchlists:change';
  var MAX_FOLDERS = 50;
  var MAX_TICKERS = 200;
  var MAX_NAME = 40;

  var COLORS = [
    { id: 'red', label: 'Red', hex: '#f23645' },
    { id: 'blue', label: 'Blue', hex: '#2962ff' },
    { id: 'green', label: 'Green', hex: '#089981' },
    { id: 'orange', label: 'Orange', hex: '#ff9800' },
    { id: 'purple', label: 'Purple', hex: '#9c27b0' },
    { id: 'cyan', label: 'Cyan', hex: '#00bcd4' },
    { id: 'pink', label: 'Pink', hex: '#e91e63' },
  ];
  var COLOR_IDS = COLORS.map(function (c) { return c.id; });

  function colorHex(id) {
    for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return COLORS[i].hex;
    return null;
  }

  /* "binance:btcusdt " -> "BINANCE:BTCUSDT". Letters, digits and the
     punctuation TradingView symbols use (: . _ - ! /); anything else is
     rejected rather than silently stripped. */
  function normalizeSymbol(input) {
    var s = String(input == null ? '' : input).trim().toUpperCase();
    if (!s || s.length > 40) return '';
    if (!/^[A-Z0-9][A-Z0-9:._!\/-]*$/.test(s)) return '';
    if (s.split(':').length > 2 || /:$/.test(s)) return '';
    return s;
  }

  function splitSymbols(text) {
    return String(text == null ? '' : text).split(/[\s,;]+/).filter(Boolean);
  }

  /* ── Sections ("###Name" entries) ── */
  var SECTION_PREFIX = '###';

  function isSection(entry) {
    return typeof entry === 'string' && entry.indexOf(SECTION_PREFIX) === 0;
  }

  function sectionName(entry) {
    return isSection(entry) ? entry.slice(SECTION_PREFIX.length) : '';
  }

  function cleanSectionName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  function hasSection(tickers, name, except) {
    var key = name.toLowerCase();
    return tickers.some(function (t) { return t !== except && isSection(t) && sectionName(t).toLowerCase() === key; });
  }

  function symbolsOf(folder) {
    return folder ? folder.tickers.filter(function (t) { return !isSection(t); }) : [];
  }

  /* Splits a folder into the unsectioned symbols at the top, then each
     section with the symbols under it. */
  function groupsOf(folder) {
    var groups = [{ section: null, name: '', symbols: [] }];
    (folder ? folder.tickers : []).forEach(function (t) {
      if (isSection(t)) groups.push({ section: t, name: sectionName(t), symbols: [] });
      else groups[groups.length - 1].symbols.push(t);
    });
    return groups;
  }

  function tickerParts(symbol) {
    var i = symbol.indexOf(':');
    return i === -1
      ? { exchange: '', ticker: symbol }
      : { exchange: symbol.slice(0, i), ticker: symbol.slice(i + 1) };
  }

  function tradingViewUrl(symbol) {
    return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(symbol);
  }

  /* Stable per-ticker icon tint, like TradingView's coloured logo circles. */
  var ICON_TINTS = ['#f7931a', '#26a17b', '#627eea', '#2962ff', '#e91e63', '#9c27b0', '#00bcd4', '#ff9800', '#089981', '#f23645'];
  function iconTint(symbol) {
    var t = tickerParts(symbol).ticker;
    var h = 0;
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return ICON_TINTS[h % ICON_TINTS.length];
  }

  function cleanName(name, fallback) {
    var s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    return s || fallback || 'Untitled';
  }

  var idCounter = 0;
  function newId() {
    idCounter += 1;
    return 'wl_' + Date.now().toString(36) + '_' + idCounter.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function defaultState() {
    return {
      version: 1,
      activeId: 'wl_default',
      folders: [{
        id: 'wl_default',
        name: 'My watchlist',
        bookmark: null,
        tickers: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT'],
      }],
    };
  }

  function normalizeFolder(raw, seen) {
    if (!raw || typeof raw !== 'object') return null;
    var id = typeof raw.id === 'string' && raw.id && !seen[raw.id] ? raw.id : newId();
    seen[id] = true;
    var tickers = [];
    var have = {};
    (Array.isArray(raw.tickers) ? raw.tickers : []).forEach(function (t) {
      if (tickers.length >= MAX_TICKERS) return;
      if (isSection(t)) {
        var name = cleanSectionName(sectionName(t));
        if (name && !hasSection(tickers, name)) tickers.push(SECTION_PREFIX + name);
        return;
      }
      var s = normalizeSymbol(t);
      if (s && !have[s] && tickers.length < MAX_TICKERS) { have[s] = true; tickers.push(s); }
    });
    return {
      id: id,
      name: cleanName(raw.name),
      bookmark: COLOR_IDS.indexOf(raw.bookmark) === -1 ? null : raw.bookmark,
      tickers: tickers,
    };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.folders)) return defaultState();
    var seen = {};
    var folders = raw.folders.map(function (f) { return normalizeFolder(f, seen); })
      .filter(Boolean).slice(0, MAX_FOLDERS);
    var state = { version: 1, activeId: raw.activeId, folders: folders };
    if (!findFolder(state, state.activeId)) state.activeId = folders.length ? ordered(state)[0].id : null;
    return state;
  }

  function clone(state) {
    return {
      version: 1,
      activeId: state.activeId,
      folders: state.folders.map(function (f) {
        return { id: f.id, name: f.name, bookmark: f.bookmark, tickers: f.tickers.slice() };
      }),
    };
  }

  function findFolder(state, id) {
    for (var i = 0; i < state.folders.length; i++) if (state.folders[i].id === id) return state.folders[i];
    return null;
  }

  /* Bookmarked folders first, otherwise the saved order. */
  function ordered(state) {
    var marked = state.folders.filter(function (f) { return f.bookmark; });
    var plain = state.folders.filter(function (f) { return !f.bookmark; });
    return marked.concat(plain);
  }

  function activeFolder(state) {
    return findFolder(state, state.activeId) || ordered(state)[0] || null;
  }

  /* Every folder a ticker is in, bookmarked first. */
  function foldersFor(state, symbol) {
    return ordered(state).filter(function (f) { return f.tickers.indexOf(symbol) !== -1; });
  }

  function createFolder(state, name) {
    if (state.folders.length >= MAX_FOLDERS) return { state: state, folder: null, error: 'Watchlist limit reached (' + MAX_FOLDERS + ').' };
    var next = clone(state);
    var folder = { id: newId(), name: cleanName(name, 'New watchlist'), bookmark: null, tickers: [] };
    next.folders.push(folder);
    next.activeId = folder.id;
    return { state: next, folder: folder, error: null };
  }

  function renameFolder(state, id, name) {
    var next = clone(state);
    var f = findFolder(next, id);
    if (f) f.name = cleanName(name, f.name);
    return next;
  }

  function deleteFolder(state, id) {
    var next = clone(state);
    next.folders = next.folders.filter(function (f) { return f.id !== id; });
    if (next.activeId === id) next.activeId = next.folders.length ? ordered(next)[0].id : null;
    return next;
  }

  function setBookmark(state, id, color) {
    var next = clone(state);
    var f = findFolder(next, id);
    if (f) f.bookmark = COLOR_IDS.indexOf(color) === -1 ? null : color;
    return next;
  }

  function setActive(state, id) {
    if (!findFolder(state, id)) return state;
    var next = clone(state);
    next.activeId = id;
    return next;
  }

  /* Adds symbols to a folder; reports which were invalid or already there. */
  function addTickers(state, id, input) {
    var next = clone(state);
    var f = findFolder(next, id);
    var result = { state: next, added: [], duplicate: [], invalid: [], full: false };
    if (!f) return result;
    (Array.isArray(input) ? input : splitSymbols(input)).forEach(function (raw) {
      var s = normalizeSymbol(raw);
      if (!s) { result.invalid.push(String(raw)); return; }
      if (f.tickers.indexOf(s) !== -1) { result.duplicate.push(s); return; }
      if (f.tickers.length >= MAX_TICKERS) { result.full = true; return; }
      f.tickers.push(s);
      result.added.push(s);
    });
    return result;
  }

  function removeTicker(state, id, symbol) {
    var next = clone(state);
    var f = findFolder(next, id);
    if (f) f.tickers = f.tickers.filter(function (t) { return t !== symbol; });
    return next;
  }

  function moveTicker(state, id, symbol, delta) {
    var next = clone(state);
    var f = findFolder(next, id);
    if (!f) return next;
    var from = f.tickers.indexOf(symbol);
    var to = from + delta;
    if (from === -1 || to < 0 || to >= f.tickers.length) return next;
    f.tickers.splice(from, 1);
    f.tickers.splice(to, 0, symbol);
    return next;
  }

  /* Appends a section divider; symbols added afterwards land under it. */
  function addSection(state, id, name) {
    var next = clone(state);
    var f = findFolder(next, id);
    var clean = cleanSectionName(name);
    var result = { state: next, section: null, error: null };
    if (!f) return result;
    if (!clean) result.error = 'Give the subtitle a name.';
    else if (hasSection(f.tickers, clean)) result.error = 'There is already a subtitle called ' + clean + '.';
    else if (f.tickers.length >= MAX_TICKERS) result.error = 'Watchlist is full (' + MAX_TICKERS + ' entries).';
    else { result.section = SECTION_PREFIX + clean; f.tickers.push(result.section); }
    return result;
  }

  function renameSection(state, id, section, name) {
    var next = clone(state);
    var f = findFolder(next, id);
    var clean = cleanSectionName(name);
    var result = { state: next, section: section, error: null };
    var i = f ? f.tickers.indexOf(section) : -1;
    if (i === -1 || !isSection(section)) return result;
    if (!clean) { result.error = 'Subtitles cannot be empty.'; return result; }
    if (hasSection(f.tickers, clean, section)) { result.error = 'There is already a subtitle called ' + clean + '.'; return result; }
    result.section = SECTION_PREFIX + clean;
    f.tickers[i] = result.section;
    return result;
  }

  /* ── Starter watchlists ──
     Ready-made lists added from Settings with one click. Perps use
     TradingView's ".P" suffix; Binance lists low-priced memes as 1000x
     contracts (1000PEPEUSDT.P). Adding one never touches existing lists. */
  var PRESETS = [
    {
      id: 'altcoins',
      name: 'Alt coins',
      bookmark: 'purple',
      tickers: [
        '###Alt season gauges',
        'CRYPTOCAP:TOTAL3', 'CRYPTOCAP:OTHERS.D', 'CRYPTOCAP:OTHERS', 'BINANCE:ETHBTC',
        '###Large caps',
        'BINANCE:SOLUSDT.P', 'BINANCE:XRPUSDT.P', 'BINANCE:BNBUSDT.P', 'BINANCE:DOGEUSDT.P',
        'BINANCE:ADAUSDT.P', 'BINANCE:TRXUSDT.P', 'BINANCE:AVAXUSDT.P', 'BINANCE:LINKUSDT.P',
        'BINANCE:TONUSDT.P', 'BINANCE:DOTUSDT.P', 'BINANCE:LTCUSDT.P', 'BINANCE:BCHUSDT.P',
        '###L1 / L2',
        'BINANCE:SUIUSDT.P', 'BINANCE:APTUSDT.P', 'BINANCE:NEARUSDT.P', 'BINANCE:SEIUSDT.P',
        'BINANCE:INJUSDT.P', 'BINANCE:TIAUSDT.P', 'BINANCE:ARBUSDT.P', 'BINANCE:OPUSDT.P',
        'BINANCE:POLUSDT.P',
        '###DeFi',
        'BINANCE:UNIUSDT.P', 'BINANCE:AAVEUSDT.P', 'BINANCE:LDOUSDT.P', 'BINANCE:PENDLEUSDT.P',
        'BINANCE:ENAUSDT.P', 'BINANCE:JUPUSDT.P',
        '###AI',
        'BINANCE:TAOUSDT.P', 'BINANCE:FETUSDT.P', 'BINANCE:RENDERUSDT.P', 'BINANCE:WLDUSDT.P',
        '###Memes',
        'BINANCE:1000PEPEUSDT.P', 'BINANCE:WIFUSDT.P', 'BINANCE:1000BONKUSDT.P',
        'BINANCE:1000SHIBUSDT.P', 'BINANCE:1000FLOKIUSDT.P',
      ],
    },
    {
      id: 'crypto-dominance',
      name: 'Crypto & dominance',
      bookmark: 'orange',
      tickers: [
        '###Other pairs',
        'BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P', 'BINANCE:XRPUSDT.P',
        '###Dominant charts',
        'CRYPTOCAP:TOTAL', 'CRYPTOCAP:USDT.D', 'CRYPTOCAP:BTC.D', 'CRYPTOCAP:TOTAL2',
        'CRYPTOCAP:TOTAL3', 'CRYPTOCAP:ETH.D', 'CRYPTOCAP:OTHERS.D',
      ],
    },
    {
      id: 'bonds',
      name: 'Bonds',
      bookmark: 'blue',
      tickers: [
        '###US yields',
        'TVC:US03MY', 'TVC:US01Y', 'TVC:US02Y', 'TVC:US05Y', 'TVC:US10Y', 'TVC:US20Y', 'TVC:US30Y',
        '###Global 10Y',
        'TVC:DE10Y', 'TVC:GB10Y', 'TVC:JP10Y', 'TVC:CA10Y',
      ],
    },
  ];

  function findPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  /* Adds a starter watchlist as a new folder and selects it. A watchlist
     with the same name already there is selected instead of duplicated. */
  function addPreset(state, presetId) {
    var preset = findPreset(presetId);
    if (!preset) return { state: state, folder: null, error: 'Unknown starter watchlist.' };
    var key = preset.name.toLowerCase();
    var existing = state.folders.filter(function (f) { return f.name.toLowerCase() === key; })[0];
    if (existing) return { state: setActive(state, existing.id), folder: existing, existed: true, error: null };
    var made = createFolder(state, preset.name);
    if (made.error) return made;
    var next = made.state;
    var f = findFolder(next, made.folder.id);
    f.bookmark = preset.bookmark || null;
    f.tickers = preset.tickers.slice(0, MAX_TICKERS);
    return { state: next, folder: f, existed: false, error: null };
  }

  /* ── Storage (guarded: private browsing, webviews and Node) ── */
  var memory = null;

  function read() {
    var raw = null;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {}
    if (raw == null) return normalize(memory || null);
    try { return normalize(JSON.parse(raw)); } catch (err) { return defaultState(); }
  }

  function write(state) {
    var clean = normalize(state);
    memory = clean;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch (err) {}
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: clean }));
    }
    return clean;
  }

  /* Fires on saves in this tab and in other tabs (the storage event). */
  function subscribe(fn) {
    if (typeof window === 'undefined') return function () {};
    function onLocal() { fn(read()); }
    function onStorage(e) { if (e.key === STORAGE_KEY) fn(read()); }
    window.addEventListener(CHANGE_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return function () {
      window.removeEventListener(CHANGE_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Inline SVG bookmark flag, filled with the folder's colour. */
  function flagSvg(color, size) {
    var hex = colorHex(color) || 'currentColor';
    var s = size || 12;
    return '<svg class="wl-flag" width="' + s + '" height="' + s + '" viewBox="0 0 12 12" aria-hidden="true">' +
      '<path d="M2.5 1.5h7v9L6 8.2 2.5 10.5z" fill="' + (color ? hex : 'none') + '" stroke="' + hex + '" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    CHANGE_EVENT: CHANGE_EVENT,
    MAX_TICKERS: MAX_TICKERS,
    MAX_NAME: MAX_NAME,
    COLORS: COLORS,
    colorHex: colorHex,
    normalizeSymbol: normalizeSymbol,
    splitSymbols: splitSymbols,
    tickerParts: tickerParts,
    isSection: isSection,
    sectionName: sectionName,
    symbolsOf: symbolsOf,
    groupsOf: groupsOf,
    addSection: addSection,
    renameSection: renameSection,
    tradingViewUrl: tradingViewUrl,
    iconTint: iconTint,
    defaultState: defaultState,
    normalize: normalize,
    ordered: ordered,
    findFolder: findFolder,
    activeFolder: activeFolder,
    foldersFor: foldersFor,
    createFolder: createFolder,
    renameFolder: renameFolder,
    deleteFolder: deleteFolder,
    setBookmark: setBookmark,
    setActive: setActive,
    addTickers: addTickers,
    removeTicker: removeTicker,
    moveTicker: moveTicker,
    PRESETS: PRESETS,
    addPreset: addPreset,
    read: read,
    write: write,
    subscribe: subscribe,
    escapeHtml: escapeHtml,
    flagSvg: flagSvg,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Watchlists = api;
})(typeof window !== 'undefined' ? window : null);
