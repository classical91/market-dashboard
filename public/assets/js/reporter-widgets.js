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

    worldMarkets: {
      script: 'embed-widget-market-quotes.js',
      source: 'https://www.tradingview.com/markets/indices/quotes-major/',
      sourceLabel: 'TradingView world indices',
      config: {
        showSymbolLogo: true,
        backgroundColor: 'rgba(0, 0, 0, 0)',
        symbolsGroups: [
          {
            name: 'Americas',
            symbols: [
              { name: 'FOREXCOM:SPXUSD', displayName: 'S&P 500' },
              { name: 'FOREXCOM:NSXUSD', displayName: 'Nasdaq 100' },
              { name: 'FOREXCOM:DJI', displayName: 'Dow 30' },
              { name: 'FOREXCOM:RUTUSD', displayName: 'Russell 2000' }
            ]
          },
          {
            name: 'Europe',
            symbols: [
              { name: 'INDEX:DEU40', displayName: 'DAX' },
              { name: 'FOREXCOM:UKXGBP', displayName: 'FTSE 100' },
              { name: 'INDEX:CAC40', displayName: 'CAC 40' },
              { name: 'INDEX:SMI', displayName: 'SMI' }
            ]
          },
          {
            name: 'Asia-Pacific',
            symbols: [
              { name: 'INDEX:NKY', displayName: 'Nikkei 225' },
              { name: 'INDEX:HSI', displayName: 'Hang Seng' },
              { name: 'NSE:NIFTY', displayName: 'Nifty 50' },
              { name: 'ASX:XJO', displayName: 'ASX 200' }
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

  function buildConfig(def) {
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
      script.text = JSON.stringify(buildConfig(def));
      script.addEventListener('error', function () { renderError(el, def); });
      container.appendChild(script);

      el.appendChild(container);
      watchForFrame(el, def);
    } catch (error) {
      renderError(el, def);
    }
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

      // Sections start open: the point of the page is to read the market at a
      // glance, so only sections the reader closed themselves stay closed.
      applyCollapsed(section, header, body, stored.indexOf(id) !== -1);

      header.addEventListener('click', function () {
        var collapsed = !section.classList.contains('collapsed');
        applyCollapsed(section, header, body, collapsed);

        var ids = readCollapsed();
        var index = ids.indexOf(id);
        if (collapsed && index === -1) ids.push(id);
        if (!collapsed && index !== -1) ids.splice(index, 1);
        writeCollapsed(ids);

        // Widgets in a section that was closed on load have never been
        // fetched; opening it is the first chance they get.
        if (!collapsed) scan(body);
      });
    });
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
    scan(root);
  }

  global.ReporterWidgets = {
    init: init,
    scan: scan,
    mount: mount,
    /** Register extra panels without editing this file. */
    define: function (name, definition) { WIDGETS[name] = definition; },
    widgets: WIDGETS
  };
})(typeof window !== 'undefined' ? window : this);
