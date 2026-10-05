/* ── Reporter: Daily News Log ─────────────────────────────
   Read-only view over /api/reporter-news/daily. Groups the canonical news
   log by America/Vancouver day with market/source/symbol/state filters.
   The panel is removed on the fixed desk pages, so everything here no-ops
   when #newsLog is absent. */
(function () {
  'use strict';

  var root = document.getElementById('newsLog');
  if (!root) return;

  var form = document.getElementById('newsLogFilters');
  var dateInput = document.getElementById('newsLogDate');
  var sourceSelect = document.getElementById('newsLogSource');
  var symbolSelect = document.getElementById('newsLogSymbol');
  var countsEl = document.getElementById('newsLogCounts');
  var listEl = document.getElementById('newsLogList');
  var tzEl = document.getElementById('newsLogTz');
  var refreshBtn = document.getElementById('newsLogRefresh');

  var TIME_ZONE = 'America/Vancouver';
  var COUNT_ORDER = ['verified', 'approved', 'queued', 'posted', 'rejected', 'failed'];
  var MARKET_LABELS = { stocks: 'Stocks', crypto: 'Crypto', economics: 'Economics', geopolitics: 'Geopolitics', general: 'General' };
  var requestSeq = 0;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function todayKey() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function formatTime(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
  }

  function safeHref(value) {
    return /^https?:\/\//i.test(String(value || '')) ? String(value) : '';
  }

  function fillSelect(select, values) {
    var current = select.value;
    var html = '<option value="">All</option>';
    values.forEach(function (value) {
      html += '<option value="' + esc(value) + '">' + esc(value) + '</option>';
    });
    select.innerHTML = html;
    // Keep the active filter even when today's facets no longer list it.
    if (current && values.indexOf(current) === -1) {
      select.insertAdjacentHTML('beforeend', '<option value="' + esc(current) + '">' + esc(current) + '</option>');
    }
    select.value = current;
  }

  function renderCounts(data) {
    var html = '<div class="news-log-count news-log-count--total"><strong>' + esc(data.total) + '</strong><span>Logged</span></div>';
    COUNT_ORDER.forEach(function (status) {
      html += '<div class="news-log-count" data-status="' + status + '"><strong>' + esc(data.counts[status] || 0) +
        '</strong><span>' + esc(status.charAt(0).toUpperCase() + status.slice(1)) + '</span></div>';
    });
    countsEl.innerHTML = html;
  }

  function renderFarmbot(record) {
    var fb = record.farmbot || {};
    var bits = [];
    if (fb.queueId) bits.push('Queue ' + esc(fb.queueId) + (fb.status ? ' · ' + esc(fb.status) : ''));
    if (fb.scheduledAt) bits.push('Sched ' + esc(formatTime(fb.scheduledAt)));
    var pub = fb.publication;
    if (pub) {
      var href = safeHref(pub.url);
      var label = 'Receipt ' + esc(pub.receiptId || pub.postId || 'link');
      bits.push(href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + label + '</a>' : label);
    }
    return bits.length ? '<div class="news-log-farmbot">' + bits.join(' · ') + '</div>' : '';
  }

  function renderRecord(record) {
    var href = safeHref(record.url || record.canonicalUrl);
    var headline = href
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(record.headline) + '</a>'
      : esc(record.headline);
    var symbols = (record.symbols || []).map(function (s) { return '<span class="news-log-symbol">' + esc(s) + '</span>'; }).join('');
    var dup = record.intakeCount > 1 ? '<span class="news-log-dup" title="Repeated submissions merged into this record">×' + esc(record.intakeCount) + '</span>' : '';
    return '<article class="news-log-item" data-status="' + esc(record.status) + '">' +
      '<div class="news-log-meta">' +
        '<span class="news-log-status" data-status="' + esc(record.status) + '">' + esc(record.status) + '</span>' +
        '<span>' + esc(MARKET_LABELS[record.market] || record.market || '—') + '</span>' +
        '<span>' + esc(record.source || 'Unknown source') + '</span>' +
        '<span title="Captured">' + esc(formatTime(record.capturedAt)) + '</span>' + dup +
      '</div>' +
      '<div class="news-log-headline">' + headline + '</div>' +
      (record.summary ? '<div class="news-log-summary">' + esc(record.summary) + '</div>' : '') +
      (symbols ? '<div class="news-log-symbols">' + symbols + '</div>' : '') +
      renderFarmbot(record) +
      (record.status === 'failed' && record.error ? '<div class="news-log-error">' + esc(record.error) + '</div>' : '') +
    '</article>';
  }

  function render(data) {
    if (tzEl && data.timeZone) tzEl.textContent = data.timeZone;
    fillSelect(sourceSelect, data.facets && data.facets.sources || []);
    fillSelect(symbolSelect, data.facets && data.facets.symbols || []);
    renderCounts(data);
    if (!data.records.length) {
      listEl.innerHTML = '<div class="news-log-empty">No news logged for ' + esc(data.date) +
        (form.status.value || form.market.value || sourceSelect.value || symbolSelect.value ? ' with these filters.' : ' yet.') + '</div>';
      return;
    }
    listEl.innerHTML = data.records.map(renderRecord).join('');
  }

  function load() {
    var params = new URLSearchParams();
    ['date', 'market', 'source', 'symbol', 'status'].forEach(function (name) {
      var value = form.elements[name] && form.elements[name].value;
      if (value) params.set(name, value);
    });
    var seq = ++requestSeq;
    listEl.innerHTML = '<div class="news-log-loading"><span class="spinner"></span> Loading news log…</div>';
    fetch('/api/reporter-news/daily?' + params.toString(), { headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
          return body;
        });
      })
      .then(function (data) { if (seq === requestSeq) render(data); })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        countsEl.innerHTML = '';
        listEl.innerHTML = '<div class="news-log-error">Could not load the news log: ' + esc(err.message) + '</div>';
      });
  }

  dateInput.value = todayKey();
  form.addEventListener('change', load);
  form.addEventListener('submit', function (e) { e.preventDefault(); load(); });
  refreshBtn.addEventListener('click', load);
  load();
})();
