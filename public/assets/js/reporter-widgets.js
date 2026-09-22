/**
 * Reporter Intelligence widgets.
 *
 * The Reporter Room embeds a number of third-party market panels. Dropping
 * their loader scripts straight into reporter.html would mean every one of
 * them is fetched on page load, even the panels several screens down, and a
 * provider outage would leave empty boxes with no explanation.
 *
 * So the page declares a widget rather than embedding one:
 *
 *   <div class="intel-widget" data-intel-widget="economicCalendar"></div>
 *
 * and this module mounts it when it is about to scroll into view, shows a
 * placeholder while it loads, and replaces it with a link to the source if it
 * never arrives. A widget that fails is contained: the AI Reporter below it
 * keeps working.
 *
 * Collapsing a section is part of the same contract — a collapsed section
 * never intersects the viewport, so its widgets are never fetched at all.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc) return;

  var TRADINGVIEW_BASE = 'https://s3.tradingview.com/external-embedding/';

  /* A widget that has produced no frame by now is treated as failed. The
     embeds normally paint in well under a second; this is the outage case. */
  var LOAD_TIMEOUT_MS = 15000;
  var FRAME_POLL_MS = 400;

  /* Mount just before the panel reaches the viewport, so scrolling down does
     not stutter through a visible empty box. */
  var LAZY_MARGIN = '400px 0px';

  var COLLAPSE_KEY = 'reporterIntelCollapsed:v1';
  var OPENED_KEY = 'reporterIntelOpened:v1:';
  var NARROW_WIDTH = 760;

  /* Shared look for every TradingView panel — dark, transparent so the page
     background shows through, and sized by its container rather than by the
     widget's own pixel height. */
  var THEME = {
    colorTheme: 'dark',
    isTransparent: true,
    locale: 'en',
    width: '100%',
    height: '100%'
  };

  /**
   * Widget definitions.
   *
   * script  — the TradingView embed loader for this panel
   * source  — where to send the reader when the embed cannot load
   * config  — widget options, merged over THEME
   * narrow  — options merged on top of `config` below NARROW_WIDTH
   */
  var WIDGETS = {
    economicCalendar: {
      script: 'embed-widget-events.js',
      source: 'https://www.tradingview.com/economic-calendar/',
      sourceLabel: 'TradingView economic calendar',
      config: {
        importanceFilter: '-1,0,1',
        countryFilter: 'us,eu,gb,jp,cn'
      }
    },
    topStories: {
      script: 'embed-widget-timeline.js',
      source: 'https://www.tradingview.com/news/',
      sourceLabel: 'TradingView news',
      config: {
        feedMode: 'all_symbols',
        displayMode: 'regular'
      },
      narrow: { displayMode: 'compact' }
    },

    /* Headlines for one asset at a time. The timeline embed takes a single
       symbol, so the panel carries a chip row and remounts on a change
       rather than holding eight live frames. */
    symbolNews: {
      script: 'embed-widget-timeline.js',
      source: 'https://www.tradingview.com/news/',
      sourceLabel: 'TradingView news',
      config: {
        feedMode: 'symbol',
        symbol: 'AMEX:SPY',
        displayMode: 'regular'
      },
      narrow: { displayMode: 'compact' }
    },

    worldMarkets: {
      script: 'embed-widget-market-quotes.js',
      source: 'https://www.tradingview.com/markets/indices/quotes-major/',
      sourceLabel: 'TradingView world indices',
      config: {
        showSymbolLogo: true,
        backgroundColor: 'rgba(0, 0, 0, 0)',
        symbolsGroups: [
          {
            name: 'US',
            symbols: [
              { name: 'FOREXCOM:SPXUSD', displayName: 'S&P 500' },
              { name: 'FOREXCOM:NSXUSD', displayName: 'Nasdaq 100' },
              { name: 'FOREXCOM:DJI', displayName: 'Dow 30' }
            ]
          },
          {
            name: 'Europe',
            symbols: [
              { name: 'INDEX:DEU40', displayName: 'DAX' },
              { name: 'FOREXCOM:UKXGBP', displayName: 'FTSE 100' }
            ]
          },
          {
            name: 'Asia',
            symbols: [
              { name: 'INDEX:NKY', displayName: 'Nikkei 225' },
              { name: 'INDEX:HSI', displayName: 'Hang Seng' }
            ]
          },
          {
            name: 'FX',
            symbols: [
              { name: 'TVC:DXY', displayName: 'Dollar index' },
              { name: 'FX:EURUSD', displayName: 'EUR/USD' },
              { name: 'FX:USDJPY', displayName: 'USD/JPY' }
            ]
          },
          {
            name: 'Commodities',
            symbols: [
              { name: 'TVC:GOLD', displayName: 'Gold' },
              { name: 'TVC:USOIL', displayName: 'Crude oil' }
            ]
          },
          {
            name: 'Crypto',
            symbols: [
              { name: 'BINANCE:BTCUSDT', displayName: 'Bitcoin' },
              { name: 'BINANCE:ETHUSDT', displayName: 'Ethereum' }
            ]
          }
        ]
      }
    },

    globalEquityMap: {
      script: 'embed-widget-stock-heatmap.js',
      source: 'https://www.tradingview.com/heatmap/stock/',
      sourceLabel: 'TradingView stock heatmap',
      config: {
        dataSource: 'AllWorld',
        blockSize: 'market_cap_basic',
        blockColor: 'change',
        grouping: 'country',
        hasTopBar: false,
        isDataSetEnabled: false,
        isZoomEnabled: true,
        hasSymbolTooltip: true,
        isMonoSize: false,
        symbolUrl: ''
      },
      narrow: { isZoomEnabled: false, hasSymbolTooltip: false }
    },

    /* One definition, many instances: the symbol comes from the element's
       data-intel-symbol, so the macro tabs declare a series rather than a
       widget. */
    macroChart: {
      script: 'embed-widget-mini-symbol-overview.js',
      source: 'https://fred.stlouisfed.org/',
      sourceLabel: 'St. Louis Fed (FRED)',
      config: {
        symbol: 'FRED:FEDFUNDS',
        dateRange: '60M',
        chartOnly: false,
        noTimeScale: false,
        autosize: false,
        largeChartUrl: '',
        trendLineColor: 'rgba(77, 163, 255, 1)',
        underLineColor: 'rgba(77, 163, 255, 0.14)',
        underLineBottomColor: 'rgba(77, 163, 255, 0)'
      },
      narrow: { noTimeScale: true }
    },

    /* ── Not mounted by the Reporter ──────────────────────────
       These answer "what should I trade?" rather than "what happened and why
       does it matter?", so the newsroom does not show them — that is the job
       of the Terminal Suite, the screeners and the Market Intel pages. They
       stay defined because the loader is generic: any page can declare one
       with data-intel-widget, or register its own through
       ReporterWidgets.define(). */

    sectorHeatmap: {
      script: 'embed-widget-stock-heatmap.js',
      source: 'https://www.tradingview.com/heatmap/stock/',
      sourceLabel: 'TradingView stock heatmap',
      config: {
        dataSource: 'SPX500',
        blockSize: 'market_cap_basic',
        blockColor: 'change',
        grouping: 'sector',
        hasTopBar: false,
        isDataSetEnabled: false,
        isZoomEnabled: true,
        hasSymbolTooltip: true,
        isMonoSize: false,
        symbolUrl: ''
      },
      narrow: { isZoomEnabled: false, hasSymbolTooltip: false }
    },

    etfHeatmap: {
      script: 'embed-widget-etf-heatmap.js',
      source: 'https://www.tradingview.com/heatmap/etf/',
      sourceLabel: 'TradingView ETF heatmap',
      config: {
        dataSource: 'AllUSEtf',
        blockSize: 'aum',
        blockColor: 'change',
        grouping: 'asset_class',
        hasTopBar: false,
        isDataSetEnabled: false,
        isZoomEnabled: true,
        hasSymbolTooltip: true,
        isMonoSize: false,
        symbolUrl: ''
      },
      narrow: { isZoomEnabled: false, hasSymbolTooltip: false }
    },

    forexHeatmap: {
      script: 'embed-widget-forex-heatmap.js',
      source: 'https://www.tradingview.com/markets/currencies/forex-heat-map/',
      sourceLabel: 'TradingView forex heatmap',
      config: {
        currencies: ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'],
        backgroundColor: 'rgba(0, 0, 0, 0)'
      },
      narrow: { currencies: ['USD', 'EUR', 'GBP', 'JPY', 'AUD'] }
    },

    ratesMonitor: {
      script: 'embed-widget-market-quotes.js',
      source: 'https://www.tradingview.com/markets/bonds/prices-major/',
      sourceLabel: 'TradingView bond yields',
      config: {
        showSymbolLogo: false,
        backgroundColor: 'rgba(0, 0, 0, 0)',
        symbolsGroups: [
          {
            name: 'US curve',
            symbols: [
              { name: 'TVC:US02Y', displayName: 'US 2Y' },
              { name: 'TVC:US10Y', displayName: 'US 10Y' },
              { name: 'TVC:US30Y', displayName: 'US 30Y' },
              { name: 'FRED:T10Y2Y', displayName: '2s10s spread' },
              { name: 'FRED:FEDFUNDS', displayName: 'Fed funds' }
            ]
          },
          {
            name: 'Global 10Y',
            symbols: [
              { name: 'TVC:DE10Y', displayName: 'Germany 10Y' },
              { name: 'TVC:GB10Y', displayName: 'UK 10Y' },
              { name: 'TVC:JP10Y', displayName: 'Japan 10Y' }
            ]
          }
        ]
      }
    }
  };

  function isNarrow() {
    return (global.innerWidth || doc.documentElement.clientWidth || 0) < NARROW_WIDTH;
  }

  function buildConfig(def, el) {
    var config = {};
    var key;
    for (key in THEME) {
      if (Object.prototype.hasOwnProperty.call(THEME, key)) config[key] = THEME[key];
    }
    for (key in def.config) {
      if (Object.prototype.hasOwnProperty.call(def.config, key)) config[key] = def.config[key];
    }
    if (def.narrow && isNarrow()) {
      for (key in def.narrow) {
        if (Object.prototype.hasOwnProperty.call(def.narrow, key)) config[key] = def.narrow[key];
      }
    }
    // Instance options, so one definition can serve a grid of series.
    if (el && el.dataset.intelSymbol) config.symbol = el.dataset.intelSymbol;
    if (el && el.dataset.intelRange) config.dateRange = el.dataset.intelRange;
    return config;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderPlaceholder(el, label) {
    var state = doc.createElement('div');
    state.className = 'intel-widget-state';
    state.setAttribute('data-intel-placeholder', '');

    var spinner = doc.createElement('span');
    spinner.className = 'spinner';
    state.appendChild(spinner);

    var text = doc.createElement('span');
    text.textContent = label || 'Loading market intelligence…';
    state.appendChild(text);

    el.appendChild(state);
  }

  function renderError(el, def) {
    clear(el);
    el.dataset.intelState = 'error';

    var state = doc.createElement('div');
    state.className = 'intel-widget-state intel-widget-state--error';

    var title = doc.createElement('div');
    title.className = 'intel-widget-state-title';
    title.textContent = 'Market data unavailable';
    state.appendChild(title);

    var note = doc.createElement('p');
    note.className = 'intel-widget-state-note';
    note.textContent = 'This panel is served by a third party and did not load.';
    state.appendChild(note);

    var actions = doc.createElement('div');
    actions.className = 'intel-widget-state-actions';

    var retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'intel-widget-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', function () {
      clear(el);
      delete el.dataset.intelState;
      mount(el);
    });
    actions.appendChild(retry);

    if (def && def.source) {
      var link = doc.createElement('a');
      link.className = 'intel-widget-source';
      link.href = def.source;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open source ↗';
      if (def.sourceLabel) link.title = def.sourceLabel;
      actions.appendChild(link);
    }

    state.appendChild(actions);
    el.appendChild(state);
  }

  function markReady(el) {
    el.dataset.intelState = 'ready';
    var placeholder = el.querySelector('[data-intel-placeholder]');
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
  }

  /* The embeds give no load event of their own — they inject an iframe into
     the container when they are ready. Watching for that frame is the only
     signal available, and its absence is what "unavailable" means here. */
  function watchForFrame(el, def) {
    var startedAt = Date.now();
    function tick() {
      if (!el.isConnected || el.dataset.intelState === 'error') return;
      if (el.querySelector('iframe')) {
        markReady(el);
        return;
      }
      if (Date.now() - startedAt >= LOAD_TIMEOUT_MS) {
        renderError(el, def);
        return;
      }
      global.setTimeout(tick, FRAME_POLL_MS);
    }
    global.setTimeout(tick, FRAME_POLL_MS);
  }

  function mount(el) {
    var state = el.dataset.intelState;
    if (state === 'loading' || state === 'ready' || state === 'error') return;

    var def = WIDGETS[el.dataset.intelWidget];
    if (!def) {
      renderError(el, null);
      return;
    }

    el.dataset.intelState = 'loading';
    renderPlaceholder(el, def.loadingLabel);

    try {
      var container = doc.createElement('div');
      container.className = 'tradingview-widget-container';

      var slot = doc.createElement('div');
      slot.className = 'tradingview-widget-container__widget';
      container.appendChild(slot);

      var script = doc.createElement('script');
      script.type = 'text/javascript';
      script.async = true;
      script.src = TRADINGVIEW_BASE + def.script;
      // The embed loaders read their options from their own script body.
      script.text = JSON.stringify(buildConfig(def, el));
      script.addEventListener('error', function () { renderError(el, def); });
      container.appendChild(script);

      el.appendChild(container);
      watchForFrame(el, def);
    } catch (error) {
      renderError(el, def);
    }
  }

  /** Rebuild a mounted panel, e.g. after its symbol changed. */
  function remount(el) {
    clear(el);
    delete el.dataset.intelState;
    mount(el);
  }

  /* ── Symbol switchers ──────────────────────────────────── */
  /* A chip row that repoints one panel at a different asset. One live frame,
     not one per asset: the embed takes a single symbol, and eight retained
     iframes to read eight headlines is not a trade worth making. */

  function initSymbolSwitchers(root) {
    var panels = (root || doc).querySelectorAll('[data-intel-symbol-switch]');

    Array.prototype.forEach.call(panels, function (panel) {
      var target = panel.querySelector('.intel-widget[data-intel-widget]');
      var options = panel.querySelectorAll('[data-intel-symbol-option]');
      if (!target || !options.length) return;

      function select(symbol, mountNow) {
        Array.prototype.forEach.call(options, function (option) {
          var active = option.getAttribute('data-intel-symbol-option') === symbol;
          option.classList.toggle('active', active);
          option.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        target.dataset.intelSymbol = symbol;
        if (mountNow) remount(target);
      }

      select(target.dataset.intelSymbol || options[0].getAttribute('data-intel-symbol-option'), false);

      panel.addEventListener('click', function (event) {
        var option = event.target.closest('[data-intel-symbol-option]');
        if (!option || !panel.contains(option)) return;
        var symbol = option.getAttribute('data-intel-symbol-option');
        if (symbol === target.dataset.intelSymbol && target.dataset.intelState) return;
        // Only remount a panel that is already showing something; one that
        // has not been reached yet is left for the observer.
        select(symbol, Boolean(target.dataset.intelState));
      });
    });
  }

  var observer = null;

  function observe(el) {
    if (el.dataset.intelObserved === 'true') return;
    el.dataset.intelObserved = 'true';
    if (observer) observer.observe(el);
    else mount(el);
  }

  /** Pick up widgets added or revealed after the initial pass. */
  function scan(root) {
    var scope = root || doc;
    var pending = scope.querySelectorAll('.intel-widget[data-intel-widget]');
    Array.prototype.forEach.call(pending, observe);
  }

  /* ── Collapsible sections ──────────────────────────────── */

  function readCollapsed() {
    try {
      var parsed = JSON.parse(global.localStorage.getItem(COLLAPSE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writeCollapsed(ids) {
    try {
      global.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(ids));
    } catch (error) {
      /* Private browsing and blocked storage — collapsing still works for
         this page view, it just is not remembered. */
    }
  }

  /* A section that defaults to closed should stay open once the reader has
     opened it, which the collapsed list alone cannot express. */
  function hasBeenOpened(id) {
    try {
      return global.localStorage.getItem(OPENED_KEY + id) === '1';
    } catch (error) {
      return false;
    }
  }

  function rememberOpened(id) {
    try {
      global.localStorage.setItem(OPENED_KEY + id, '1');
    } catch (error) {
      /* Storage unavailable — it just reverts to closed next visit. */
    }
  }

  function applyCollapsed(section, header, body, collapsed) {
    section.classList.toggle('collapsed', collapsed);
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    body.hidden = collapsed;
  }

  function initSections(root) {
    var stored = readCollapsed();
    var sections = (root || doc).querySelectorAll('[data-intel-section]');

    Array.prototype.forEach.call(sections, function (section) {
      var header = section.querySelector('.intel-section-header');
      var body = section.querySelector('.intel-section-body');
      if (!header || !body) return;

      var id = section.getAttribute('data-intel-section');
      if (!body.id) body.id = 'intel-body-' + id;
      header.setAttribute('aria-controls', body.id);

      // Sections start open unless they declare otherwise, so only sections
      // the reader closed themselves stay closed. A section marked
      // data-intel-collapsed is optional background: it starts closed, and
      // therefore fetches nothing until it is opened.
      var remembered = stored.indexOf(id);
      var collapsed = remembered !== -1
        ? true
        : section.getAttribute('data-intel-collapsed') === 'true' && !hasBeenOpened(id);
      applyCollapsed(section, header, body, collapsed);

      header.addEventListener('click', function () {
        var collapsed = !section.classList.contains('collapsed');
        applyCollapsed(section, header, body, collapsed);

        var ids = readCollapsed();
        var index = ids.indexOf(id);
        if (collapsed && index === -1) ids.push(id);
        if (!collapsed && index !== -1) ids.splice(index, 1);
        writeCollapsed(ids);
        if (!collapsed) rememberOpened(id);

        // Widgets in a section that was closed on load have never been
        // fetched; opening it is the first chance they get.
        if (!collapsed) scan(body);
      });
    });
  }

  /* ── Tab groups ────────────────────────────────────────── */
  /* Only the visible panel's widgets are ever mounted, so a four-tab macro
     section costs one panel, not four. */

  function tabKey(group) {
    return 'reporterIntelTab:' + (group.getAttribute('data-intel-tabs') || 'group');
  }

  function readTab(group) {
    try {
      return global.localStorage.getItem(tabKey(group));
    } catch (error) {
      return null;
    }
  }

  function writeTab(group, name) {
    try {
      global.localStorage.setItem(tabKey(group), name);
    } catch (error) {
      /* Storage unavailable — the tab still switches, it just is not kept. */
    }
  }

  function selectTab(group, name) {
    var buttons = group.querySelectorAll('[data-intel-tab]');
    var panels = group.querySelectorAll('[data-intel-tab-panel]');
    var shown = null;

    Array.prototype.forEach.call(buttons, function (button) {
      var active = button.getAttribute('data-intel-tab') === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });

    Array.prototype.forEach.call(panels, function (panel) {
      var active = panel.getAttribute('data-intel-tab-panel') === name;
      panel.hidden = !active;
      if (active) shown = panel;
    });

    if (shown) scan(shown);
  }

  function initTabs(root) {
    var groups = (root || doc).querySelectorAll('[data-intel-tabs]');

    Array.prototype.forEach.call(groups, function (group) {
      var buttons = group.querySelectorAll('[data-intel-tab]');
      if (!buttons.length) return;

      var stored = readTab(group);
      var names = Array.prototype.map.call(buttons, function (button) {
        return button.getAttribute('data-intel-tab');
      });
      var initial = names.indexOf(stored) !== -1 ? stored : names[0];

      group.addEventListener('click', function (event) {
        var button = event.target.closest('[data-intel-tab]');
        if (!button || !group.contains(button)) return;
        var name = button.getAttribute('data-intel-tab');
        writeTab(group, name);
        selectTab(group, name);
      });

      selectTab(group, initial);
    });
  }

  /**
   * Open whatever contains `id` so a deep link lands on something visible.
   *
   * The links that used to point into the Overview page now point here, and a
   * target inside a collapsed section would otherwise scroll to nothing.
   * Returns the element so the caller can scroll to it.
   */
  function reveal(id) {
    var target = doc.getElementById(id);
    if (!target) return null;

    var section = target.closest ? target.closest('[data-intel-section]') : null;
    if (section && section.classList.contains('collapsed')) {
      var header = section.querySelector('.intel-section-header');
      var body = section.querySelector('.intel-section-body');
      if (header && body) {
        applyCollapsed(section, header, body, false);
        var sectionId = section.getAttribute('data-intel-section');
        var ids = readCollapsed();
        var index = ids.indexOf(sectionId);
        if (index !== -1) ids.splice(index, 1);
        writeCollapsed(ids);
        rememberOpened(sectionId);
        scan(body);
      }
    }
    return target;
  }

  function init(options) {
    var settings = options || {};
    var root = settings.root || doc;

    if (global.IntersectionObserver && !observer) {
      observer = new global.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          mount(entry.target);
        });
      }, { rootMargin: LAZY_MARGIN });
    }

    initSections(root);
    initTabs(root);
    initSymbolSwitchers(root);
    scan(root);
  }

  global.ReporterWidgets = {
    init: init,
    scan: scan,
    mount: mount,
    remount: remount,
    reveal: reveal,
    /** Register extra panels without editing this file. */
    define: function (name, definition) { WIDGETS[name] = definition; },
    widgets: WIDGETS
  };
})(typeof window !== 'undefined' ? window : this);
