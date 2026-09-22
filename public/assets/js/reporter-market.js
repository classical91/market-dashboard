/**
 * News Intelligence — market reaction and scheduled catalysts.
 *
 * A headline means more with a number next to it, so the newsroom carries a
 * compact reaction strip: how the major assets moved today, and which events
 * were already on the schedule. It is deliberately not a charting surface —
 * "what should I trade?" is the Terminal Suite's and the screeners' job.
 *
 * Both read the dashboard's own /api/overview payload, the same one the Main
 * Hub renders, in one request — so the Reporter adds no market API call of
 * its own and cannot disagree with the hub about a price. Session state is
 * clock arithmetic from trading-sessions.js, not a request.
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
  var REACTION_ROWS = [
    { symbols: ['BTC'], label: 'BTC', format: 'price' },
    { symbols: ['ETH'], label: 'ETH', format: 'price' },
    { symbols: ['SPY'], label: 'SPY', format: 'price' },
    { symbols: ['QQQ'], label: 'QQQ', format: 'price' },
    { symbols: ['DXY'], label: 'DXY', format: 'level' },
    { symbols: ['XAU', 'GOLD'], label: 'GOLD', format: 'price' },
    { symbols: ['WTI', 'OIL'], label: 'OIL', format: 'price' },
    { symbols: ['VIX'], label: 'VIX', format: 'level' },
    { symbols: ['US10Y', 'TNX'], label: 'US10Y', format: 'yield' }
  ];

  var MAX_CATALYSTS = 8;

  var state = { rows: {}, marketStatus: null, quality: null, calendar: [], updatedAt: null };

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

  /* ── Market reaction ───────────────────────────────────── */

  function renderReaction() {
    var el = doc.getElementById('marketReaction');
    if (!el) return;

    var cells = REACTION_ROWS.map(function (spec) {
      var row = findRow(spec.symbols);
      if (!row) {
        return '<div class="intel-react intel-react--empty" ' +
          'title="Not carried by the configured macro feed — add it to MACRO_SYMBOLS or MACRO_DATA_URL">' +
          '<span class="intel-react-label">' + esc(spec.label) + '</span>' +
          '<span class="intel-react-value">n/a</span>' +
          '<span class="intel-react-change flat">not configured</span></div>';
      }
      var change = Number(row.changePercent);
      var tone = changeClass(change);
      return '<div class="intel-react ' + tone + '">' +
        '<span class="intel-react-label">' + esc(spec.label) +
        (row.proxy ? '<span class="intel-react-proxy" title="Tracked through a proxy instrument">proxy</span>' : '') +
        '</span>' +
        '<span class="intel-react-value">' + esc(formatValue(row, spec.format)) + '</span>' +
        '<span class="intel-react-change ' + tone + '">' + arrow(change) + ' ' + esc(formatChange(change)) + '</span>' +
        '</div>';
    }).join('');

    var mood = regime();
    var session = sessionLabel();
    var meta = '<span class="intel-react-meta-item ' + mood.tone + '"' +
      (state.marketStatus && state.marketStatus.summary ? ' title="' + esc(state.marketStatus.summary) + '"' : '') +
      '>Market <strong>' + esc(mood.text) + '</strong></span>';
    if (session) {
      meta += '<span class="intel-react-meta-item">Session <strong>' + esc(session.label) + '</strong></span>';
    }

    el.innerHTML = '<div class="intel-react-grid">' + cells + '</div>' +
      '<div class="intel-react-meta">' + meta + '</div>';
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

  /* ── Scheduled catalysts ───────────────────────────────── */

  /* The macro calendar the overview payload already carries. Earnings are not
     in it — no embed provider offers an earnings calendar widget and this page
     will not take on a new data dependency for one — so the panel links out
     for those and is titled for what it actually shows. */
  function renderCatalysts() {
    var el = doc.getElementById('catalystList');
    if (!el) return;

    var items = (state.calendar || []).slice(0, MAX_CATALYSTS);
    if (!items.length) {
      el.innerHTML = '<div class="intel-empty">No scheduled events in today\'s calendar.</div>';
      return;
    }

    el.innerHTML = items.map(function (item) {
      var impact = String(item && item.impact || '').toLowerCase();
      var impactClass = impact === 'high' ? 'high' : impact === 'medium' ? 'medium' : 'low';
      // A fallback calendar carries no real clock time; saying "08:30" for an
      // assumed slot would invent precision the feed does not have.
      var exact = item && item.precision === 'exact';
      var time = item && item.time ? esc(item.time) : '—';
      return '<div class="intel-catalyst">' +
        '<span class="intel-catalyst-time' + (exact ? '' : ' approx') + '"' +
        (exact ? '' : ' title="Scheduled slot, not a confirmed release time"') + '>' +
        time + (exact ? '' : '~') + '</span>' +
        '<span class="intel-catalyst-title">' + esc(item && item.title || 'Scheduled event') + '</span>' +
        '<span class="intel-catalyst-impact ' + impactClass + '">' + esc(item && item.impact || '—') + '</span>' +
        '</div>';
    }).join('');
  }

  function renderUnavailable(message) {
    var reaction = doc.getElementById('marketReaction');
    if (reaction && !reaction.dataset.loaded) {
      reaction.innerHTML = '<div class="intel-empty">Market reaction unavailable — ' + esc(message) + '</div>';
    }
    var catalysts = doc.getElementById('catalystList');
    if (catalysts && !catalysts.dataset.loaded) {
      catalysts.innerHTML = '<div class="intel-empty">Calendar unavailable — ' + esc(message) + '</div>';
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
        state.calendar = Array.isArray(payload.calendar) ? payload.calendar : [];
        state.updatedAt = payload.updatedAt ? new Date(payload.updatedAt) : new Date();

        var reaction = doc.getElementById('marketReaction');
        var catalysts = doc.getElementById('catalystList');
        if (reaction) reaction.dataset.loaded = 'true';
        if (catalysts) catalysts.dataset.loaded = 'true';

        renderReaction();
        renderCatalysts();
        renderQuality();
      })
      .catch(function (error) {
        renderUnavailable(error.message || 'request failed');
      });
  }

  function init() {
    if (!doc.getElementById('marketReaction') && !doc.getElementById('catalystList')) return;
    load();
    global.setInterval(function () {
      // Nothing to repaint for a tab nobody is looking at.
      if (doc.hidden) return;
      load();
    }, REFRESH_MS);
    // The session chip moves on the clock, not on the price feed.
    global.setInterval(renderReaction, 60000);
  }

  global.ReporterMarket = { init: init, refresh: load };
})(typeof window !== 'undefined' ? window : this);
