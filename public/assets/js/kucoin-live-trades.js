/* KuCoin Live Trades Terminal (TradeHunter → Live Trades).
 *
 * Reads /api/kucoin-live-trades/stream (Server-Sent Events). The server holds
 * the KuCoin WebSocket; this page never talks to KuCoin and shows nothing it
 * did not receive from it — no placeholder or simulated trades.
 *
 * Rendering is batched: trades arrive in ~250 ms batches and the DOM is
 * updated at most once per animation frame. "Pause display" freezes the
 * tape and the whale list so they can be read; data keeps arriving and the
 * status bar keeps showing whether the source itself is live.
 */
(function (root) {
  "use strict";

  var BUFFER_LIMIT = 5000;
  var LARGE_LIMIT = 500;
  var CHART_MINUTES = 60;
  var WINDOW_MS = { "1m": 60000, "5m": 300000, "15m": 900000 };
  var SERVER_SILENCE_MS = 6000;

  // ── Pure helpers (exported for tests) ──────────────────────────────────

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function decimalsOf(step) {
    if (step == null) return null;
    var text = String(step);
    if (/e-/i.test(text)) return Math.min(8, Number(text.split(/e-/i)[1]) || 0);
    var dot = text.indexOf(".");
    if (dot < 0) return 0;
    return Math.min(8, text.replace(/0+$/, "").length - dot - 1);
  }

  function fmtNumber(value, decimals) {
    if (value == null || !isFinite(value)) return "—";
    return Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function fmtCompact(value, { signed = false } = {}) {
    if (value == null || !isFinite(value)) return "—";
    var abs = Math.abs(value);
    var sign = value < 0 ? "-" : signed && value > 0 ? "+" : "";
    var out;
    if (abs >= 1e9) out = (abs / 1e9).toFixed(2) + "B";
    else if (abs >= 1e6) out = (abs / 1e6).toFixed(2) + "M";
    else if (abs >= 1e3) out = (abs / 1e3).toFixed(1) + "K";
    else out = abs.toFixed(abs >= 100 ? 0 : 2);
    return sign + "$" + out;
  }

  function fmtUsdt(value) {
    return value == null || !isFinite(value) ? "—" : fmtNumber(value, 2);
  }

  function fmtPrice(value, tickSize) {
    if (value == null || !isFinite(value)) return "—";
    var d = decimalsOf(tickSize);
    if (d == null) d = value >= 1000 ? 1 : value >= 1 ? 3 : 6;
    return fmtNumber(value, d);
  }

  function fmtBase(value) {
    if (value == null || !isFinite(value)) return "—";
    var abs = Math.abs(value);
    var d = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
    return fmtNumber(value, d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  function fmtQuantity(trade) {
    if (!trade) return "—";
    if (trade.quantityUnit === "contracts") return fmtNumber(trade.quantity, decimalsOf(trade.quantityText) || 0);
    var text = String(trade.quantityText || trade.quantity);
    var parts = text.split(".");
    return Number(parts[0]).toLocaleString("en-US") + (parts[1] ? "." + parts[1] : "");
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
  }

  function fmtTime(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    var d = new Date(ms);
    return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3);
  }

  function fmtClock(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    var d = new Date(ms);
    return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2);
  }

  function fmtDuration(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return "—";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? m + "m " + pad(s % 60, 2) + "s" : m + "m";
    return Math.floor(m / 60) + "h " + pad(m % 60, 2) + "m";
  }

  /** Trades shown in the tape: newest first, at or above the minimum value, capped. */
  function visibleTrades(trades, { minValue = 0, rows = 200 } = {}) {
    var out = [];
    for (var i = 0; i < trades.length && out.length < rows; i++) {
      var t = trades[i];
      if (minValue > 0 && !(t.notional != null && t.notional >= minValue)) continue;
      out.push(t);
    }
    return out;
  }

  /** Large executions: only trades whose notional was actually computed. */
  function whaleTrades(trades, threshold) {
    return trades.filter(function (t) { return t.notional != null && t.sideVerified && t.notional >= threshold; });
  }

  function csvField(value) {
    var s = value == null ? "" : String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv(trades) {
    var header = ["exchange_time_utc", "exchange_time_ns", "exchange", "market", "symbol", "trade_id", "side_taker", "price", "quantity", "quantity_unit", "base_quantity", "notional_usdt", "received_at_utc"];
    var lines = [header.join(",")];
    trades.forEach(function (t) {
      lines.push([
        new Date(t.exchangeTimeMs).toISOString(),
        t.exchangeTimeNs,
        t.exchange,
        t.marketType,
        t.symbol,
        t.tradeId,
        t.side,
        t.priceText,
        t.quantityText,
        t.quantityUnit,
        t.baseQuantity == null ? "" : t.baseQuantity,
        t.notional == null ? "" : t.notional,
        t.receivedAt ? new Date(t.receivedAt).toISOString() : "",
      ].map(csvField).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  /**
   * CVD points relative to a baseline (session start or a manual reset).
   * minutes: [{ t, cvdQuote, cvdBase }] with end-of-minute cumulative values.
   */
  function cvdSeries(minutes, { baseline, unit = "quote", live = null, now = Date.now() }) {
    var key = unit === "base" ? "cvdBase" : "cvdQuote";
    var base = unit === "base" ? baseline.base : baseline.quote;
    var points = [{ t: baseline.at, v: 0 }];
    minutes.forEach(function (m) {
      var end = m.t + 60000;
      if (end <= baseline.at || end > now) return;
      points.push({ t: end, v: m[key] - base });
    });
    if (live) points.push({ t: now, v: (unit === "base" ? live.base : live.quote) - base });
    return points.sort(function (a, b) { return a.t - b.t; });
  }

  /** A continuous minute axis ending at the current minute; missing minutes are empty. */
  function minuteAxis(minutes, now, count) {
    var byT = {};
    minutes.forEach(function (m) { byT[m.t] = m; });
    var current = Math.floor(now / 60000) * 60000;
    var first = minutes.length ? Math.max(minutes[0].t, current - (count - 1) * 60000) : current;
    var out = [];
    for (var t = first; t <= current; t += 60000) out.push(byT[t] || { t: t, buyNotional: 0, sellNotional: 0, tradeCount: 0, empty: true });
    return out;
  }

  var helpers = {
    escapeHtml: escapeHtml,
    decimalsOf: decimalsOf,
    fmtCompact: fmtCompact,
    fmtPrice: fmtPrice,
    fmtQuantity: fmtQuantity,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    visibleTrades: visibleTrades,
    whaleTrades: whaleTrades,
    buildCsv: buildCsv,
    cvdSeries: cvdSeries,
    minuteAxis: minuteAxis,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  if (typeof document === "undefined") return;
  root.KucoinLiveTrades = helpers;

  // ── Page state ─────────────────────────────────────────────────────────

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    market: "spot",
    asset: "BTC",
    symbols: null,
    es: null,
    gen: 0,
    sse: "connecting",
    sseError: null,
    lastServerEventAt: 0,
    retryTimer: null,
    retryDelay: 3000,
    feed: null,
    instrument: null,
    status: null,
    stats: null,
    session: null,
    trades: [],
    seen: new Set(),
    largeTrades: [],
    minutes: new Map(),
    clockSkew: 0,
    paused: false,
    pausedAt: null,
    newSincePause: 0,
    frozenRows: null,
    frozenWhales: null,
    window: "5m",
    minValue: 0,
    rows: 200,
    whaleThreshold: 10000,
    cvdUnit: "quote",
    cvdBaseline: null,
    dirty: {},
    frame: null,
    lastChartAt: 0,
  };

  function readPrefs() {
    try {
      var saved = JSON.parse(localStorage.getItem("klt_prefs") || "{}");
      if (saved.market === "spot" || saved.market === "futures") state.market = saved.market;
      if (["BTC", "ETH", "SOL"].indexOf(saved.asset) >= 0) state.asset = saved.asset;
      if ([100, 200, 500].indexOf(saved.rows) >= 0) state.rows = saved.rows;
      if (saved.window && WINDOW_MS[saved.window]) state.window = saved.window;
    } catch (e) { /* storage unavailable: defaults */ }
    var params = new URLSearchParams(location.search);
    if (params.get("market") === "spot" || params.get("market") === "futures") state.market = params.get("market");
    var a = (params.get("asset") || "").toUpperCase();
    if (["BTC", "ETH", "SOL"].indexOf(a) >= 0) state.asset = a;
  }

  function savePrefs() {
    try {
      localStorage.setItem("klt_prefs", JSON.stringify({ market: state.market, asset: state.asset, rows: state.rows, window: state.window }));
    } catch (e) { /* ignore */ }
  }

  function serverNow() { return Date.now() + state.clockSkew; }

  // ── Connection ─────────────────────────────────────────────────────────

  function resetFeedState() {
    state.feed = null;
    state.instrument = null;
    state.status = null;
    state.stats = null;
    state.session = null;
    state.trades = [];
    state.seen = new Set();
    state.largeTrades = [];
    state.minutes = new Map();
    state.cvdBaseline = null;
    state.newSincePause = 0;
    state.frozenRows = null;
    state.frozenWhales = null;
  }

  function disconnect() {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    if (state.es) {
      state.es.close();
      state.es = null;
    }
  }

  function connect() {
    disconnect();
    resetFeedState();
    var gen = ++state.gen;
    state.sse = "connecting";
    state.sseError = null;
    showNotice(null);
    var url = "/api/kucoin-live-trades/stream?market=" + encodeURIComponent(state.market) + "&asset=" + encodeURIComponent(state.asset);
    var es = new EventSource(url);
    state.es = es;
    function guard(fn) {
      return function (event) {
        if (gen !== state.gen) return;
        state.lastServerEventAt = Date.now();
        var data;
        try { data = JSON.parse(event.data); } catch (e) { return; }
        fn(data);
      };
    }
    es.addEventListener("snapshot", guard(onSnapshot));
    es.addEventListener("trades", guard(onTrades));
    es.addEventListener("stats", guard(onStats));
    es.addEventListener("status", guard(onStatus));
    es.addEventListener("shutdown", guard(function () {
      state.sse = "retrying";
      state.sseError = "The dashboard server is restarting";
      markDirty("status");
    }));
    es.onopen = function () {
      if (gen !== state.gen) return;
      state.sse = "open";
      state.sseError = null;
      state.retryDelay = 3000;
      state.lastServerEventAt = Date.now();
      showNotice(null);
      markDirty("status");
    };
    es.onerror = function () {
      if (gen !== state.gen) return;
      if (es.readyState === 2) {
        // Closed for good (HTTP error): find out why, then retry with backoff.
        state.sse = "closed";
        probeFailure(gen);
        var delay = state.retryDelay;
        state.retryDelay = Math.min(60000, state.retryDelay * 2);
        state.retryTimer = setTimeout(function () { if (gen === state.gen) connect(); }, delay);
      } else {
        state.sse = "retrying";
        state.sseError = "Lost the connection to the dashboard server — retrying";
      }
      markDirty("status");
    };
    markDirty("all");
  }

  function probeFailure(gen) {
    fetch("/api/kucoin-live-trades/snapshot?market=" + encodeURIComponent(state.market) + "&asset=" + encodeURIComponent(state.asset), { cache: "no-store" })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (gen !== state.gen) return;
        var msg = result.body && (result.body.error || (result.body.status && result.body.status.message));
        state.sseError = msg || "The live stream is unavailable";
        showNotice(state.sseError + " — retrying in " + Math.round(state.retryDelay / 2000) + "s.", "error");
        markDirty("status");
      })
      .catch(function () {
        if (gen !== state.gen) return;
        state.sseError = "The dashboard server is unreachable";
        showNotice(state.sseError + " — retrying.", "error");
        markDirty("status");
      });
  }

  function adoptSession(session) {
    if (!session) return;
    if (!state.session || state.session.id !== session.id) {
      state.session = session;
      state.cvdBaseline = { quote: 0, base: 0, at: session.startedAt, reason: "session" };
    }
  }

  function onSnapshot(data) {
    // A reconnect of the same feed keeps a paused view frozen; a new feed
    // (market or pair change) freezes on its own first snapshot instead.
    var sameFeed = state.feed === data.feed;
    state.feed = data.feed;
    state.instrument = data.instrument;
    state.status = data.status;
    if (data.status && data.status.serverTime) state.clockSkew = data.status.serverTime - Date.now();
    state.stats = data.session ? {
      session: data.session, coverage: data.coverage, latest: data.latest, tradeRate: data.tradeRate,
      windows: data.windows, cvd: data.cvd, counts: data.counts, at: data.at,
    } : null;
    adoptSession(data.session);
    state.trades = (data.trades || []).slice(0, BUFFER_LIMIT);
    state.seen = new Set(state.trades.map(function (t) { return t.tradeId; }));
    state.largeTrades = (data.largeTrades || []).slice(0, LARGE_LIMIT);
    state.minutes = new Map();
    (data.minutes || []).forEach(function (m) { state.minutes.set(m.t, m); });
    if (!state.paused || !sameFeed) state.frozenRows = state.frozenWhales = null;
    markDirty("all");
  }

  function onTrades(data) {
    if (!data || data.feed !== state.feed || !Array.isArray(data.trades)) return;
    var fresh = [];
    for (var i = data.trades.length - 1; i >= 0; i--) {
      var t = data.trades[i];
      if (state.seen.has(t.tradeId)) continue;
      state.seen.add(t.tradeId);
      fresh.push(t);
      if (t.notional != null && t.sideVerified && t.notional >= 10000) state.largeTrades.unshift(t);
    }
    if (!fresh.length) return;
    // Batches are oldest→newest; the buffer is newest first.
    fresh.sort(function (a, b) { return b.exchangeTimeMs - a.exchangeTimeMs; });
    state.trades = fresh.concat(state.trades);
    if (state.trades.length > BUFFER_LIMIT) {
      state.trades.splice(BUFFER_LIMIT).forEach(function (t) { state.seen.delete(t.tradeId); });
    }
    if (state.largeTrades.length > LARGE_LIMIT) state.largeTrades.length = LARGE_LIMIT;
    if (state.paused) state.newSincePause += fresh.length;
    markDirty("tape", "whales", "kpis", "status");
  }

  function onStats(data) {
    if (!data || data.feed !== state.feed) return;
    state.status = data.status;
    if (data.status && data.status.serverTime) state.clockSkew = data.status.serverTime - Date.now();
    if (data.stats && data.stats.session && state.session && data.stats.session.id !== state.session.id) {
      // The server started a new session for this feed (it was idle and reopened).
      state.trades = [];
      state.seen = new Set();
      state.largeTrades = [];
      state.minutes = new Map();
    }
    state.stats = data.stats;
    adoptSession(data.stats && data.stats.session);
    (data.minutes || []).forEach(function (m) { state.minutes.set(m.t, m); });
    markDirty("kpis", "flow", "status", "charts");
  }

  function onStatus(data) {
    if (!data || data.feed !== state.feed) return;
    state.status = data;
    if (data.serverTime) state.clockSkew = data.serverTime - Date.now();
    markDirty("status");
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function markDirty() {
    for (var i = 0; i < arguments.length; i++) state.dirty[arguments[i]] = true;
    if (state.frame == null) state.frame = requestAnimationFrame(render);
  }

  function render() {
    state.frame = null;
    var d = state.dirty;
    state.dirty = {};
    var all = d.all;
    if (all || d.status) renderStatus();
    if (all || d.kpis) renderKpis();
    if (all || d.tape) renderTape();
    if (all || d.whales) renderWhales();
    if (all || d.flow) renderFlow();
    if (all || d.charts) {
      var now = Date.now();
      // Charts at most twice a second: cheap enough, and steady to read.
      if (all || now - state.lastChartAt > 500) {
        state.lastChartAt = now;
        renderCharts();
      } else {
        setTimeout(function () { markDirty("charts"); }, 500);
      }
    }
  }

  function showNotice(text, tone) {
    var el = $("klt-notice");
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.className = "klt-notice" + (tone ? " klt-notice--" + tone : "");
    el.textContent = text;
  }

  function connectionView() {
    var now = serverNow();
    var st = state.status;
    if (state.sse === "closed") return { tone: "error", label: "Disconnected", message: state.sseError || "Live stream unavailable" };
    if (state.sse === "retrying") return { tone: "warn", label: "Reconnecting", message: state.sseError || "Reconnecting to the dashboard server" };
    if (state.sse === "connecting" || !st) return { tone: "connecting", label: "Connecting", message: "Opening the live stream" };
    if (state.lastServerEventAt && Date.now() - state.lastServerEventAt > SERVER_SILENCE_MS) {
      return { tone: "warn", label: "Stale", message: "No update from the dashboard server for " + fmtDuration(Date.now() - state.lastServerEventAt) };
    }
    if (st.state === "live" && st.lastTradeAt && now - st.lastTradeAt > (st.staleAfterMs || 30000)) {
      return { tone: "warn", label: "Stale", message: "No KuCoin trade for " + fmtDuration(now - st.lastTradeAt) };
    }
    var tones = { live: "live", stale: "warn", reconnecting: "warn", connecting: "connecting", error: "error", disconnected: "error", idle: "error" };
    var labels = { live: "Live", stale: "Stale", reconnecting: "Reconnecting", connecting: "Connecting", error: "Error", disconnected: "Disconnected", idle: "Idle" };
    return { tone: tones[st.state] || "connecting", label: labels[st.state] || st.state, message: st.message || "" };
  }

  function renderStatus() {
    var view = connectionView();
    var pill = $("klt-conn");
    pill.className = "klt-pill klt-pill--" + view.tone;
    if (pill.textContent !== view.label) pill.textContent = view.label;
    $("klt-conn-msg").textContent = view.message === "Live" ? "" : view.message;
    $("klt-paused-pill").hidden = !state.paused;
    $("klt-symbol").textContent = state.instrument
      ? state.instrument.symbol + (state.instrument.marketType === "futures" ? " · 1 contract = " + state.instrument.multiplierText + " " + state.instrument.asset : "")
      : "—";
    var latest = state.trades[0] || (state.stats && state.stats.latest);
    var age = latest ? serverNow() - latest.exchangeTimeMs : null;
    $("klt-last-time").textContent = latest ? fmtTime(latest.exchangeTimeMs) + " (" + fmtDuration(Math.max(0, age)) + " ago)" : "—";
    var rate = state.stats && state.stats.tradeRate;
    $("klt-rate").textContent = rate ? rate.perSecond.toFixed(1) + " trades/s" : "—";
    $("klt-qty-head").textContent = state.instrument
      ? "Quantity (" + (state.instrument.marketType === "futures" ? "contracts" : state.instrument.asset) + ")"
      : "Quantity";
  }

  function partialNote(win) {
    if (!win) return "";
    if (win.complete) return "";
    return '<span class="klt-partial" title="The server has not been subscribed for the full window yet">partial · ' + fmtDuration(win.coveredMs) + " of " + fmtDuration(win.windowMs) + "</span>";
  }

  function setKpi(id, value, sub, tone) {
    var el = $(id);
    el.querySelector(".klt-kpi-value").innerHTML = value;
    el.querySelector(".klt-kpi-sub").innerHTML = sub;
    el.dataset.tone = tone || "";
  }

  function renderKpis() {
    var stats = state.stats;
    var latest = state.trades[0] || (stats && stats.latest);
    var tick = state.instrument && state.instrument.tickSize;
    if (latest) {
      setKpi("kpi-price", fmtPrice(latest.price, tick),
        '<span class="klt-side klt-side--' + latest.side + '">' + latest.side + "</span> " + escapeHtml(latest.symbol) + " · " + fmtTime(latest.exchangeTimeMs),
        latest.side);
    } else {
      setKpi("kpi-price", "—", state.sse === "open" ? "Waiting for the first trade" : "No data yet");
    }
    var w = stats && stats.windows && stats.windows["5m"];
    if (!w) {
      ["kpi-buy", "kpi-sell", "kpi-ratio", "kpi-delta", "kpi-largest"].forEach(function (id) { setKpi(id, "—", "No data yet"); });
      return;
    }
    var unit = state.instrument ? state.instrument.asset : "";
    var p = partialNote(w);
    setKpi("kpi-buy", fmtCompact(w.buyNotional), fmtBase(w.buyBase) + " " + unit + " · " + w.buyCount + " trades " + p, "buy");
    setKpi("kpi-sell", fmtCompact(w.sellNotional), fmtBase(w.sellBase) + " " + unit + " · " + w.sellCount + " trades " + p, "sell");
    setKpi("kpi-ratio",
      w.buySellRatio == null ? "—" : w.buySellRatio.toFixed(2) + "×",
      (w.buyPressurePct == null ? "No classified volume yet" : "Buy pressure " + w.buyPressurePct.toFixed(1) + "%") + " " + p,
      w.buySellRatio == null ? "" : w.buySellRatio >= 1 ? "buy" : "sell");
    setKpi("kpi-delta", fmtCompact(w.deltaNotional, { signed: true }),
      (w.deltaBase >= 0 ? "+" : "") + fmtBase(w.deltaBase) + " " + unit + " " + p,
      w.deltaNotional > 0 ? "buy" : w.deltaNotional < 0 ? "sell" : "");
    var big = w.largest;
    setKpi("kpi-largest", big ? fmtCompact(big.notional) : "—",
      big ? '<span class="klt-side klt-side--' + big.side + '">' + big.side + "</span> @ " + fmtPrice(big.price, tick) + " · " + fmtTime(big.exchangeTimeMs) + " " + p : "No priced trade in window " + p,
      big ? big.side : "");
  }

  function tradeRow(t) {
    var large = t.notional != null && t.notional >= state.whaleThreshold;
    var huge = t.notional != null && t.notional >= state.whaleThreshold * 10;
    var tick = state.instrument && state.instrument.tickSize;
    var qtyTitle = t.quantityUnit === "contracts" && t.baseQuantity != null ? ' title="' + escapeHtml(fmtBase(t.baseQuantity) + " " + t.baseCurrency) + '"' : "";
    return '<tr class="klt-row klt-row--' + t.side + (large ? " is-large" : "") + (huge ? " is-huge" : "") + '">' +
      '<td class="klt-time" title="' + escapeHtml(new Date(t.exchangeTimeMs).toISOString() + " · " + t.exchangeTimeNs + " ns · id " + t.tradeId) + '">' + fmtTime(t.exchangeTimeMs) + "</td>" +
      '<td class="num">' + fmtPrice(t.price, tick) + "</td>" +
      '<td class="num"' + qtyTitle + ">" + escapeHtml(fmtQuantity(t)) + "</td>" +
      '<td class="num">' + (t.notional == null ? '<span title="' + escapeHtml(t.notionalReason || "") + '">—</span>' : fmtUsdt(t.notional)) + "</td>" +
      '<td><span class="klt-side klt-side--' + t.side + '">' + (t.side === "buy" ? "Buy" : "Sell") + "</span></td></tr>";
  }

  function renderTape() {
    var body = $("klt-tape-body");
    var banner = $("klt-paused-banner");
    if (state.paused) {
      banner.hidden = false;
      banner.textContent = "Display paused at " + fmtTime(state.pausedAt) + " · " + state.newSincePause + " new trade" + (state.newSincePause === 1 ? "" : "s") + " received since — the feed is still live. Resume to catch up.";
      if (state.frozenRows) return;
    } else {
      banner.hidden = true;
    }
    var rows = visibleTrades(state.trades, { minValue: state.minValue, rows: state.rows });
    if (state.paused) state.frozenRows = rows;
    $("klt-tape-count").textContent = rows.length + " shown · " + state.trades.length + " buffered";
    if (!rows.length) {
      var msg = state.trades.length ? "No trades at or above " + fmtCompact(state.minValue) + " yet." : state.sse === "open" ? "Subscribed — waiting for the first KuCoin trade…" : "Connecting to the live feed…";
      body.innerHTML = '<tr class="klt-empty"><td colspan="5">' + escapeHtml(msg) + "</td></tr>";
      return;
    }
    body.innerHTML = rows.map(tradeRow).join("");
  }

  function renderWhales() {
    if (state.paused && state.frozenWhales) return;
    var list = whaleTrades(state.largeTrades, state.whaleThreshold);
    if (state.paused) state.frozenWhales = list;
    $("klt-whale-count").textContent = list.length + " this session";
    $("klt-timeline-unit").textContent = "≥ " + fmtCompact(state.whaleThreshold);
    var el = $("klt-whale-list");
    if (!list.length) {
      el.innerHTML = '<li class="klt-empty">No trades at or above ' + escapeHtml(fmtCompact(state.whaleThreshold)) + " this session.</li>";
      return;
    }
    var tick = state.instrument && state.instrument.tickSize;
    el.innerHTML = list.slice(0, 100).map(function (t) {
      return '<li class="klt-whale klt-whale--' + t.side + '">' +
        '<span class="klt-whale-time">' + fmtTime(t.exchangeTimeMs) + "</span>" +
        '<span class="klt-whale-sym">' + escapeHtml(t.symbol) + "</span>" +
        '<span class="klt-side klt-side--' + t.side + '">' + (t.side === "buy" ? "Buy" : "Sell") + "</span>" +
        '<span class="klt-whale-notional">' + fmtCompact(t.notional) + "</span>" +
        '<span class="klt-whale-price">@ ' + fmtPrice(t.price, tick) + "</span></li>";
    }).join("");
  }

  function renderFlow() {
    var stats = state.stats;
    var cov = $("klt-coverage");
    var dl = $("klt-flow-stats");
    var w = stats && stats.windows && stats.windows[state.window];
    if (!stats || !w) {
      cov.textContent = "No history yet.";
      dl.innerHTML = "";
      return;
    }
    var c = stats.coverage || {};
    var parts = [];
    if (c.since == null) parts.push("Not currently subscribed — rolling windows restart when the feed resumes.");
    else parts.push("History: " + fmtDuration(c.historyMs) + " of continuous subscription (since " + fmtTime(c.since).slice(0, 8) + ").");
    parts.push(w.complete
      ? "The " + state.window + " window is fully populated."
      : "The " + state.window + " window is partial: " + fmtDuration(w.coveredMs) + " of " + state.window + " collected — not a complete " + state.window + " measurement.");
    if (c.gaps) parts.push(c.gaps + " reconnect gap" + (c.gaps === 1 ? "" : "s") + " this session; trades during a gap were not received.");
    cov.textContent = parts.join(" ");
    cov.className = "klt-coverage" + (w.complete ? "" : " is-partial");
    var pct = w.buyPressurePct == null ? 50 : w.buyPressurePct;
    $("klt-pressure-buy").style.width = pct.toFixed(1) + "%";
    var unit = state.instrument ? state.instrument.asset : "";
    var items = [
      ["Buy notional", fmtCompact(w.buyNotional), "buy"],
      ["Sell notional", fmtCompact(w.sellNotional), "sell"],
      ["Delta", fmtCompact(w.deltaNotional, { signed: true }), w.deltaNotional >= 0 ? "buy" : "sell"],
      ["Delta (" + unit + ")", (w.deltaBase >= 0 ? "+" : "") + fmtBase(w.deltaBase), w.deltaBase >= 0 ? "buy" : "sell"],
      ["Buy pressure", w.buyPressurePct == null ? "—" : w.buyPressurePct.toFixed(1) + "%", ""],
      ["Trades", String(w.tradeCount), ""],
      ["Trades / min", w.tradesPerMinute == null ? "—" : w.tradesPerMinute.toFixed(1), ""],
    ];
    dl.innerHTML = items.map(function (item) {
      return '<div class="klt-flow-item"><dt>' + escapeHtml(item[0]) + '</dt><dd data-tone="' + item[2] + '">' + escapeHtml(item[1]) + "</dd></div>";
    }).join("");
  }

  // ── Charts (plain canvas; no extra dependency) ─────────────────────────

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }

  function prepCanvas(canvas) {
    var ratio = window.devicePixelRatio || 1;
    var width = canvas.clientWidth || 300;
    var height = canvas.clientHeight || 160;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px system-ui, sans-serif";
    return { ctx: ctx, w: width, h: height };
  }

  function emptyChart(c, text) {
    c.ctx.fillStyle = cssVar("--muted", "#8492aa");
    c.ctx.textAlign = "center";
    c.ctx.fillText(text, c.w / 2, c.h / 2);
    c.ctx.textAlign = "left";
  }

  function axisLabels(c, top, bottom, left, right, pads) {
    var ctx = c.ctx;
    ctx.fillStyle = cssVar("--muted", "#8492aa");
    ctx.textAlign = "left";
    ctx.fillText(top, 2, pads.t + 8);
    ctx.fillText(bottom, 2, c.h - pads.b - 2);
    ctx.fillText(left, pads.l, c.h - 2);
    ctx.textAlign = "right";
    ctx.fillText(right, c.w - 2, c.h - 2);
    ctx.textAlign = "left";
  }

  function renderCharts() {
    var now = serverNow();
    var minutes = Array.from(state.minutes.values()).sort(function (a, b) { return a.t - b.t; });
    var axis = minuteAxis(minutes, now, CHART_MINUTES);
    var currentMinute = Math.floor(now / 60000) * 60000;
    var sessionStart = state.session ? state.session.startedAt : null;
    var green = cssVar("--green", "#00e396");
    var red = cssVar("--red", "#ff4d6d");
    var blue = cssVar("--blue", "#4da3ff");
    var grid = "rgba(255,255,255,0.08)";
    var pads = { l: 44, r: 6, t: 6, b: 14 };
    var hasData = minutes.length > 0;

    function partial(m) { return m.t === currentMinute || (sessionStart != null && m.t < sessionStart && m.t + 60000 > sessionStart); }
    // At least 20 slots, right-aligned, so a young session draws thin bars
    // at the right edge rather than one bar the width of the chart.
    function barX(c, i, n) {
      var slots = Math.max(20, n);
      var span = (c.w - pads.l - pads.r) / slots;
      return { x: pads.l + (slots - n + i) * span + span * 0.12, width: Math.max(1, span * 0.76) };
    }

    // Buy vs sell volume, mirrored around zero.
    var vol = prepCanvas($("klt-chart-volume"));
    if (!hasData) emptyChart(vol, "Waiting for trades…");
    else {
      var maxV = Math.max(1, Math.max.apply(null, axis.map(function (m) { return Math.max(m.buyNotional || 0, m.sellNotional || 0); })));
      var mid = pads.t + (vol.h - pads.t - pads.b) / 2;
      var half = (vol.h - pads.t - pads.b) / 2;
      vol.ctx.strokeStyle = grid;
      vol.ctx.beginPath(); vol.ctx.moveTo(pads.l, mid); vol.ctx.lineTo(vol.w - pads.r, mid); vol.ctx.stroke();
      axis.forEach(function (m, i) {
        var b = barX(vol, i, axis.length);
        vol.ctx.globalAlpha = partial(m) ? 0.45 : 1;
        vol.ctx.fillStyle = green;
        var hb = ((m.buyNotional || 0) / maxV) * half;
        vol.ctx.fillRect(b.x, mid - hb, b.width, hb);
        vol.ctx.fillStyle = red;
        var hs = ((m.sellNotional || 0) / maxV) * half;
        vol.ctx.fillRect(b.x, mid, b.width, hs);
      });
      vol.ctx.globalAlpha = 1;
      axisLabels(vol, "+" + fmtCompact(maxV).replace("$", ""), "-" + fmtCompact(maxV).replace("$", ""), fmtClock(axis[0].t), fmtClock(currentMinute), pads);
    }

    // CVD relative to the session start or the last manual reset.
    var cvd = prepCanvas($("klt-chart-cvd"));
    var live = state.stats && state.stats.cvd;
    $("klt-cvd-unit").textContent = state.cvdUnit === "base" ? (state.instrument ? state.instrument.asset : "base") : "USDT";
    if (!state.cvdBaseline || !live) {
      emptyChart(cvd, "Waiting for trades…");
      $("klt-cvd-note").textContent = "";
    } else {
      var points = cvdSeries(minutes, { baseline: state.cvdBaseline, unit: state.cvdUnit, live: live, now: now });
      var from = Math.max(points[0].t, now - CHART_MINUTES * 60000);
      points = points.filter(function (p) { return p.t >= from; });
      var vals = points.map(function (p) { return p.v; }).concat([0]);
      var lo = Math.min.apply(null, vals);
      var hi = Math.max.apply(null, vals);
      if (hi === lo) { hi += 1; lo -= 1; }
      var span = Math.max(1, now - from);
      var x = function (t) { return pads.l + ((t - from) / span) * (cvd.w - pads.l - pads.r); };
      var y = function (v) { return pads.t + (1 - (v - lo) / (hi - lo)) * (cvd.h - pads.t - pads.b); };
      cvd.ctx.strokeStyle = grid;
      cvd.ctx.beginPath(); cvd.ctx.moveTo(pads.l, y(0)); cvd.ctx.lineTo(cvd.w - pads.r, y(0)); cvd.ctx.stroke();
      cvd.ctx.strokeStyle = points[points.length - 1].v >= 0 ? green : red;
      cvd.ctx.lineWidth = 1.6;
      cvd.ctx.beginPath();
      points.forEach(function (p, i) { if (i === 0) cvd.ctx.moveTo(x(p.t), y(p.v)); else cvd.ctx.lineTo(x(p.t), y(p.v)); });
      cvd.ctx.stroke();
      cvd.ctx.lineWidth = 1;
      var fmtV = state.cvdUnit === "base" ? function (v) { return (v >= 0 ? "+" : "") + fmtBase(v); } : function (v) { return fmtCompact(v, { signed: true }); };
      axisLabels(cvd, fmtV(hi), fmtV(lo), fmtClock(from), fmtClock(now), pads);
      var b = state.cvdBaseline;
      var latestV = points[points.length - 1].v;
      $("klt-cvd-note").textContent = "CVD " + fmtV(latestV) + " since " + fmtTime(b.at).slice(0, 8) +
        (b.reason === "manual" ? " (manual reset)" : " (start of this server session for " + (state.instrument ? state.instrument.symbol : "this feed") + ")") +
        ". KuCoin " + (state.instrument ? state.instrument.symbol : "") + " only — not the whole market.";
    }

    // Trades per minute.
    var tpm = prepCanvas($("klt-chart-tpm"));
    if (!hasData) emptyChart(tpm, "Waiting for trades…");
    else {
      var maxT = Math.max(1, Math.max.apply(null, axis.map(function (m) { return m.tradeCount || 0; })));
      axis.forEach(function (m, i) {
        var bx = barX(tpm, i, axis.length);
        var h = ((m.tradeCount || 0) / maxT) * (tpm.h - pads.t - pads.b);
        tpm.ctx.globalAlpha = partial(m) ? 0.45 : 1;
        tpm.ctx.fillStyle = blue;
        tpm.ctx.fillRect(bx.x, tpm.h - pads.b - h, bx.width, h);
      });
      tpm.ctx.globalAlpha = 1;
      axisLabels(tpm, String(maxT), "0", fmtClock(axis[0].t), fmtClock(currentMinute), pads);
    }

    // Large-trade timeline: one dot per execution, log-scaled by notional.
    var lg = prepCanvas($("klt-chart-large"));
    var fromL = hasData ? axis[0].t : now - CHART_MINUTES * 60000;
    var bigs = whaleTrades(state.largeTrades, state.whaleThreshold).filter(function (t) { return t.exchangeTimeMs >= fromL; });
    if (!bigs.length) emptyChart(lg, "No trades ≥ " + fmtCompact(state.whaleThreshold) + " in view");
    else {
      var maxN = Math.max.apply(null, bigs.map(function (t) { return t.notional; }));
      var lmin = Math.log10(state.whaleThreshold);
      var lmax = Math.max(lmin + 0.5, Math.log10(maxN));
      var spanL = Math.max(1, now - fromL);
      bigs.forEach(function (t) {
        var px = pads.l + ((t.exchangeTimeMs - fromL) / spanL) * (lg.w - pads.l - pads.r);
        var py = pads.t + (1 - (Math.log10(t.notional) - lmin) / (lmax - lmin)) * (lg.h - pads.t - pads.b);
        lg.ctx.globalAlpha = 0.85;
        lg.ctx.fillStyle = t.side === "buy" ? green : red;
        lg.ctx.beginPath();
        lg.ctx.arc(px, py, 2.5 + Math.min(5, (Math.log10(t.notional) - lmin) * 2), 0, Math.PI * 2);
        lg.ctx.fill();
      });
      lg.ctx.globalAlpha = 1;
      axisLabels(lg, fmtCompact(Math.pow(10, lmax)), fmtCompact(state.whaleThreshold), fmtClock(fromL), fmtClock(now), pads);
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────

  function setPaused(paused) {
    state.paused = paused;
    var btn = $("klt-pause");
    btn.setAttribute("aria-pressed", String(paused));
    btn.innerHTML = paused ? "&#9654; Resume display" : "&#10074;&#10074; Pause display";
    if (paused) {
      state.pausedAt = Date.now();
      state.newSincePause = 0;
      state.frozenRows = null;
      state.frozenWhales = null;
      // Capture the current view once, then stop re-rendering the lists.
      renderTape();
      renderWhales();
    } else {
      state.frozenRows = state.frozenWhales = null;
    }
    markDirty("tape", "whales", "status");
  }

  function setMarket(market) {
    if (market === state.market) return;
    state.market = market;
    document.querySelectorAll("[data-market]").forEach(function (b) {
      var on = b.dataset.market === market;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    updatePairLabels();
    savePrefs();
    connect();
  }

  function updatePairLabels() {
    var select = $("klt-pair");
    Array.prototype.forEach.call(select.options, function (opt) {
      var item = state.symbols && state.symbols[state.market] && state.symbols[state.market][opt.value];
      opt.textContent = item ? opt.value + " · " + item.symbol : opt.value + (state.symbols ? " · not listed" : "");
      opt.disabled = Boolean(state.symbols) && !item;
    });
    select.value = state.asset;
  }

  function download(name, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportCsv(which) {
    var rows = which === "visible"
      ? (state.paused && state.frozenRows ? state.frozenRows : visibleTrades(state.trades, { minValue: state.minValue, rows: state.rows }))
      : state.trades;
    if (!rows.length) {
      showNotice("Nothing to export yet.", "warn");
      setTimeout(function () { showNotice(null); }, 2500);
      return;
    }
    var symbol = state.instrument ? state.instrument.symbol : state.asset;
    var stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download("kucoin-" + state.market + "-" + symbol + "-" + which + "-" + stamp + ".csv", buildCsv(rows));
  }

  function bind() {
    document.querySelectorAll("[data-market]").forEach(function (b) {
      b.addEventListener("click", function () { setMarket(b.dataset.market); });
    });
    $("klt-pair").addEventListener("change", function (e) {
      state.asset = e.target.value;
      savePrefs();
      connect();
    });
    $("klt-pause").addEventListener("click", function () { setPaused(!state.paused); });
    $("klt-min-value").addEventListener("input", function (e) {
      var v = Number(e.target.value);
      state.minValue = isFinite(v) && v > 0 ? v : 0;
      state.frozenRows = null;
      markDirty("tape");
    });
    $("klt-rows").addEventListener("change", function (e) {
      state.rows = Number(e.target.value) || 200;
      state.frozenRows = null;
      savePrefs();
      markDirty("tape");
    });
    $("klt-export-visible").addEventListener("click", function () { exportCsv("visible"); });
    $("klt-export-buffer").addEventListener("click", function () { exportCsv("buffered"); });
    function readThreshold() {
      var sel = $("klt-whale-threshold").value;
      $("klt-whale-custom-wrap").hidden = sel !== "custom";
      var v = sel === "custom" ? Number($("klt-whale-custom").value) : Number(sel);
      // The server records executions from $10,000 up, so custom thresholds start there.
      state.whaleThreshold = isFinite(v) && v >= 10000 ? v : 10000;
      state.frozenRows = state.frozenWhales = null;
      markDirty("tape", "whales", "charts");
    }
    $("klt-whale-threshold").addEventListener("change", readThreshold);
    $("klt-whale-custom").addEventListener("input", readThreshold);
    $("klt-whale-custom").min = "10000";
    document.querySelectorAll("[data-window]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.window = b.dataset.window;
        document.querySelectorAll("[data-window]").forEach(function (o) {
          var on = o.dataset.window === state.window;
          o.classList.toggle("is-active", on);
          o.setAttribute("aria-pressed", String(on));
        });
        savePrefs();
        markDirty("flow");
      });
    });
    $("klt-cvd-units").addEventListener("click", function (e) {
      state.cvdUnit = state.cvdUnit === "quote" ? "base" : "quote";
      e.target.setAttribute("aria-pressed", String(state.cvdUnit === "base"));
      e.target.textContent = state.cvdUnit === "base" ? "Show in USDT" : "Show in base";
      markDirty("charts");
    });
    $("klt-cvd-reset").addEventListener("click", function () {
      var live = state.stats && state.stats.cvd;
      if (!live) return;
      state.cvdBaseline = { quote: live.quote, base: live.base, at: serverNow(), reason: "manual" };
      markDirty("charts");
    });
    window.addEventListener("resize", function () { markDirty("charts"); });
    // Ages ("3s ago") and staleness tick locally; nothing reloads the page.
    setInterval(function () { markDirty("status"); }, 1000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) markDirty("all"); });
  }

  function loadSymbols() {
    return fetch("/api/kucoin-live-trades/symbols", { cache: "no-store" })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body && result.body.error || "Symbol lookup failed");
        state.symbols = result.body;
        updatePairLabels();
      })
      .catch(function (err) {
        showNotice("Could not resolve KuCoin symbols: " + err.message + ". The stream will retry.", "warn");
      });
  }

  function init() {
    readPrefs();
    document.querySelectorAll("[data-market]").forEach(function (b) {
      var on = b.dataset.market === state.market;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll("[data-window]").forEach(function (b) {
      var on = b.dataset.window === state.window;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    $("klt-rows").value = String(state.rows);
    $("klt-pair").value = state.asset;
    bind();
    loadSymbols();
    connect();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : globalThis);
