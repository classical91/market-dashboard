/**
 * Reporter Intelligence — market context strip and cross-asset monitor.
 *
 * Both read the dashboard's own /api/overview payload, the same one the Main
 * Hub renders, so the Reporter Room adds no market API calls of its own and
 * cannot disagree with the hub about a price. Session state is clock
 * arithmetic from trading-sessions.js, not a request.
 *
 * Rows the configured macro feed does not carry (US 10Y yields, for one) are
 * shown as unconfigured rather than guessed at — the same way the decision
 * engine treats them.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc) return;

  /* The Main Hub polls the same endpoint at this cadence; matching it means
     the shared server-side cache usually answers both. */
  var REFRESH_MS = 90000;

  /* Which /api/overview row feeds each slot. The first symbol present wins,
     so a macro feed carrying TNX instead of US10Y still lights the yield up. */
  var STRIP_ROWS = [
    { symbols: ['BTC'], label: 'BTC', format: 'price' },
    { symbols: ['SPY'], label: 'SPY', format: 'price' },
    { symbols: ['DXY'], label: 'DXY', format: 'level' },
    { symbols: ['VIX'], label: 'VIX', format: 'level' },
    { symbols: ['US10Y', 'TNX'], label: 'US10Y', format: 'yield' },
    { symbols: ['XAU', 'GOLD'], label: 'GOLD', format: 'price' }
  ];

  var CROSS_ASSET_ROWS = [
    { symbols: ['BTC'], label: 'BTC', name: 'Bitcoin', format: 'price' },
    { symbols: ['ETH'], label: 'ETH', name: 'Ethereum', format: 'price' },
    { symbols: ['SPY'], label: 'SPY', name: 'S&P 500 ETF', format: 'price' },
    { symbols: ['QQQ'], label: 'QQQ', name: 'Nasdaq 100 ETF', format: 'price' },
    { symbols: ['DXY'], label: 'DXY', name: 'Dollar Index', format: 'level' },
    { symbols: ['US10Y', 'TNX'], label: 'US10Y', name: 'US 10Y Yield', format: 'yield' },
    { symbols: ['XAU', 'GOLD'], label: 'GOLD', name: 'Gold', format: 'price' },
    { symbols: ['WTI', 'OIL'], label: 'OIL', name: 'Crude Oil', format: 'price' },
    { symbols: ['VIX'], label: 'VIX', name: 'Volatility Index', format: 'level' }
  ];

  /* A move of this size fills the magnitude bar. Enough to separate a quiet
     session from a violent one without pinning every crypto move to 100%. */
  var FULL_SCALE_PERCENT = 5;

  var state = { rows: {}, marketStatus: null, quality: null, updatedAt: null };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findRow(symbols) {
    for (var i = 0; i < symbols.length; i += 1) {
      var row = state.rows[symbols[i]];
      if (row) return row;
    }
    return null;
  }

  function formatValue(row, format) {
    var price = Number(row && row.price);
    if (!Number.isFinite(price) || price === 0) return '—';
    if (format === 'yield') return price.toFixed(2) + '%';
    if (format === 'level') return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (price >= 1000) return '$' + price.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return '$' + price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function changeClass(value) {
    if (!Number.isFinite(value) || value === 0) return 'flat';
    return value > 0 ? 'up' : 'down';
  }

  function formatChange(value) {
    if (!Number.isFinite(value)) return '—';
    return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  }

  function arrow(value) {
    if (!Number.isFinite(value) || value === 0) return '▪';
    return value > 0 ? '▲' : '▼';
  }

  /* ── Market status strip ───────────────────────────────── */

  function regime() {
    var label = state.marketStatus && state.marketStatus.label;
    if (label === 'Risk-On') return { text: 'RISK-ON', tone: 'up' };
    if (label === 'Risk-Off') return { text: 'RISK-OFF', tone: 'down' };
    if (label === 'Neutral') return { text: 'NEUTRAL', tone: 'flat' };
    return { text: '—', tone: 'flat' };
  }

  function sessionLabel() {
    if (!global.MarketSessions || !global.MarketSessions.describeSession) return null;
    try {
      return global.MarketSessions.describeSession();
    } catch (error) {
      return null;
    }
  }

  function renderStrip() {
    var el = doc.getElementById('intelStatusStrip');
    if (!el) return;

    var pills = STRIP_ROWS.map(function (spec) {
      var row = findRow(spec.symbols);
      if (!row) {
        return '<span class="intel-pill intel-pill--muted" title="Not carried by the configured macro feed">' +
          '<span class="intel-pill-label">' + esc(spec.label) + '</span>' +
          '<span class="intel-pill-value">n/a</span></span>';
      }
      var change = Number(row.changePercent);
      var proxy = row.proxy ? ' <span class="intel-pill-proxy" title="Tracked through a proxy instrument">proxy</span>' : '';
      return '<span class="intel-pill">' +
        '<span class="intel-pill-label">' + esc(spec.label) + '</span>' +
        '<span class="intel-pill-value">' + esc(formatValue(row, spec.format)) + '</span>' +
        '<span class="intel-pill-change ' + changeClass(change) + '">' + esc(formatChange(change)) + '</span>' +
        proxy + '</span>';
    }).join('');

    var mood = regime();
    var session = sessionLabel();

    var meta = '<span class="intel-pill intel-pill--regime ' + mood.tone + '"' +
      (state.marketStatus && state.marketStatus.summary ? ' title="' + esc(state.marketStatus.summary) + '"' : '') + '>' +
      '<span class="intel-pill-label">Market</span>' +
      '<span class="intel-pill-value">' + esc(mood.text) + '</span></span>';

    if (session) {
      meta += '<span class="intel-pill intel-pill--session' + (session.open ? ' open' : '') + '">' +
        '<span class="intel-pill-label">Session</span>' +
        '<span class="intel-pill-value">' + esc(session.label) + '</span></span>';
    }

    el.innerHTML = '<div class="intel-strip-rail">' + pills + '</div>' +
      '<div class="intel-strip-meta">' + meta + '</div>';
  }

  function renderQuality() {
    var el = doc.getElementById('intelDataQuality');
    if (!el) return;
    var quality = state.quality;
    if (!quality) {
      el.textContent = '';
      el.className = 'intel-quality';
      return;
    }
    var tone = quality.live ? (quality.partial ? 'partial' : 'live') : 'fallback';
    var text = quality.live
      ? (quality.partial ? 'Live · some feeds delayed' : 'Live')
      : 'Fallback data';
    var when = state.updatedAt
      ? ' · ' + state.updatedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';
    el.className = 'intel-quality intel-quality--' + tone;
    el.textContent = '● ' + text + when;
    if (quality.warnings && quality.warnings.length) el.title = quality.warnings.join('\n');
  }

  /* ── Cross-asset monitor ───────────────────────────────── */

  function renderCrossAsset() {
    var el = doc.getElementById('crossAssetGrid');
    if (!el) return;

    el.innerHTML = CROSS_ASSET_ROWS.map(function (spec) {
      var row = findRow(spec.symbols);
      if (!row) {
        return '<article class="intel-asset intel-asset--empty">' +
          '<div class="intel-asset-symbol">' + esc(spec.label) + '</div>' +
          '<div class="intel-asset-name">' + esc(spec.name) + '</div>' +
          '<div class="intel-asset-value">Not configured</div>' +
          '<div class="intel-asset-hint">Add ' + esc(spec.label) +
          ' to MACRO_SYMBOLS or MACRO_DATA_URL</div></article>';
      }

      var change = Number(row.changePercent);
      var tone = changeClass(change);
      var magnitude = Number.isFinite(change)
        ? Math.min(Math.abs(change) / FULL_SCALE_PERCENT, 1) * 100
        : 0;

      return '<article class="intel-asset ' + tone + '">' +
        '<div class="intel-asset-symbol">' + esc(spec.label) +
        (row.proxy ? '<span class="intel-asset-proxy" title="Tracked through a proxy instrument">proxy</span>' : '') +
        '</div>' +
        '<div class="intel-asset-name">' + esc(spec.name) + '</div>' +
        '<div class="intel-asset-value">' + esc(formatValue(row, spec.format)) + '</div>' +
        '<div class="intel-asset-change ' + tone + '">' + arrow(change) + ' ' + esc(formatChange(change)) + '</div>' +
        '<div class="intel-asset-bar" aria-hidden="true">' +
        '<span class="intel-asset-bar-fill" style="width:' + magnitude.toFixed(1) + '%"></span></div>' +
        '</article>';
    }).join('');
  }

  function renderUnavailable(message) {
    var strip = doc.getElementById('intelStatusStrip');
    if (strip && !strip.dataset.loaded) {
      strip.innerHTML = '<div class="intel-strip-empty">Market context unavailable — ' + esc(message) + '</div>';
    }
    var grid = doc.getElementById('crossAssetGrid');
    if (grid && !grid.dataset.loaded) {
      grid.innerHTML = '<div class="intel-empty">Cross-asset prices unavailable — ' + esc(message) + '</div>';
    }
    renderQuality();
  }

  function indexRows(payload) {
    var rows = {};
    (payload.watchlist || payload.ticker || []).forEach(function (row) {
      if (row && row.symbol && !rows[row.symbol]) rows[row.symbol] = row;
    });
    return rows;
  }

  function load() {
    return fetch('/api/overview?range=1D', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        state.rows = indexRows(payload);
        state.marketStatus = payload.marketStatus || null;
        state.quality = payload.dataQuality || null;
        state.updatedAt = payload.updatedAt ? new Date(payload.updatedAt) : new Date();

        var strip = doc.getElementById('intelStatusStrip');
        var grid = doc.getElementById('crossAssetGrid');
        if (strip) strip.dataset.loaded = 'true';
        if (grid) grid.dataset.loaded = 'true';

        renderStrip();
        renderCrossAsset();
        renderQuality();
      })
      .catch(function (error) {
        renderUnavailable(error.message || 'request failed');
      });
  }

  function init() {
    if (!doc.getElementById('intelStatusStrip') && !doc.getElementById('crossAssetGrid')) return;
    load();
    global.setInterval(function () {
      // Nothing to repaint for a tab nobody is looking at.
      if (doc.hidden) return;
      load();
    }, REFRESH_MS);
    // The session chip moves on the clock, not on the price feed.
    global.setInterval(renderStrip, 60000);
  }

  global.ReporterMarket = { init: init, refresh: load };
})(typeof window !== 'undefined' ? window : this);
