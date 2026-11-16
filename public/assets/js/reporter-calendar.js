(function (global) {
  'use strict';

  function dayKey(at, timezone) {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    return ['year', 'month', 'day'].map(function (key) { return parts.find(function (p) { return p.type === key; }).value; }).join('-');
  }
  function addDays(date, n) { return new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function dateRange(selection, now, zone) {
    var today = dayKey(now, zone);
    var weekday = new Date(today + 'T12:00:00Z').getUTCDay();
    var monday = addDays(today, -((weekday + 6) % 7));
    if (selection === 'tomorrow') return [addDays(today, 1), addDays(today, 1)];
    if (selection === 'week') return [monday, addDays(monday, 6)];
    if (selection === 'nextweek') return [addDays(monday, 7), addDays(monday, 13)];
    return [today, addDays(today, selection === '14d' ? 13 : selection === '7d' ? 6 : 0)];
  }
  function countdown(event, now, quality) {
    if (quality !== 'live' || event.precision !== 'exact' || event.verified !== true || !event.at || event.actual != null || ['Released', 'Tentative', 'Delayed'].includes(event.status)) return '';
    var mins = Math.ceil((Date.parse(event.at) - now.getTime()) / 60000);
    if (!Number.isFinite(mins) || mins <= 0) return '';
    return mins < 60 ? 'In ' + mins + ' min' : mins < 1440 ? 'In ' + Math.floor(mins / 60) + 'h ' + mins % 60 + 'm' : 'In ' + Math.floor(mins / 1440) + 'd';
  }
  function qualityOf(data, now) {
    if (!data || !['live', 'stale'].includes(data.quality)) return 'unavailable';
    if (!Number.isFinite(Date.parse(data.staleUntil)) || Date.parse(data.staleUntil) <= +now) return 'unavailable';
    if (data.quality === 'live' && (!Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= +now)) return 'stale';
    return data.quality;
  }
  var api = { dateRange: dateRange, dayKey: dayKey, countdown: countdown, qualityOf: qualityOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  var doc = global.document;
  if (!doc) return;

  var data = null, asking = 0, initialized = false;
  var localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var body, status, source, range, country, impact, timezone;
  function node(tag, cls, text) {
    var element = doc.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  }
  function zone() { return timezone.value === 'local' ? localZone : timezone.value; }
  function render() {
    var now = new Date(), selectedZone = zone(), quality = qualityOf(data, now);
    body.replaceChildren();
    status.dataset.quality = quality;
    status.textContent = quality === 'live' ? 'Live · ' + selectedZone : quality === 'stale' ? 'Stale data · ' + selectedZone : 'Live calendar unavailable';
    source.textContent = data ? (data.source || 'Calendar feed') + (data.fetchedAt ? ' · Last successful update ' + new Date(data.fetchedAt).toLocaleString([], { timeZone: selectedZone }) + ' · ' + selectedZone : '') : '';
    if (quality === 'unavailable') {
      body.appendChild(node('div', 'intel-empty', 'Live calendar unavailable. Scheduled releases could not be verified.'));
      return;
    }
    if (quality === 'stale') body.appendChild(node('div', 'macro-stale-warning', 'Stale calendar — showing the last successful update. Recheck releases before trading.'));
    var bounds = dateRange(range.value, now, selectedZone);
    var items = (data.events || []).filter(function (event) {
      var date = event.at ? dayKey(new Date(event.at), selectedZone) : event.date;
      return date && date >= bounds[0] && date <= bounds[1] && (!country.value || event.country === country.value) && (!impact.value || event.impact === impact.value);
    });
    if (!items.length) body.appendChild(node('div', 'intel-empty', 'No scheduled events in the selected dates and filters. Provider coverage may be limited; check the source calendar for dates beyond its published schedule.'));
    items.forEach(function (event) {
      var row = node('article', 'macro-release');
      var head = node('div', 'macro-release-head');
      var at = event.at ? new Date(event.at) : null;
      var stamp = (at ? dayKey(at, selectedZone) : event.date) + ' · ' + (at ? at.toLocaleTimeString([], { timeZone: selectedZone, hour: '2-digit', minute: '2-digit' }) : 'Time unconfirmed');
      var precision = event.precision === 'exact' && event.verified ? '' : ' · ' + (event.precision === 'assumed' ? 'Time assumed' : 'Time unconfirmed');
      head.appendChild(node('span', 'macro-release-time', stamp + precision));
      head.appendChild(node('span', 'intel-catalyst-impact ' + ({ High: 'high', Medium: 'medium', Low: 'low' }[event.impact] || 'low'), event.impact || 'Low'));
      row.appendChild(head);
      row.appendChild(node('strong', 'macro-release-title', event.title));
      var release = event.status || 'Tentative';
      if (at && +at <= +now && release === 'Upcoming') release = 'Delayed';
      row.appendChild(node('div', 'macro-release-meta', (event.country || 'Global') + ' · ' + release + (countdown(event, now, quality) ? ' · ' + countdown(event, now, quality) : '')));
      var values = node('dl', 'macro-values');
      ['forecast', 'previous', 'actual'].forEach(function (key) {
        var value = node('div');
        value.appendChild(node('dt', null, key.charAt(0).toUpperCase() + key.slice(1)));
        value.appendChild(node('dd', null, event[key] == null ? '—' : event[key]));
        values.appendChild(value);
      });
      row.appendChild(values);
      body.appendChild(row);
    });
  }
  async function refresh() {
    var ask = ++asking;
    try {
      var response = await global.fetch('/api/macro/calendar?range=all&timezone=' + encodeURIComponent(zone()), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Calendar unavailable');
      var payload = await response.json();
      if (ask !== asking) return;
      data = payload;
      var selected = country.value;
      country.replaceChildren(node('option', null, 'All countries'));
      country.firstChild.value = '';
      Array.from(new Set((payload.events || []).map(function (e) { return e.country; }).filter(Boolean))).sort().forEach(function (name) {
        var option = node('option', null, name); option.value = name; country.appendChild(option);
      });
      country.value = Array.from(country.options).some(function (o) { return o.value === selected; }) ? selected : '';
    } catch (_) {
      if (ask !== asking) return;
      // A retained snapshot is labelled stale immediately, with its original
      // expiry. Failed reads never renew its date or its age.
      if (data && data.fetchedAt && data.staleUntil) data = Object.assign({}, data, { quality: 'stale' });
      else data = null;
    }
    render();
  }
  function init() {
    if (initialized || !doc.getElementById('macroCalendarRange')) return;
    initialized = true;
    body = doc.getElementById('catalystList'); status = doc.getElementById('macroCalendarStatus'); source = doc.getElementById('macroCalendarSource');
    range = doc.getElementById('macroCalendarRange'); country = doc.getElementById('macroCalendarCountry'); impact = doc.getElementById('macroCalendarImpact'); timezone = doc.getElementById('macroCalendarTimezone');
    timezone.options[0].textContent = 'Local · ' + localZone;
    [range, country, impact].forEach(function (element) { element.addEventListener('change', render); });
    timezone.addEventListener('change', refresh);
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) refresh(); });
    refresh();
    global.setInterval(function () { if (!doc.hidden) refresh(); }, 90000);
    global.setInterval(function () { if (!doc.hidden) render(); }, 30000);
  }
  global.ReporterCalendar = Object.assign(api, { init: init, refresh: refresh });
})(typeof window !== 'undefined' ? window : globalThis);
