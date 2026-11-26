/**
 * Gann Intelligence page.
 *
 * Every number on screen comes from /api/gann/* (computed on the server from
 * closed candles) or from GannMath — the same module the server uses — so a
 * level drawn here is the level the API reports. The chart maps bar index
 * and price to pixels at draw time only; zooming changes the mapping, never
 * the geometry.
 */
(function () {
  "use strict";

  var S = window.ScreenerUI;
  var G = window.GannMath;
  var esc = S.escapeHtml;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    notice: $("gn-notice"),
    symbol: $("gn-symbol"),
    tfs: $("gn-timeframes"),
    anchorMode: $("gn-anchor-mode"),
    anchorSide: $("gn-anchor-side"),
    scaleMode: $("gn-scale-mode"),
    scaleValue: $("gn-scale-value"),
    sq9Step: $("gn-sq9-step"),
    refresh: $("gn-refresh"),
    freshness: $("gn-freshness"),
    overlays: $("gn-overlays"),
    canvas: $("gn-chart"),
    wrap: $("gn-chart-wrap"),
    chartState: $("gn-chart-state"),
    readout: $("gn-readout"),
    anchorReadout: $("gn-anchor-readout"),
    levels: $("gn-levels"),
    calendar: $("gn-calendar"),
    tech: $("gn-tech"),
    matrix: $("gn-matrix"),
    matrixHint: $("gn-matrix-hint"),
    mtf: $("gn-mtf"),
    screener: $("gn-screener"),
    screenerRun: $("gn-screener-run"),
    backtest: $("gn-backtest"),
    backtestRun: $("gn-backtest-run"),
    cost: $("gn-cost"),
    sq9Form: $("gn-sq9-form"),
    sq9Price: $("gn-sq9-price"),
    sq9CalcStep: $("gn-sq9-calc-step"),
    sq9Count: $("gn-sq9-count"),
    sq9Normalise: $("gn-sq9-normalise"),
    sq9Out: $("gn-sq9-out"),
  };
  var updated = S.createUpdatedStamp($("gn-updated"), "ss-updated");

  var STORE_KEY = "gannIntelligence:v1";
  var state = {
    symbol: "BTCUSDT",
    timeframe: "4h",
    anchorMode: "auto",
    anchorSide: "auto",
    anchorTime: null,
    scaleMode: "atr",
    scaleValue: "",
    sq9Step: "45",
    overlays: {},
    data: null,
    view: null,
    requestId: 0,
  };

  // ---------------------------------------------------------------- storage
  function loadPrefs() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
      ["symbol", "timeframe", "anchorMode", "anchorSide", "scaleMode", "scaleValue", "sq9Step"].forEach(function (k) {
        if (typeof saved[k] === "string") state[k] = saved[k];
      });
      if (typeof saved.anchorTime === "number") state.anchorTime = saved.anchorTime;
      if (saved.overlays && typeof saved.overlays === "object") state.overlays = saved.overlays;
    } catch (e) { /* defaults stand */ }
  }
  function savePrefs() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        symbol: state.symbol, timeframe: state.timeframe, anchorMode: state.anchorMode, anchorSide: state.anchorSide,
        anchorTime: state.anchorTime, scaleMode: state.scaleMode, scaleValue: state.scaleValue, sq9Step: state.sq9Step, overlays: state.overlays,
      }));
    } catch (e) { /* nothing to persist */ }
  }

  // ---------------------------------------------------------------- format
  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return "—";
    var a = Math.abs(v);
    var digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
    return Number(v).toLocaleString(undefined, { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
  }
  function fmtPct(v) { return v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; }
  function fmtRate(v) { return v == null ? "—" : (v * 100).toFixed(1) + "%"; }
  function fmtTime(ms) {
    if (ms == null) return "—";
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function countBadge(n) {
    var cls = n >= 3 ? "gn-count gn-count--3" : n === 2 ? "gn-count gn-count--2" : "gn-count";
    return '<span class="' + cls + '" title="Independent methods agreeing">' + n + "</span>";
  }

  function showNotice(text) {
    els.notice.style.display = text ? "" : "none";
    els.notice.textContent = text || "";
  }

  function query(extra) {
    var p = new URLSearchParams({
      symbol: state.symbol,
      timeframe: state.timeframe,
      anchorMode: state.anchorMode,
      anchorSide: state.anchorSide,
      scaleMode: state.scaleMode,
      sq9Step: state.sq9Step,
    });
    if (state.anchorMode === "manual" && state.anchorTime != null) p.set("anchorTime", String(state.anchorTime));
    if (state.scaleMode === "manual" && state.scaleValue) p.set("scaleValue", state.scaleValue);
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
        return body;
      });
    });
  }

  // ---------------------------------------------------------------- loading
  function setChartState(text, isError) {
    els.chartState.hidden = !text;
    els.chartState.textContent = text || "";
    els.chartState.classList.toggle("is-error", Boolean(isError));
  }

  function load(force) {
    var id = ++state.requestId;
    setChartState("Loading closed " + state.timeframe + " candles…");
    var url = "/api/gann/analysis?" + query(force ? { force: "true" } : null);
    getJson(url).then(function (data) {
      if (id !== state.requestId) return;
      state.data = data;
      updated.mark();
      if (!data.ok) {
        setChartState(data.reason || "Analysis unavailable", true);
        renderEmptyCards(data.reason || "Analysis unavailable");
        return;
      }
      var notes = (data.warnings || []).slice();
      if (data.freshness && data.freshness.state === "STALE") notes.unshift("Stale data: " + (data.freshness.staleReasons || []).join(" · "));
      showNotice(notes.join(" "));
      els.freshness.innerHTML = S.freshnessBadge(data.freshness);
      if (!state.view || state.view.key !== viewKey()) resetView();
      setChartState("");
      draw();
      renderLevels(data);
      renderCalendar(data);
      renderTech(data);
      renderMatrix(data);
      if (!els.sq9Price.value) { els.sq9Price.value = String(data.lastClosed.close); renderSq9Calc(); }
    }).catch(function (err) {
      if (id !== state.requestId) return;
      state.data = null;
      setChartState("Could not load candles: " + err.message + ". Nothing is drawn rather than drawing stale or invented data.", true);
      renderEmptyCards("Unavailable: " + err.message);
      els.freshness.innerHTML = S.freshnessBadge(null);
    });
    loadMtf();
  }

  function loadMtf() {
    els.mtf.innerHTML = '<tbody><tr><td class="gn-empty">Loading all timeframes…</td></tr></tbody>';
    getJson("/api/gann/mtf?" + query()).then(function (data) {
      var rows = data.rows || [];
      els.mtf.innerHTML =
        "<thead><tr><th>TF</th><th>Structure</th><th>vs 1x1</th><th>Support</th><th>Resistance</th><th>Next cycle</th><th>Fresh</th></tr></thead><tbody>" +
        rows.map(function (r) {
          if (r.error) return "<tr><td>" + esc(r.timeframe) + '</td><td colspan="6" class="gn-error">' + esc(r.error) + "</td></tr>";
          return "<tr><td><strong>" + esc(r.timeframe) + "</strong></td>" +
            "<td>" + esc(r.structure) + "</td>" +
            "<td>" + (r.aboveOneByOne == null ? "—" : r.aboveOneByOne ? '<span class="gn-up" title="Price has moved away from the anchor faster than the 1x1 angle">ahead of 1x1</span>' : '<span class="gn-down" title="Price has moved away from the anchor slower than the 1x1 angle">behind 1x1</span>') + "</td>" +
            "<td>" + (r.nearestSupport ? fmtPrice(r.nearestSupport.price) + " " + countBadge(r.nearestSupport.sourceCount) : "—") + "</td>" +
            "<td>" + (r.nearestResistance ? fmtPrice(r.nearestResistance.price) + " " + countBadge(r.nearestResistance.sourceCount) : "—") + "</td>" +
            "<td>" + (r.nextCycle ? r.nextCycle.barsAway + " bars · " + fmtTime(r.nextCycle.fromTime) : "—") + "</td>" +
            "<td>" + S.freshnessBadge(r.freshness) + "</td></tr>";
        }).join("") + "</tbody>";
    }).catch(function (err) {
      els.mtf.innerHTML = '<tbody><tr><td class="gn-error">Unavailable: ' + esc(err.message) + "</td></tr></tbody>";
    });
  }

  function renderEmptyCards(message) {
    var html = '<div class="gn-error">' + esc(message) + "</div>";
    els.levels.innerHTML = html;
    els.calendar.innerHTML = '<li class="gn-error">' + esc(message) + "</li>";
    els.tech.innerHTML = "";
    els.matrix.innerHTML = '<tbody><tr><td class="gn-error">' + esc(message) + "</td></tr></tbody>";
    els.anchorReadout.textContent = "";
    clearCanvas();
  }

  // ---------------------------------------------------------------- cards
  function renderLevels(d) {
    var res = d.confluence.resistances.slice(0, 5).reverse();
    var sup = d.confluence.supports.slice(0, 5);
    var row = function (c, cls) {
      return '<div class="gn-level ' + cls + '"><span>' + fmtPrice(c.price) + "</span><small title=\"" + esc(c.members.map(function (m) { return m.label; }).join(", ")) + '">' +
        esc(c.sources.join(" · ")) + " (" + fmtPct(c.distancePct) + ")</small>" + countBadge(c.sourceCount) + "</div>";
    };
    els.levels.innerHTML =
      (res.length ? res.map(function (c) { return row(c, "gn-level--res"); }).join("") : '<div class="gn-empty">No resistance projections in range</div>') +
      '<div class="gn-level gn-level--now"><span>' + fmtPrice(d.lastClosed.close) + "</span><small>last close</small><span></span></div>" +
      (sup.length ? sup.map(function (c) { return row(c, "gn-level--sup"); }).join("") : '<div class="gn-empty">No support projections in range</div>');
  }

  function renderCalendar(d) {
    var items = d.calendar.slice(0, 14);
    if (!items.length) { els.calendar.innerHTML = '<li class="gn-empty">No cycle windows inside the horizon</li>'; return; }
    els.calendar.innerHTML = items.map(function (c) {
      return "<li><span>" + fmtTime(c.fromTime) + (c.toIndex > c.fromIndex ? " → " + fmtTime(c.toTime) : "") + " · " + c.barsAway + " bars</span>" +
        countBadge(c.sourceCount) + "<small>" + esc(c.members.map(function (m) { return m.label; }).join(", ")) + "</small></li>";
    }).join("");
  }

  function renderTech(d) {
    var i = d.indicators;
    var a = d.anchor;
    var rows = [
      ["Anchor", (a.source === "manual" ? "Manual " : "Auto ") + "swing " + a.type + " " + fmtPrice(a.price)],
      ["Scale (1x1)", fmtPrice(d.scale.value) + " / bar · " + d.scale.mode.toUpperCase()],
      ["Structure", d.structure.state],
      ["Fan position", (d.fanPosition.between[0] || "—") + " ↔ " + (d.fanPosition.between[1] || "—")],
      ["RSI 14", i.rsi14 == null ? "—" : i.rsi14.toFixed(1)],
      ["MACD hist", i.macd && i.macd.histogram != null ? fmtPrice(i.macd.histogram) : "—"],
      ["Anchored VWAP", fmtPrice(i.anchoredVwap) + " (" + fmtPct(i.vwapDistancePct) + ")"],
      ["Volume POC", d.volumeProfile ? fmtPrice(d.volumeProfile.poc) : "—"],
      ["Volume ×20 avg", i.volumeRatio == null ? "—" : i.volumeRatio.toFixed(2) + "×"],
      ["ATR 14", fmtPrice(d.atr14)],
    ];
    els.tech.innerHTML = rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("");
    els.anchorReadout.textContent = "Anchor " + a.type + " " + fmtPrice(a.price) + " @ " + fmtTime(a.time) + (state.anchorMode === "manual" ? " · click a candle to move it" : "");
  }

  var MATRIX_SOURCES = ["Square of Nine", "Gann Fan", "Gann Box", "Square of 144", "Fibonacci", "VWAP", "Volume Profile"];
  function renderMatrix(d) {
    var rows = d.confluence.matrix.filter(function (c) { return c.sourceCount >= 2; })
      .sort(function (a, b) { return b.price - a.price; });
    els.matrixHint.textContent = "Clusters of ≥2 methods within " + fmtPrice(d.confluence.tolerance) + " (¼ ATR) · count, not probability";
    if (!rows.length) { els.matrix.innerHTML = '<tbody><tr><td class="gn-empty">No multi-method clusters near price right now</td></tr></tbody>'; return; }
    els.matrix.innerHTML = "<thead><tr><th>Zone</th><th>Δ</th>" + MATRIX_SOURCES.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "<th>Count</th></tr></thead><tbody>" +
      rows.map(function (c) {
        return "<tr><td>" + fmtPrice(c.low) + (c.high !== c.low ? " – " + fmtPrice(c.high) : "") + "</td><td class=\"" + (c.distancePct >= 0 ? "gn-down" : "gn-up") + "\">" + fmtPct(c.distancePct) + "</td>" +
          MATRIX_SOURCES.map(function (s) { return "<td>" + (c.sources.indexOf(s) !== -1 ? '<span class="gn-tick" aria-label="yes">●</span>' : "") + "</td>"; }).join("") +
          "<td>" + countBadge(c.sourceCount) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  function renderSq9Calc() {
    var price = Number(els.sq9Price.value);
    if (!(price > 0)) { els.sq9Out.innerHTML = '<div class="gn-empty">Enter a positive price</div>'; return; }
    var r = G.squareOfNine(price, { step: Number(els.sq9CalcStep.value), count: Number(els.sq9Count.value) || 8, normalise: els.sq9Normalise.checked });
    var rows = r.levels.slice().reverse();
    var html = rows.filter(function (l) { return l.price > price; }).map(cell).join("") +
      '<div class="is-now"><span>' + fmtPrice(price) + "</span><span>" + (r.degree == null ? "" : r.degree.toFixed(1) + "°") + "</span></div>" +
      rows.filter(function (l) { return l.price < price; }).map(cell).join("");
    els.sq9Out.innerHTML = html + (r.factor !== 1 ? '<div class="gn-empty" style="grid-column:1/-1">Normalised ×' + r.factor + " before the square-root arithmetic, then scaled back</div>" : "");
    function cell(l) {
      return '<div class="' + (l.cardinal ? "is-cardinal" : "") + '"><span>' + fmtPrice(l.price) + "</span><span>" + (l.degrees > 0 ? "+" : "") + l.degrees + "°</span></div>";
    }
  }

  // ---------------------------------------------------------------- screener & backtest
  function runScreener() {
    els.screenerRun.disabled = true;
    els.screener.innerHTML = '<tbody><tr><td class="gn-empty">Scanning ' + esc(state.timeframe) + " universe…</td></tr></tbody>";
    getJson("/api/gann/screener?" + query()).then(function (data) {
      var rows = (data.rows || []).slice().sort(function (a, b) {
        if (a.error || b.error) return a.error ? 1 : -1;
        return nearest(a) - nearest(b);
      });
      els.screener.innerHTML = "<thead><tr><th>Pair</th><th>Close</th><th>Structure</th><th>vs 1x1</th><th>Support</th><th>Resistance</th><th>Next cycle</th><th>Fresh</th></tr></thead><tbody>" +
        rows.map(function (r) {
          if (r.error) return "<tr><td>" + esc(r.symbol) + '</td><td colspan="7" class="gn-error">' + esc(r.error) + "</td></tr>";
          return '<tr><td><button type="button" class="gn-icon-btn" style="width:auto;padding:0 8px" data-symbol="' + esc(r.symbol) + '">' + esc(r.symbol.replace(/USDT$/, "")) + "</button></td>" +
            "<td>" + fmtPrice(r.close) + "</td><td>" + esc(r.structure) + "</td>" +
            "<td>" + (r.aboveOneByOne == null ? "—" : r.aboveOneByOne ? '<span class="gn-up">ahead</span>' : '<span class="gn-down">behind</span>') + "</td>" +
            "<td>" + (r.nearestSupport ? fmtPct(r.nearestSupport.distancePct) + " " + countBadge(r.nearestSupport.sourceCount) : "—") + "</td>" +
            "<td>" + (r.nearestResistance ? fmtPct(r.nearestResistance.distancePct) + " " + countBadge(r.nearestResistance.sourceCount) : "—") + "</td>" +
            "<td>" + (r.nextCycle ? r.nextCycle.barsAway + " bars " + countBadge(r.nextCycle.sourceCount) : "—") + "</td>" +
            "<td>" + S.freshnessBadge(r.freshness) + "</td></tr>";
        }).join("") + "</tbody>";
    }).catch(function (err) {
      els.screener.innerHTML = '<tbody><tr><td class="gn-error">Scan failed: ' + esc(err.message) + "</td></tr></tbody>";
    }).then(function () { els.screenerRun.disabled = false; });
    function nearest(r) {
      var a = r.nearestSupport ? Math.abs(r.nearestSupport.distancePct) : Infinity;
      var b = r.nearestResistance ? Math.abs(r.nearestResistance.distancePct) : Infinity;
      return Math.min(a, b);
    }
  }

  function runBacktest() {
    els.backtestRun.disabled = true;
    els.backtest.innerHTML = '<div class="gn-empty">Running walk-forward backtest…</div>';
    getJson("/api/gann/backtest?" + query({ costScenario: els.cost.value })).then(function (b) {
      if (!b.ok) { els.backtest.innerHTML = '<div class="gn-error">' + esc(b.reason || "Backtest unavailable") + "</div>"; return; }
      var lr = b.levelReactions;
      var cy = b.cycleReversals;
      var st = b.strategies;
      var tallyRow = function (name, t) {
        return "<tr><td>" + name + "</td><td>" + t.touches + "</td><td>" + t.reactions + "</td><td>" + t.breaks + "</td><td>" + fmtRate(t.reactionRate) + "</td><td>" + fmtRate(t.falseSignalRate) + "</td></tr>";
      };
      var cycRow = function (name, c) {
        return "<tr><td>" + name + "</td><td>" + c.pivots + "</td><td>" + c.pivotsInWindow + "</td><td>" + fmtRate(c.hitRate) + "</td><td>" + fmtRate(c.baselineRate) + "</td><td>" + (c.lift == null ? "—" : c.lift.toFixed(2) + "×") + "</td></tr>";
      };
      var stratRow = function (name, m) {
        return "<tr><td>" + name + "</td><td>" + m.trades + "</td><td>" + fmtRate(m.winRate) + "</td><td>" + (m.avgNetPct == null ? "—" : fmtPct(m.avgNetPct)) + "</td><td>" + (m.totalNetPct == null ? "—" : fmtPct(m.totalNetPct)) + "</td><td>" + (m.profitFactor == null ? "—" : m.profitFactor.toFixed(2)) + "</td><td>" + (m.maxDrawdownPct == null ? "—" : m.maxDrawdownPct.toFixed(2) + "%") + "</td></tr>";
      };
      var hc = b.historicalCycles;
      els.backtest.innerHTML =
        '<div class="gn-bt-meta">' + b.dataset.bars + " closed bars · " + fmtTime(b.dataset.firstOpenTime) + " → " + fmtTime(b.dataset.lastOpenTime) +
        " · out-of-sample from " + fmtTime(b.dataset.splitOpenTime) + " · costs: " + esc(b.costs.label) + " · fingerprint <code>" + esc(b.fingerprint) + "</code></div>" +
        '<div class="gn-bt-grid">' +
          '<div><h3>Level reactions (±1 ATR within 10 bars)</h3><div class="ss-table-wrap"><table class="ss-table gn-table"><thead><tr><th>Set</th><th>Touches</th><th>React</th><th>Break</th><th>Reaction</th><th>False</th></tr></thead><tbody>' +
            tallyRow("Gann · in-sample", lr.gann.inSample) + tallyRow("Control · in-sample", lr.control.inSample) +
            tallyRow("Gann · out-of-sample", lr.gann.outOfSample) + tallyRow("Control · out-of-sample", lr.control.outOfSample) +
          "</tbody></table></div></div>" +
          '<div><h3>Cycle reversals vs random timing</h3><div class="ss-table-wrap"><table class="ss-table gn-table"><thead><tr><th>Sample</th><th>Pivots</th><th>In window</th><th>Hit</th><th>Baseline</th><th>Lift</th></tr></thead><tbody>' +
            cycRow("In-sample", cy.inSample) + cycRow("Out-of-sample", cy.outOfSample) +
          "</tbody></table></div>" +
          (hc && hc.swings ? '<div class="gn-bt-meta">Historical swings: ' + hc.swings + " · median " + hc.medianBars + " bars (" + hc.minBars + "–" + hc.maxBars + ") · near a Gann number " + fmtRate(hc.nearGannRate) + " vs " + fmtRate(hc.baselineRate) + " baseline</div>" : "") +
          "</div>" +
          '<div style="grid-column:1/-1"><h3>RSI(14) reversal, with and without Gann confluence, net of costs</h3><div class="ss-table-wrap"><table class="ss-table gn-table"><thead><tr><th>Variant</th><th>Trades</th><th>Win</th><th>Avg net</th><th>Total net</th><th>PF</th><th>Max DD</th></tr></thead><tbody>' +
            stratRow("RSI only · IS", st.rsiOnly.inSample) + stratRow("RSI + Gann · IS", st.rsiWithGann.inSample) + stratRow("RSI + control · IS", st.rsiWithControl.inSample) +
            stratRow("RSI only · OOS", st.rsiOnly.outOfSample) + stratRow("RSI + Gann · OOS", st.rsiWithGann.outOfSample) + stratRow("RSI + control · OOS", st.rsiWithControl.outOfSample) +
          "</tbody></table></div></div>" +
        "</div>" +
        '<ul class="gn-caveats">' + (b.caveats || []).map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>";
    }).catch(function (err) {
      els.backtest.innerHTML = '<div class="gn-error">Backtest failed: ' + esc(err.message) + "</div>";
    }).then(function () { els.backtestRun.disabled = false; });
  }

  // ---------------------------------------------------------------- chart
  var ctx = els.canvas.getContext("2d");
  var PAD = { left: 8, right: 74, top: 10, bottom: 22 };
  var COLORS = {
    up: "#00e396", down: "#ff4d6d", grid: "rgba(255,255,255,0.05)", text: "#8492aa",
    fan: "rgba(77,163,255,0.55)", oneByOne: "#f5c542", sq9: "rgba(155,123,255,0.55)", box: "rgba(0,227,150,0.35)",
    square: "rgba(0,227,150,0.7)", sq144: "rgba(245,197,66,0.35)", fib: "rgba(77,163,255,0.35)", vwap: "#e0e6f5",
    cycle: "245,197,66", anchor: "#f5c542",
  };

  function viewKey() { return state.symbol + ":" + state.timeframe; }

  function resetView() {
    var n = state.data && state.data.candles ? state.data.candles.length : 0;
    var visible = Math.min(n, 160);
    state.view = { key: viewKey(), start: n - visible, end: n + 24 };
  }

  function clearCanvas() {
    var r = resize();
    ctx.clearRect(0, 0, r.w, r.h);
  }

  function resize() {
    var rect = els.wrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(200, rect.width);
    var h = Math.max(200, rect.height);
    if (els.canvas.width !== Math.round(w * dpr) || els.canvas.height !== Math.round(h * dpr)) {
      els.canvas.width = Math.round(w * dpr);
      els.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function overlayOn(name) {
    var box = els.overlays.querySelector('[data-overlay="' + name + '"]');
    return box ? box.checked : false;
  }

  function geometry() {
    var d = state.data;
    var r = resize();
    var v = state.view;
    var plotW = r.w - PAD.left - PAD.right;
    var plotH = r.h - PAD.top - PAD.bottom;
    var from = Math.max(0, Math.floor(v.start));
    var to = Math.min(d.candles.length - 1, Math.ceil(v.end));
    var hi = -Infinity;
    var lo = Infinity;
    for (var i = from; i <= to; i += 1) {
      if (d.candles[i].high > hi) hi = d.candles[i].high;
      if (d.candles[i].low < lo) lo = d.candles[i].low;
    }
    if (!isFinite(hi)) { hi = d.lastClosed.close * 1.05; lo = d.lastClosed.close * 0.95; }
    var padY = (hi - lo) * 0.08 || hi * 0.01;
    hi += padY; lo -= padY;
    var barW = plotW / (v.end - v.start);
    return {
      w: r.w, h: r.h, plotW: plotW, plotH: plotH, hi: hi, lo: lo, barW: barW,
      x: function (idx) { return PAD.left + (idx - v.start + 0.5) * barW; },
      y: function (p) { return PAD.top + (hi - p) / (hi - lo) * plotH; },
      idxAt: function (px) { return Math.round((px - PAD.left) / barW - 0.5 + v.start); },
      priceAt: function (py) { return hi - (py - PAD.top) / plotH * (hi - lo); },
    };
  }

  function hLine(g, price, color, label, dash) {
    if (price < g.lo || price > g.hi) return;
    var y = Math.round(g.y(price)) + 0.5;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + g.plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    if (label) { ctx.fillStyle = color; ctx.fillText(label, PAD.left + g.plotW - ctx.measureText(label).width - 4, y - 3); }
  }

  function vLine(g, idx, color, dash) {
    var x = Math.round(g.x(idx)) + 0.5;
    if (x < PAD.left || x > PAD.left + g.plotW) return;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + g.plotH); ctx.stroke();
    ctx.setLineDash([]);
  }

  function draw() {
    var d = state.data;
    if (!d || !d.ok || !d.candles) return;
    var g = geometry();
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.font = "10px system-ui, sans-serif";
    ctx.lineWidth = 1;

    // grid + price axis
    for (var k = 0; k <= 6; k += 1) {
      var p = g.lo + (g.hi - g.lo) * k / 6;
      var gy = Math.round(g.y(p)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(PAD.left, gy); ctx.lineTo(PAD.left + g.plotW, gy); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(fmtPrice(p), PAD.left + g.plotW + 6, gy + 3);
    }
    // time axis
    var step = Math.max(1, Math.round(90 / g.barW));
    var lastIdx = d.candles.length - 1;
    for (var t = Math.ceil(state.view.start / step) * step; t <= state.view.end; t += step) {
      var ms = t <= lastIdx ? d.candles[Math.max(0, t)].openTime : d.lastClosed.openTime + (t - lastIdx) * d.barMs;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(fmtTime(ms), g.x(t) - 24, g.h - 6);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.left, PAD.top, g.plotW, g.plotH); ctx.clip();

    // cycle windows (shaded, opacity by agreement)
    if (overlayOn("cycles")) {
      d.calendar.forEach(function (c) {
        var x0 = g.x(c.fromIndex) - g.barW / 2;
        var x1 = g.x(c.toIndex) + g.barW / 2;
        ctx.fillStyle = "rgba(" + COLORS.cycle + "," + Math.min(0.28, 0.06 * c.sourceCount) + ")";
        ctx.fillRect(x0, PAD.top, Math.max(1, x1 - x0), g.plotH);
      });
    }
    if (overlayOn("box") && d.box) {
      d.box.prices.forEach(function (l) { hLine(g, l.price, COLORS.box, null, [2, 4]); });
      d.box.times.forEach(function (t2) { vLine(g, t2.index, COLORS.box, [2, 4]); });
    }
    if (overlayOn("square") && d.square) d.square.marks.forEach(function (m) { vLine(g, m.index, COLORS.square, [6, 3]); });
    if (overlayOn("sq144") && d.squareOf144) {
      d.squareOf144.prices.forEach(function (l) { hLine(g, l.price, COLORS.sq144, null, [1, 3]); });
      d.squareOf144.times.forEach(function (t3) { vLine(g, t3.index, COLORS.sq144, [1, 3]); });
    }
    if (overlayOn("fib")) d.fibonacci.forEach(function (f) { hLine(g, f.price, COLORS.fib, "Fib " + (f.ratio * 100).toFixed(1), [4, 4]); });
    if (overlayOn("sq9")) d.squareOfNine.fromPrice.levels.forEach(function (l) { hLine(g, l.price, COLORS.sq9, "SQ9 " + (l.degrees > 0 ? "+" : "") + l.degrees + "°", l.cardinal ? [] : [3, 3]); });

    // candles
    var bw = Math.max(1, g.barW * 0.7);
    for (var i = Math.max(0, Math.floor(state.view.start)); i <= Math.min(lastIdx, Math.ceil(state.view.end)); i += 1) {
      var c = d.candles[i];
      var cx = g.x(i);
      var color = c.close >= c.open ? COLORS.up : COLORS.down;
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, g.y(c.high)); ctx.lineTo(Math.round(cx) + 0.5, g.y(c.low)); ctx.stroke();
      var top = g.y(Math.max(c.open, c.close));
      ctx.fillRect(cx - bw / 2, top, bw, Math.max(1, g.y(Math.min(c.open, c.close)) - top));
    }

    if (overlayOn("vwap")) {
      var a = d.anchor;
      var pv = 0; var vol = 0;
      ctx.strokeStyle = COLORS.vwap; ctx.setLineDash([5, 3]); ctx.beginPath();
      for (var j = a.index; j <= lastIdx; j += 1) {
        var cj = d.candles[j];
        pv += (cj.high + cj.low + cj.close) / 3 * cj.volume; vol += cj.volume;
        if (vol <= 0) continue;
        var vy = g.y(pv / vol);
        if (j === a.index) ctx.moveTo(g.x(j), vy); else ctx.lineTo(g.x(j), vy);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }

    if (overlayOn("fan")) {
      var endIdx = state.view.end + 2;
      d.fan.forEach(function (line) {
        ctx.strokeStyle = line.name === "1x1" ? COLORS.oneByOne : COLORS.fan;
        ctx.lineWidth = line.name === "1x1" ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(g.x(line.anchorIndex), g.y(line.anchorPrice));
        var pe = G.fanPriceAt(line, endIdx);
        ctx.lineTo(g.x(endIdx), g.y(pe));
        ctx.stroke();
        // label where the line leaves the visible window
        var labIdx = Math.min(endIdx - 3, Math.max(line.anchorIndex + 2, state.view.end - 4 - 60 / g.barW));
        var lp = G.fanPriceAt(line, labIdx);
        if (lp > g.lo && lp < g.hi) { ctx.fillStyle = ctx.strokeStyle; ctx.fillText(line.name, g.x(labIdx) - 18, g.y(lp) - 3); }
      });
      ctx.lineWidth = 1;
    }

    if (overlayOn("pivots")) {
      d.pivots.forEach(function (pv2) {
        var px = g.x(pv2.index);
        var py = g.y(pv2.price) + (pv2.type === "high" ? -6 : 6);
        ctx.fillStyle = pv2.type === "high" ? COLORS.down : COLORS.up;
        ctx.beginPath();
        if (pv2.type === "high") { ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py - 4); ctx.lineTo(px, py + 1); }
        else { ctx.moveTo(px - 4, py + 4); ctx.lineTo(px + 4, py + 4); ctx.lineTo(px, py - 1); }
        ctx.fill();
      });
    }

    // anchor + last close
    ctx.strokeStyle = COLORS.anchor; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(g.x(d.anchor.index), g.y(d.anchor.price), 5, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    vLine(g, lastIdx + 0.5, "rgba(255,255,255,0.15)", [2, 2]);
    ctx.restore();
    hLine(g, d.lastClosed.close, "rgba(77,163,255,0.8)", null, [1, 2]);
    ctx.fillStyle = "#4da3ff";
    ctx.fillRect(PAD.left + g.plotW + 2, g.y(d.lastClosed.close) - 7, PAD.right - 4, 14);
    ctx.fillStyle = "#070a12";
    ctx.fillText(fmtPrice(d.lastClosed.close), PAD.left + g.plotW + 6, g.y(d.lastClosed.close) + 3);
  }

  // ---------------------------------------------------------------- interaction
  function zoom(factor, centerFrac) {
    if (!state.view || !state.data || !state.data.candles) return;
    var v = state.view;
    var span = v.end - v.start;
    var n = state.data.candles.length;
    var next = Math.min(Math.max(span * factor, 20), n + 120);
    var c = centerFrac == null ? 0.8 : centerFrac;
    var mid = v.start + span * c;
    v.start = mid - next * c;
    v.end = v.start + next;
    clampView();
    draw();
  }

  function clampView() {
    var v = state.view;
    var n = state.data.candles.length;
    var span = v.end - v.start;
    if (v.start < -10) { v.start = -10; v.end = v.start + span; }
    if (v.end > n + 140) { v.end = n + 140; v.start = v.end - span; }
  }

  var drag = null;
  els.canvas.addEventListener("pointerdown", function (e) {
    if (!state.view) return;
    els.canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, start: state.view.start, end: state.view.end, moved: false };
  });
  els.canvas.addEventListener("pointermove", function (e) {
    var d = state.data;
    if (!d || !d.ok || !d.candles) return;
    var rect = els.canvas.getBoundingClientRect();
    var g = geometry();
    if (drag) {
      var dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      var shift = dx / g.barW;
      state.view.start = drag.start - shift;
      state.view.end = drag.end - shift;
      clampView();
      draw();
      return;
    }
    var idx = g.idxAt(e.clientX - rect.left);
    var c = d.candles[idx];
    els.readout.textContent = c
      ? fmtTime(c.openTime) + "  O " + fmtPrice(c.open) + "  H " + fmtPrice(c.high) + "  L " + fmtPrice(c.low) + "  C " + fmtPrice(c.close)
      : "Projection · " + fmtTime(d.lastClosed.openTime + (idx - d.candles.length + 1) * d.barMs) + " · price " + fmtPrice(g.priceAt(e.clientY - rect.top));
  });
  els.canvas.addEventListener("pointerup", function (e) {
    var wasClick = drag && !drag.moved;
    drag = null;
    if (!wasClick || state.anchorMode !== "manual" || !state.data || !state.data.candles) return;
    var g = geometry();
    var idx = g.idxAt(e.clientX - els.canvas.getBoundingClientRect().left);
    var c = state.data.candles[idx];
    if (!c) return;
    state.anchorTime = c.openTime;
    savePrefs();
    load(false);
  });
  els.canvas.addEventListener("pointercancel", function () { drag = null; });
  els.canvas.addEventListener("wheel", function (e) {
    if (!state.view) return;
    e.preventDefault();
    var rect = els.canvas.getBoundingClientRect();
    var frac = Math.min(1, Math.max(0, (e.clientX - rect.left - PAD.left) / (rect.width - PAD.left - PAD.right)));
    zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, frac);
  }, { passive: false });
  $("gn-zoom-in").addEventListener("click", function () { zoom(1 / 1.3); });
  $("gn-zoom-out").addEventListener("click", function () { zoom(1.3); });
  $("gn-zoom-reset").addEventListener("click", function () { resetView(); draw(); });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 80);
  });

  // ---------------------------------------------------------------- controls
  function syncControls() {
    els.symbol.value = state.symbol;
    els.anchorMode.value = state.anchorMode;
    els.anchorSide.value = state.anchorSide;
    els.scaleMode.value = state.scaleMode;
    els.scaleValue.value = state.scaleValue;
    els.scaleValue.hidden = state.scaleMode !== "manual";
    els.sq9Step.value = state.sq9Step;
    els.wrap.classList.toggle("is-manual", state.anchorMode === "manual");
    Array.prototype.forEach.call(els.tfs.querySelectorAll("button"), function (b) {
      var on = b.getAttribute("data-tf") === state.timeframe;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    Array.prototype.forEach.call(els.overlays.querySelectorAll("input"), function (box) {
      var k = box.getAttribute("data-overlay");
      if (Object.prototype.hasOwnProperty.call(state.overlays, k)) box.checked = Boolean(state.overlays[k]);
    });
  }

  function onChange(fn) {
    return function () { fn.apply(this, arguments); savePrefs(); syncControls(); load(false); };
  }

  els.symbol.addEventListener("change", onChange(function () { state.symbol = els.symbol.value; state.anchorTime = null; state.view = null; }));
  els.tfs.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tf]");
    if (!b) return;
    state.timeframe = b.getAttribute("data-tf");
    state.anchorTime = null;
    state.view = null;
    savePrefs(); syncControls(); load(false);
  });
  els.anchorMode.addEventListener("change", onChange(function () {
    state.anchorMode = els.anchorMode.value;
    if (state.anchorMode === "manual" && state.anchorTime == null && state.data && state.data.anchor) state.anchorTime = state.data.anchor.time;
  }));
  els.anchorSide.addEventListener("change", onChange(function () { state.anchorSide = els.anchorSide.value; }));
  els.scaleMode.addEventListener("change", onChange(function () { state.scaleMode = els.scaleMode.value; }));
  els.scaleValue.addEventListener("change", onChange(function () { state.scaleValue = els.scaleValue.value; }));
  els.sq9Step.addEventListener("change", onChange(function () { state.sq9Step = els.sq9Step.value; }));
  els.refresh.addEventListener("click", function () { load(true); });
  els.overlays.addEventListener("change", function (e) {
    var k = e.target.getAttribute("data-overlay");
    if (!k) return;
    state.overlays[k] = e.target.checked;
    savePrefs();
    draw();
  });
  els.screenerRun.addEventListener("click", runScreener);
  els.backtestRun.addEventListener("click", runBacktest);
  els.sq9Form.addEventListener("input", renderSq9Calc);
  els.sq9Form.addEventListener("submit", function (e) { e.preventDefault(); renderSq9Calc(); });

  function init() {
    loadPrefs();
    getJson("/api/gann/meta").then(function (meta) {
      els.symbol.innerHTML = meta.symbols.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s.replace(/USDT$/, "/USDT")) + "</option>"; }).join("");
      if (meta.symbols.indexOf(state.symbol) === -1) state.symbol = meta.symbols[0];
      if (meta.timeframes.indexOf(state.timeframe) === -1) state.timeframe = "4h";
      syncControls();
      load(false);
    }).catch(function (err) {
      setChartState("Gann service unavailable: " + err.message, true);
      renderEmptyCards("Unavailable: " + err.message);
    });
  }

  init();
})();
