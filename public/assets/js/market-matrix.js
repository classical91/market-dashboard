/**
 * TradeHunter → Market Matrix.
 *
 * Four independent chart panels in a 2×2 split. Every number on a panel comes
 * from /api/market-matrix/chart for that panel's symbol and timeframe; when
 * the API says a series is unavailable the panel is cleared and says why —
 * it never keeps drawing the last good data.
 *
 * Panels talk to the page through a small event bus (`bus`): each one
 * publishes its crosshair position and visible time range. Nothing consumes
 * those yet; synchronised crosshairs or ranges can subscribe later without
 * touching the panel code.
 */
(function () {
  "use strict";

  var API = "/api/market-matrix";
  var STORAGE_KEY = "marketMatrixWorkspace.v1";
  var TICK_MS = 15 * 1000;
  var INITIAL_VISIBLE_BARS = 160;

  // How often a panel re-reads its series while the page is visible.
  var REFRESH_MS = { "5m": 30e3, "15m": 30e3, "30m": 60e3, "1h": 60e3, "4h": 120e3, "1D": 300e3, "1W": 300e3 };
  var ERROR_RETRY_MS = 60e3;
  var TV_INTERVALS = { "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1D": "D", "1W": "W" };
  var SOURCE_SHORT = { binance: "Binance", yahoo: "Yahoo", sampled: "Sampled" };

  var gridEl = document.getElementById("mm-grid");
  var stripEl = document.getElementById("mm-strip");
  var noticeEl = document.getElementById("mm-notice");
  var syncBtn = document.getElementById("mm-sync");
  var syncStateEl = document.getElementById("mm-sync-state");
  var refreshAllBtn = document.getElementById("mm-refresh-all");
  var resetBtn = document.getElementById("mm-reset");

  var bus = typeof EventTarget === "function" ? new EventTarget() : null;
  var config = null;
  var state = null;
  var panels = [];
  var expanded = null;

  // ── Helpers ────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function showNotice(message) {
    noticeEl.style.display = message ? "" : "none";
    noticeEl.textContent = message || "";
  }

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function emit(type, detail) {
    if (!bus) return;
    try { bus.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (e) { /* old browser */ }
  }

  function symbolById(id) {
    for (var i = 0; i < config.symbols.length; i++) if (config.symbols[i].id === id) return config.symbols[i];
    return null;
  }

  function isTimeframe(tf) {
    return config.timeframes.some(function (t) { return t.key === tf; });
  }

  function tfLabel(tf) {
    for (var i = 0; i < config.timeframes.length; i++) if (config.timeframes[i].key === tf) return config.timeframes[i].label;
    return tf;
  }

  function compactUsd(value) {
    var abs = Math.abs(value);
    if (abs >= 1e12) return "$" + (value / 1e12).toFixed(3) + "T";
    if (abs >= 1e9) return "$" + (value / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (value / 1e6).toFixed(2) + "M";
    return "$" + Math.round(value).toLocaleString();
  }

  function pricePrecision(value) {
    var abs = Math.abs(value || 0);
    if (abs >= 1000) return 2;
    if (abs >= 1) return 3;
    if (abs >= 0.01) return 5;
    return 8;
  }

  // One formatter per series, shared by the price scale, legend and header.
  function makeFormatter(format, sample) {
    if (format === "usd-compact") return compactUsd;
    if (format === "percent") return function (v) { return Number(v).toFixed(3) + "%"; };
    var digits = pricePrecision(sample);
    return function (v) {
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    };
  }

  function priceFormatFor(format, sample) {
    if (format === "usd-compact") return { type: "custom", formatter: compactUsd, minMove: 1e6 };
    if (format === "percent") return { type: "custom", formatter: makeFormatter("percent"), minMove: 0.0001 };
    var digits = pricePrecision(sample);
    return { type: "price", precision: digits, minMove: Math.pow(10, -digits) };
  }

  function formatPct(value) {
    if (value == null || !isFinite(value)) return "—";
    return (value > 0 ? "+" : "") + value.toFixed(2) + "%";
  }

  function toneOf(value) {
    if (value == null || !isFinite(value) || value === 0) return "mm-flat";
    return value > 0 ? "mm-up" : "mm-down";
  }

  function arrowOf(value) {
    if (value == null || !isFinite(value) || value === 0) return "";
    return value > 0 ? "▲ " : "▼ ";
  }

  function localTime(seconds, withDate) {
    var d = new Date(seconds * 1000);
    var opts = withDate
      ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
    return d.toLocaleString(undefined, opts);
  }

  // Charts read time as UTC; these render it in the viewer's local zone.
  function tickMarkFormatter(time, type) {
    var d = new Date(time * 1000);
    if (type === 0) return String(d.getFullYear());
    if (type === 1) return d.toLocaleString(undefined, { month: "short" });
    if (type === 2) return String(d.getDate());
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // ── Workspace state ────────────────────────────────────────
  function defaultState() {
    return {
      panels: config.defaults.panels.map(function (id) { return { symbol: id, tf: config.defaults.timeframe }; }),
      sync: false,
      lastTf: config.defaults.timeframe,
    };
  }

  function loadState() {
    var fallback = defaultState();
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { saved = null; }
    if (!saved || !Array.isArray(saved.panels)) return fallback;
    return {
      panels: fallback.panels.map(function (def, i) {
        var p = saved.panels[i] || {};
        return {
          symbol: symbolById(p.symbol) ? p.symbol : def.symbol,
          tf: isTimeframe(p.tf) ? p.tf : def.tf,
        };
      }),
      sync: saved.sync === true,
      lastTf: isTimeframe(saved.lastTf) ? saved.lastTf : fallback.lastTf,
    };
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  // ── Panel ──────────────────────────────────────────────────
  function Panel(slot) {
    this.slot = slot;
    this.chart = null;
    this.series = null;
    this.seriesType = null;
    this.dataKey = null;
    this.lastTime = null;
    this.data = null;
    this.format = null;
    this.loading = false;
    this.loadedAt = 0;
    this.requestSeq = 0;
    this.build();
  }

  Panel.prototype.cfg = function () { return state.panels[this.slot]; };

  Panel.prototype.build = function () {
    var self = this;
    var el = document.createElement("section");
    el.className = "mm-panel";
    el.setAttribute("aria-label", "Chart " + (this.slot + 1));
    el.innerHTML =
      '<div class="mm-panel-head">' +
        '<select class="mm-select mm-select--symbol" aria-label="Symbol">' + symbolOptions() + "</select>" +
        '<select class="mm-select mm-select--tf" aria-label="Timeframe"></select>' +
        '<span class="mm-quote"><span class="mm-value"></span><span class="mm-change"></span></span>' +
        '<span class="mm-head-spacer"></span>' +
        '<span class="mm-source" tabindex="0"><span class="mm-source-label"></span></span>' +
        '<a class="mm-tv-link" target="_blank" rel="noopener" aria-label="Open on TradingView" title="Open this concept on TradingView (full history)">&#8599;</a>' +
        '<button class="mm-icon-btn mm-refresh" type="button" aria-label="Refresh chart" title="Refresh">&#8635;</button>' +
        '<button class="mm-icon-btn mm-expand" type="button" aria-label="Expand chart" title="Fullscreen">&#x26F6;</button>' +
      "</div>" +
      '<div class="mm-body">' +
        '<div class="mm-chart"></div>' +
        '<div class="mm-legend" aria-hidden="true"></div>' +
        '<div class="mm-overlay"><div class="mm-overlay-title">Loading…</div><div class="mm-overlay-reason"></div></div>' +
      "</div>";
    this.el = el;
    this.symbolEl = el.querySelector(".mm-select--symbol");
    this.tfEl = el.querySelector(".mm-select--tf");
    this.valueEl = el.querySelector(".mm-value");
    this.changeEl = el.querySelector(".mm-change");
    this.sourceEl = el.querySelector(".mm-source");
    this.sourceLabelEl = el.querySelector(".mm-source-label");
    this.tvLinkEl = el.querySelector(".mm-tv-link");
    this.refreshEl = el.querySelector(".mm-refresh");
    this.expandEl = el.querySelector(".mm-expand");
    this.chartEl = el.querySelector(".mm-chart");
    this.legendEl = el.querySelector(".mm-legend");
    this.overlayEl = el.querySelector(".mm-overlay");

    this.symbolEl.addEventListener("change", function () { self.setSymbol(self.symbolEl.value); });
    this.tfEl.addEventListener("change", function () { onTimeframeChange(self, self.tfEl.value); });
    this.refreshEl.addEventListener("click", function () { self.load({ force: true }); });
    this.expandEl.addEventListener("click", function () { toggleExpanded(self); });

    this.createChart();
    this.syncControls();
  };

  Panel.prototype.createChart = function () {
    var self = this;
    var LWC = window.LightweightCharts;
    var text = cssVar("--muted", "#8492aa");
    var grid = "rgba(137, 146, 166, 0.07)";
    this.chart = LWC.createChart(this.chartEl, {
      autoSize: true,
      layout: { background: { type: "solid", color: cssVar("--bg", "#070a12") }, textColor: text, fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: cssVar("--border", "rgba(255,255,255,0.08)") },
      timeScale: {
        borderColor: cssVar("--border", "rgba(255,255,255,0.08)"),
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: tickMarkFormatter,
      },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      localization: { timeFormatter: function (t) { return localTime(t, true); } },
    });
    this.chart.subscribeCrosshairMove(function (param) {
      self.renderLegend(param && param.time != null && self.series ? param.seriesData.get(self.series) : null);
      emit("crosshair", { slot: self.slot, time: param ? param.time : null });
    });
    this.chart.timeScale().subscribeVisibleTimeRangeChange(function (range) {
      emit("range", { slot: self.slot, range: range });
    });
  };

  Panel.prototype.ensureSeries = function (type, priceFormat) {
    if (this.series && this.seriesType === type) {
      this.series.applyOptions({ priceFormat: priceFormat });
      return;
    }
    if (this.series) this.chart.removeSeries(this.series);
    var up = cssVar("--green", "#00e396");
    var down = cssVar("--red", "#ff4d6d");
    if (type === "line") {
      this.series = this.chart.addLineSeries({
        color: cssVar("--amber", "#f5c542"),
        lineWidth: 2,
        priceFormat: priceFormat,
        lastValueVisible: true,
        priceLineVisible: true,
      });
    } else {
      this.series = this.chart.addCandlestickSeries({
        upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        priceFormat: priceFormat,
      });
    }
    this.seriesType = type;
  };

  Panel.prototype.syncControls = function () {
    var cfg = this.cfg();
    var sym = symbolById(cfg.symbol);
    this.symbolEl.value = cfg.symbol;
    this.symbolEl.title = sym ? sym.name : "";
    this.tfEl.innerHTML = config.timeframes.map(function (t) {
      var supported = !sym || sym.timeframes.indexOf(t.key) !== -1;
      return '<option value="' + escapeHtml(t.key) + '">' + escapeHtml(t.label + (supported ? "" : " (n/a)")) + "</option>";
    }).join("");
    this.tfEl.value = cfg.tf;
    if (sym && sym.tvSymbol) {
      this.tvLinkEl.hidden = false;
      this.tvLinkEl.href = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(sym.tvSymbol) +
        "&interval=" + encodeURIComponent(TV_INTERVALS[cfg.tf] || "60");
    } else {
      this.tvLinkEl.hidden = true;
    }
  };

  Panel.prototype.setSymbol = function (id) {
    if (!symbolById(id)) return;
    this.cfg().symbol = id;
    saveState();
    this.syncControls();
    this.load();
  };

  Panel.prototype.setTimeframe = function (tf) {
    if (!isTimeframe(tf)) return;
    this.cfg().tf = tf;
    this.syncControls();
    this.load();
  };

  Panel.prototype.showOverlay = function (title, reason, isError) {
    this.overlayEl.hidden = false;
    this.overlayEl.className = "mm-overlay" + (isError ? " mm-overlay--error" : "");
    this.overlayEl.querySelector(".mm-overlay-title").textContent = title;
    this.overlayEl.querySelector(".mm-overlay-reason").textContent = reason || "";
  };

  Panel.prototype.clear = function () {
    if (this.series) this.series.setData([]);
    this.data = null;
    this.dataKey = null;
    this.lastTime = null;
    this.valueEl.textContent = "";
    this.changeEl.textContent = "";
    this.changeEl.title = "";
    this.legendEl.textContent = "";
  };

  Panel.prototype.setSource = function (source, status, extra) {
    var cfg = this.cfg();
    var sym = symbolById(cfg.symbol);
    var src = source || (sym && config.sources[sym.source]) || null;
    var id = source ? source.id : sym && sym.source;
    this.sourceEl.className = "mm-source mm-source--" + status;
    this.sourceLabelEl.textContent = SOURCE_SHORT[id] || (src && src.label) || "";
    var lines = [];
    if (src) lines.push("Source: " + src.label + " — " + (source ? source.providerSymbol : sym.providerSymbol));
    if (source && source.note) lines.push(source.note);
    if (src && src.detail) lines.push(src.detail);
    if (extra) lines.push(extra);
    this.sourceEl.title = lines.join("\n");
    this.sourceEl.setAttribute("aria-label", lines.join(". "));
  };

  Panel.prototype.toChartData = function (data) {
    if (data.chartType !== "line") return data.candles;
    // Sampled series: a line through each bar's close, broken wherever a bar
    // is missing so an unsampled stretch never reads as a flat market.
    var step = data.intervalMs / 1000;
    var out = [];
    for (var i = 0; i < data.candles.length; i++) {
      var c = data.candles[i];
      if (i > 0 && c.time - data.candles[i - 1].time > step) out.push({ time: data.candles[i - 1].time + step });
      out.push({ time: c.time, value: c.close });
    }
    return out;
  };

  Panel.prototype.load = function (opts) {
    var self = this;
    var force = opts && opts.force;
    var cfg = this.cfg();
    var key = cfg.symbol + "|" + cfg.tf;
    var seq = ++this.requestSeq;
    this.loading = true;
    this.refreshEl.classList.add("is-busy");
    if (this.dataKey !== key) {
      this.clear();
      this.showOverlay("Loading…", symbolById(cfg.symbol).name + " · " + tfLabel(cfg.tf), false);
      this.setSource(null, "pending");
    }
    var url = API + "/chart?symbol=" + encodeURIComponent(cfg.symbol) + "&tf=" + encodeURIComponent(cfg.tf) + (force ? "&force=1" : "");
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "HTTP " + res.status);
          if (!body) throw new Error("Empty response");
          return body;
        });
      })
      .then(function (data) {
        if (seq !== self.requestSeq) return;
        if (!data.available) self.renderUnavailable(data.error, data.source);
        else self.render(data, key);
      })
      .catch(function (err) {
        if (seq !== self.requestSeq) return;
        self.renderUnavailable(err.message || "Request failed", null);
      })
      .then(function () {
        if (seq !== self.requestSeq) return;
        self.loading = false;
        self.loadedAt = Date.now();
        self.refreshEl.classList.remove("is-busy");
        renderStrip();
      });
  };

  Panel.prototype.renderUnavailable = function (reason, source) {
    // Unavailable means nothing drawn: no stale bars, no last value.
    this.clear();
    this.failed = true;
    this.showOverlay("Data unavailable", reason, true);
    this.setSource(source, "error", "Unavailable: " + reason);
  };

  Panel.prototype.render = function (data, key) {
    this.failed = false;
    var sample = data.value;
    this.format = makeFormatter(data.symbol.format, sample);
    this.ensureSeries(data.chartType, priceFormatFor(data.symbol.format, sample));
    var points = this.toChartData(data);
    var sameSeries = this.dataKey === key && this.lastTime != null;
    var from = -1;
    if (sameSeries) {
      for (var i = 0; i < points.length; i++) if (points[i].time === this.lastTime) { from = i; break; }
    }
    if (from !== -1) {
      // Same series refreshed: update the forming bar and append new ones so
      // the viewer's zoom and scroll position survive.
      for (var j = from; j < points.length; j++) this.series.update(points[j]);
    } else {
      this.series.setData(points);
      var n = points.length;
      if (n > INITIAL_VISIBLE_BARS) this.chart.timeScale().setVisibleLogicalRange({ from: n - INITIAL_VISIBLE_BARS, to: n + 4 });
      else this.chart.timeScale().fitContent();
    }
    this.data = data;
    this.dataKey = key;
    this.lastTime = points.length ? points[points.length - 1].time : null;
    this.overlayEl.hidden = true;

    this.valueEl.textContent = this.format(data.value);
    this.changeEl.className = "mm-change " + toneOf(data.changePct);
    this.changeEl.textContent = arrowOf(data.changePct) + formatPct(data.changePct);
    this.changeEl.title =
      "Change vs previous " + data.timeframeLabel + " close: " + formatPct(data.changePct) +
      (data.change24hPct != null ? "\n24h change: " + formatPct(data.change24hPct) : "") +
      "\nLast bar: " + localTime(Date.parse(data.lastBarTime) / 1000, true);

    var extra = [
      "History from " + localTime(Date.parse(data.firstBarTime) / 1000, true),
      "Fetched " + localTime(Date.parse(data.fetchedAt) / 1000, true),
    ].join("\n");
    this.setSource(data.source, data.source.sampled ? "sampled" : "live", extra);
    this.renderLegend(null);
  };

  Panel.prototype.renderLegend = function (point) {
    if (!this.data || !this.format) { this.legendEl.textContent = ""; return; }
    var f = this.format;
    var bar = point;
    if (!bar || (bar.close == null && bar.value == null)) {
      var candles = this.data.candles;
      bar = candles[candles.length - 1];
      if (this.data.chartType === "line") bar = { value: bar.close };
    }
    if (bar.value != null) {
      this.legendEl.innerHTML = "Close<b>" + escapeHtml(f(bar.value)) + "</b>";
      return;
    }
    this.legendEl.innerHTML =
      "O<b>" + escapeHtml(f(bar.open)) + "</b> H<b>" + escapeHtml(f(bar.high)) +
      "</b> L<b>" + escapeHtml(f(bar.low)) + "</b> C<b>" + escapeHtml(f(bar.close)) + "</b>";
  };

  Panel.prototype.due = function (now) {
    if (this.loading) return false;
    var wait = this.failed ? ERROR_RETRY_MS : REFRESH_MS[this.cfg().tf] || 60e3;
    return now - this.loadedAt >= wait;
  };

  function symbolOptions() {
    var used = {};
    var html = config.groups.map(function (group) {
      return '<optgroup label="' + escapeHtml(group.label) + '">' + group.ids.map(function (id) {
        var sym = symbolById(id);
        if (!sym) return "";
        used[id] = true;
        return '<option value="' + escapeHtml(id) + '">' + escapeHtml(sym.label) + "</option>";
      }).join("") + "</optgroup>";
    }).join("");
    config.symbols.forEach(function (sym) {
      if (!used[sym.id]) html += '<option value="' + escapeHtml(sym.id) + '">' + escapeHtml(sym.label) + "</option>";
    });
    return html;
  }

  // ── Page-level behaviour ───────────────────────────────────
  function onTimeframeChange(panel, tf) {
    if (!isTimeframe(tf)) return;
    state.lastTf = tf;
    if (state.sync) {
      panels.forEach(function (p) { if (p.cfg().tf !== tf || p === panel) p.setTimeframe(tf); });
    } else {
      panel.setTimeframe(tf);
    }
    saveState();
  }

  function renderSync() {
    syncBtn.setAttribute("aria-pressed", state.sync ? "true" : "false");
    syncStateEl.textContent = state.sync ? "ON" : "OFF";
  }

  function setSync(on) {
    state.sync = on;
    renderSync();
    if (on) {
      panels.forEach(function (p) { if (p.cfg().tf !== state.lastTf) p.setTimeframe(state.lastTf); });
    }
    saveState();
  }

  function toggleExpanded(panel) {
    var target = expanded === panel ? null : panel;
    if (expanded) {
      expanded.el.classList.remove("mm-panel--expanded");
      expanded.expandEl.innerHTML = "&#x26F6;";
      expanded.expandEl.setAttribute("aria-label", "Expand chart");
      expanded.expandEl.title = "Fullscreen";
    }
    expanded = target;
    gridEl.classList.toggle("mm-grid--focus", !!target);
    if (target) {
      target.el.classList.add("mm-panel--expanded");
      target.expandEl.innerHTML = "&#x2715;";
      target.expandEl.setAttribute("aria-label", "Close fullscreen");
      target.expandEl.title = "Back to the matrix (Esc)";
      target.expandEl.focus();
    } else {
      panel.expandEl.focus();
    }
  }

  function renderStrip() {
    stripEl.innerHTML = panels.map(function (p) {
      var sym = symbolById(p.cfg().symbol);
      var label = sym ? sym.label : p.cfg().symbol;
      if (!p.data) {
        return '<span class="mm-strip-item"><strong>' + escapeHtml(label) + '</strong><span class="mm-flat">' +
          (p.loading ? "…" : "—") + "</span></span>";
      }
      var pct = p.data.changePct;
      return '<span class="mm-strip-item" title="Change vs previous ' + escapeHtml(p.data.timeframeLabel) + ' close"><strong>' +
        escapeHtml(label) + '</strong><span class="' + toneOf(pct) + '">' + escapeHtml(arrowOf(pct) + formatPct(pct)) +
        '</span><span class="mm-flat">' + escapeHtml(p.data.timeframeLabel) + "</span></span>";
    }).join("");
  }

  function resetLayout() {
    if (expanded) toggleExpanded(expanded);
    var sync = state.sync;
    state = defaultState();
    state.sync = sync;
    saveState();
    panels.forEach(function (p) {
      p.syncControls();
      p.load();
    });
  }

  function tick() {
    if (document.hidden) return;
    var now = Date.now();
    panels.forEach(function (p) { if (p.due(now)) p.load(); });
  }

  function start() {
    state = loadState();
    gridEl.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var panel = new Panel(i);
      panels.push(panel);
      gridEl.appendChild(panel.el);
    }
    renderSync();
    renderStrip();
    panels.forEach(function (p) { p.load(); });

    syncBtn.addEventListener("click", function () { setSync(!state.sync); });
    refreshAllBtn.addEventListener("click", function () { panels.forEach(function (p) { p.load({ force: true }); }); });
    resetBtn.addEventListener("click", resetLayout);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && expanded) toggleExpanded(expanded);
    });
    document.addEventListener("visibilitychange", tick);
    setInterval(tick, TICK_MS);
  }

  if (!window.LightweightCharts) {
    gridEl.innerHTML = "";
    showNotice("The chart library failed to load, so no charts can be drawn. Reload the page to try again.");
    return;
  }

  fetch(API + "/config", { headers: { Accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (body) {
      config = body;
      start();
    })
    .catch(function (err) {
      gridEl.innerHTML = "";
      showNotice("Market Matrix configuration unavailable (" + err.message + "). Reload the page to try again.");
    });

  // Exposed for future synchronised crosshairs / ranges and for debugging.
  window.MarketMatrix = { bus: bus, panels: panels };
})();
