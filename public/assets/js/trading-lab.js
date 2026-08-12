(function () {
  "use strict";

  var notice = document.getElementById("tl-notice");
  var updatedEl = document.getElementById("tl-updated");
  var modeEl = document.getElementById("tl-mode");
  var bookSelect = document.getElementById("tl-book");
  var intervalSelect = document.getElementById("tl-interval");
  var refreshBtn = document.getElementById("tl-refresh-btn");
  var markBtn = document.getElementById("tl-mark-btn");
  var statsEl = document.getElementById("tl-stats");
  var positionsTbody = document.getElementById("tl-positions-tbody");
  var candidatesTbody = document.getElementById("tl-candidates-tbody");
  var signalActionsTbody = document.getElementById("tl-signal-actions-tbody");
  var scannerEl = document.getElementById("tl-scanner");
  var metricsEl = document.getElementById("tl-metrics");
  var historyTbody = document.getElementById("tl-history-tbody");
  var btSymbol = document.getElementById("tl-bt-symbol");
  var btInterval = document.getElementById("tl-bt-interval");
  var btStrategy = document.getElementById("tl-bt-strategy");
  var btStrategyNote = document.getElementById("tl-bt-strategy-note");
  var btRunBtn = document.getElementById("tl-bt-run");
  var btCompareBtn = document.getElementById("tl-bt-compare");
  var btResult = document.getElementById("tl-bt-result");
  var btCompareResult = document.getElementById("tl-bt-compare-result");
  var strategies = [];

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtPrice(px) {
    if (px == null || px === "") return "—";
    var n = Number(px);
    if (!isFinite(n)) return "—";
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(6);
  }

  function fmtUsd(value) {
    if (value == null) return "—";
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function pnlClass(value) {
    var n = Number(value);
    if (!isFinite(n) || n === 0) return "tl-flat";
    return n > 0 ? "tl-up" : "tl-down";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }

  function showError(message) {
    notice.style.display = "block";
    notice.innerHTML = "&#9888;&#65039; " + escapeHtml(message);
  }

  function clearError() {
    notice.style.display = "none";
    notice.textContent = "";
  }

  function currentBook() {
    return bookSelect.value || "main";
  }

  function decisionClass(decision) {
    if (decision === "SKIP" || decision === "BLOCK") return "tl-badge tl-badge--skip";
    if (decision === "REDUCE" || decision === "TAKE_QUARTER" || decision === "TAKE_HALF") return "tl-badge tl-badge--reduce";
    return "tl-badge tl-badge--take";
  }

  function reasonsTitle(reasons) {
    return escapeHtml((reasons || []).join("\n"));
  }

  /* ── Overview + stats ──────────────────────────────────── */

  function statTile(label, value, cls) {
    return (
      '<div class="tl-stat"><div class="tl-stat-label">' + escapeHtml(label) + "</div>" +
      '<div class="tl-stat-value ' + (cls || "") + '">' + value + "</div></div>"
    );
  }

  function renderStats(book) {
    var s = book.stats;
    var m = s.riskMetrics || {};
    statsEl.innerHTML =
      statTile("Equity", "$" + Number(s.equity).toLocaleString(undefined, { maximumFractionDigits: 2 })) +
      statTile("Net P&L", fmtUsd(s.realizedPnl), pnlClass(s.realizedPnl)) +
      statTile("Unrealized", fmtUsd(s.unrealizedPnl), pnlClass(s.unrealizedPnl)) +
      statTile("Win rate", s.totalTrades ? s.winRate + "%" : "—") +
      statTile("Expectancy", m.closedTrades ? (m.expectancyR > 0 ? "+" : "") + m.expectancyR + "R" : "—", pnlClass(m.expectancyR)) +
      // A null profit factor means wins and no losses yet, not "excellent".
      statTile("Profit factor", m.profitFactor == null ? (m.closedTrades ? "∞" : "—") : m.profitFactor) +
      statTile("Max drawdown", m.closedTrades ? m.maxDrawdownPct + "%" : "—") +
      statTile("Trades", s.totalTrades + " closed / " + s.openPositions + " open") +
      statTile("Daily P&L", fmtUsd(s.dailyPnl), pnlClass(s.dailyPnl)) +
      statTile("Weekly P&L", fmtUsd(s.weeklyPnl), pnlClass(s.weeklyPnl));
  }

  function renderPositions(positions) {
    var open = (positions || []).filter(function (p) { return p.status === "open"; });
    if (!open.length) {
      positionsTbody.innerHTML = '<tr><td colspan="11" class="de-empty">No open positions.</td></tr>';
      return;
    }
    positionsTbody.innerHTML = open
      .map(function (p) {
        return (
          "<tr>" +
          "<td>" + escapeHtml(p.symbol) + "</td>" +
          '<td class="' + (p.direction === "LONG" ? "tl-up" : "tl-down") + '">' + escapeHtml(p.direction) + "</td>" +
          "<td>" + fmtPrice(p.entryPrice) + "</td>" +
          "<td>" + fmtPrice(p.currentPrice) + "</td>" +
          "<td>" + p.remainingSize + (p.tp1Hit ? " <span class='tl-tag'>TP1 taken</span>" : "") + "</td>" +
          "<td>" + fmtPrice(p.stopLoss) + (p.tp1Hit ? " <span class='tl-tag'>BE</span>" : "") + "</td>" +
          "<td>" + fmtPrice(p.tp1) + "</td>" +
          "<td>" + fmtPrice(p.tp2) + "</td>" +
          '<td class="' + pnlClass(p.realizedPnl) + '">' + fmtUsd(p.realizedPnl) + "</td>" +
          '<td class="' + pnlClass(p.unrealizedPnl) + '">' + fmtUsd(p.unrealizedPnl) + "</td>" +
          '<td><button class="tl-close-btn" type="button" data-id="' + escapeHtml(p.id) + '">Close</button></td>' +
          "</tr>"
        );
      })
      .join("");
  }

  function renderCandidates(data) {
    var rows = (data && data.candidates) || [];
    if (!rows.length) {
      candidatesTbody.innerHTML = '<tr><td colspan="12" class="de-empty">No execution plans from the Decision Engine right now.</td></tr>';
      return;
    }
    candidatesTbody.innerHTML = rows
      .map(function (row) {
        var t = row.trade || {};
        var canOpen = t.ok === true;
        return (
          '<tr title="' + reasonsTitle(row.reasons) + '">' +
          "<td>" + escapeHtml(row.symbol) + "</td>" +
          '<td class="' + (row.signal === "LONG" ? "tl-up" : "tl-down") + '">' + escapeHtml(row.signal) + "</td>" +
          "<td>" + (row.setupScore == null ? "—" : row.setupScore) + "</td>" +
          '<td><span class="' + decisionClass(row.decision) + '">' + escapeHtml(row.decision) + "</span> " + row.confidenceScore + "</td>" +
          '<td><span class="' + decisionClass(row.edgeDecision) + '">' + escapeHtml(row.edgeDecision) + "</span></td>" +
          "<td>" + (row.sizeMultiplier ? row.sizeMultiplier.toFixed(2) + "x" : "—") + "</td>" +
          "<td>" + fmtPrice(row.plan && row.plan.trigger) + "</td>" +
          "<td>" + fmtPrice(t.stopLoss) + "</td>" +
          "<td>" + fmtPrice(t.tp1) + "</td>" +
          "<td>" + fmtPrice(t.tp2) + "</td>" +
          "<td>" + (t.riskUsd == null ? "—" : "$" + t.riskUsd) + "</td>" +
          "<td>" +
          (canOpen
            ? '<button class="tl-open-btn" type="button" data-symbol="' + escapeHtml(row.symbol) +
              '" data-direction="' + escapeHtml(row.signal) +
              '" data-entry="' + escapeHtml(String(t.entryPrice)) +
              '" data-atr="' + escapeHtml(String((row.plan && row.plan.atr) || "")) + '">Paper trade</button>'
            : "—") +
          "</td></tr>"
        );
      })
      .join("");
  }

  function renderSignalActions(data) {
    var rows = (data && data.items) || [];
    if (!rows.length) {
      signalActionsTbody.innerHTML = '<tr><td colspan="10" class="de-empty">No Signal Bot bridge actions recorded yet.</td></tr>';
      return;
    }
    signalActionsTbody.innerHTML = rows
      .map(function (row) {
        var statusClass = row.status === "opened" ? "tl-badge--take" :
          row.status === "dry-run" ? "tl-badge--reduce" : "tl-badge--skip";
        return (
          "<tr>" +
          "<td>" + fmtTime(row.timestamp) + "</td>" +
          "<td>" + escapeHtml(row.symbol) + "</td>" +
          "<td>" + escapeHtml(row.interval) + "</td>" +
          '<td class="' + (row.direction === "LONG" ? "tl-up" : "tl-down") + '">' + escapeHtml(row.direction) + "</td>" +
          '<td><span class="tl-badge ' + statusClass + '">' + escapeHtml(row.status) + "</span></td>" +
          "<td>" + escapeHtml(row.book) + "</td>" +
          "<td>" + fmtPrice(row.entryPrice) + "</td>" +
          "<td>" + (row.confidenceScore == null ? "&mdash;" : row.confidenceScore) + "</td>" +
          "<td>" + (row.sizeMultiplier == null ? "&mdash;" : Number(row.sizeMultiplier).toFixed(2) + "x") + "</td>" +
          "<td>" + escapeHtml(row.reason) + "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  // Live scanner health: enabled, last scan, last candle, last signal, last
  // error — the five things that answer "is it actually running?" without
  // needing the server logs.
  function renderScanner(data) {
    if (!scannerEl) return;
    if (!data || !data.configured) {
      scannerEl.innerHTML = '<div class="de-empty">Live scanner is not configured.</div>';
      return;
    }

    var stateLabel = data.enabled ? (data.running ? "Running" : "Enabled (loop not started)") : "Disabled";
    var stateClass = data.enabled && data.running ? "tl-up" : data.enabled ? "" : "tl-flat";
    var signal = data.lastSignal;
    var candle = data.lastCandle;
    var signalClass = !signal ? "" : signal.signal === "LONG" ? "tl-up" : signal.signal === "SHORT" ? "tl-down" : "tl-flat";

    var tiles =
      statTile("State", escapeHtml(stateLabel), stateClass) +
      statTile("Symbol", escapeHtml(data.symbol) + " &middot; " + escapeHtml(data.timeframe)) +
      statTile("Strategy", escapeHtml(data.strategy)) +
      statTile("Mode", data.paperTradeEnabled ? "Paper trading" : "Dry run", data.paperTradeEnabled ? "tl-up" : "tl-flat") +
      statTile("Last scan", fmtTime(data.lastScanAt)) +
      statTile("Last candle close", candle ? fmtTime(candle.closedAt) : "&mdash;") +
      statTile("Last candle price", candle ? fmtPrice(candle.close) : "&mdash;") +
      statTile("Last signal", signal ? escapeHtml(signal.signal) : "&mdash;", signalClass) +
      statTile("Scans", data.scanCount + " / " + data.errorCount + " errors", data.errorCount ? "tl-down" : "") +
      statTile("Last action", data.lastAction ? escapeHtml(data.lastAction.status) : "&mdash;");

    var detail = "";
    if (signal && signal.indicators) {
      var ind = signal.indicators;
      detail +=
        '<div class="de-card-note">EMA20 ' + fmtPrice(ind.ema20) + " &middot; EMA50 " + fmtPrice(ind.ema50) +
        " &middot; RSI " + Number(ind.rsi).toFixed(1) + " &middot; trend " + escapeHtml(ind.trend) +
        " &middot; ATR " + fmtPrice(ind.atr) + "</div>";
    }
    if (signal && signal.error) {
      detail += '<div class="de-card-note">' + escapeHtml(signal.error) + "</div>";
    }
    if (data.lastAction) {
      detail += '<div class="de-card-note">Last action: ' + escapeHtml(data.lastAction.reason) + "</div>";
    }
    if (data.lastError) {
      detail +=
        '<div class="de-card-note tl-down">Last error (' + fmtTime(data.lastErrorAt) + "): " +
        escapeHtml(data.lastError) + "</div>";
    }

    scannerEl.innerHTML = '<div class="tl-stat-grid">' + tiles + "</div>" + detail;
  }

  function renderMetrics(data) {
    var groups = (data && data.groups) || {};
    var names = { strategy: "By strategy", symbol: "By symbol", scoreBucket: "By setup score" };
    var html = Object.keys(names)
      .map(function (dim) {
        var rows = groups[dim] || [];
        if (!rows.length) return "";
        return (
          '<div class="tl-metric-group"><div class="tl-metric-title">' + names[dim] + "</div>" +
          '<div class="de-table-wrap"><table class="de-table"><thead><tr>' +
          "<th>Key</th><th>Trades</th><th>Expectancy</th><th>PF</th><th>Net</th><th>Max DD</th><th>Worst streak</th>" +
          "</tr></thead><tbody>" +
          rows
            .map(function (r) {
              return (
                "<tr><td>" + escapeHtml(r.key) + "</td>" +
                "<td>" + r.closedTrades + "</td>" +
                '<td class="' + pnlClass(r.expectancyR) + '">' + (r.expectancyR > 0 ? "+" : "") + r.expectancyR + "R</td>" +
                "<td>" + (r.profitFactor == null ? "∞" : r.profitFactor) + "</td>" +
                '<td class="' + pnlClass(r.netReturnUsd) + '">' + fmtUsd(r.netReturnUsd) + "</td>" +
                "<td>" + r.maxDrawdownPct + "%</td>" +
                "<td>" + r.worstConsecutiveLosses + "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div></div>"
        );
      })
      .join("");
    metricsEl.innerHTML = html || '<div class="de-empty">No closed trades yet — metrics appear once trades finish.</div>';
  }

  function renderHistory(items) {
    if (!items || !items.length) {
      historyTbody.innerHTML = '<tr><td colspan="10" class="de-empty">No closed trades yet.</td></tr>';
      return;
    }
    historyTbody.innerHTML = items
      .map(function (t) {
        var exits = (t.exits || [])
          .map(function (e) { return e.reason + " @ " + fmtPrice(e.price); })
          .join(", ");
        return (
          "<tr>" +
          "<td>" + fmtTime(t.closedAt) + "</td>" +
          "<td>" + escapeHtml(t.symbol) + "</td>" +
          '<td class="' + (t.direction === "LONG" ? "tl-up" : "tl-down") + '">' + escapeHtml(t.direction) + "</td>" +
          "<td>" + fmtPrice(t.entryPrice) + "</td>" +
          "<td>" + fmtPrice(t.exitPrice) + "</td>" +
          "<td>" + escapeHtml(t.closeReason) + "</td>" +
          '<td title="' + escapeHtml(exits) + '">' + (t.exits || []).length + "</td>" +
          '<td class="' + pnlClass(t.pnl) + '">' + fmtUsd(t.pnl) + "</td>" +
          '<td class="' + pnlClass(t.rMultiple) + '">' + (t.rMultiple > 0 ? "+" : "") + t.rMultiple + "R</td>" +
          "<td>" + (t.confidenceScore == null ? "—" : t.confidenceScore) + "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  /* ── Loading ───────────────────────────────────────────── */

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function loadOverview() {
    return getJson("/api/trading-lab").then(function (data) {
      if (!bookSelect.options.length) {
        bookSelect.innerHTML = data.books
          .map(function (b) { return '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + "</option>"; })
          .join("");
      }
      modeEl.textContent = data.mode === "live" ? "LIVE" : "PAPER";
      modeEl.className = "tl-mode " + (data.mode === "live" ? "tl-mode--live" : "tl-mode--paper");
      updatedEl.textContent = "Updated " + fmtTime(data.updatedAt);

      var book = data.books.filter(function (b) { return b.id === currentBook(); })[0] || data.books[0];
      renderStats(book);
      renderPositions(book.openPositions);
    });
  }

  function loadBookDetail() {
    var book = encodeURIComponent(currentBook());
    return Promise.all([
      getJson("/api/trading-lab/metrics?book=" + book).then(renderMetrics),
      getJson("/api/trading-lab/history?book=" + book + "&limit=50").then(function (d) { renderHistory(d.items); }),
      getJson("/api/trading-lab/signal-actions?limit=25").then(renderSignalActions),
      // The scanner panel is independent of the book: a failure to read it
      // must not blank the metrics and history alongside it.
      getJson("/api/live-scanner/status")
        .then(renderScanner)
        .catch(function (err) {
          if (scannerEl) {
            scannerEl.innerHTML = '<div class="de-empty">Could not read scanner status: ' + escapeHtml(err.message) + "</div>";
          }
        }),
    ]);
  }

  function loadCandidates() {
    candidatesTbody.innerHTML = '<tr><td colspan="12" class="de-empty">Scoring Decision Engine plans&hellip;</td></tr>';
    return getJson(
      "/api/trading-lab/decision-candidates?interval=" +
        encodeURIComponent(intervalSelect.value) +
        "&book=" + encodeURIComponent(currentBook()),
    )
      .then(renderCandidates)
      .catch(function (err) {
        candidatesTbody.innerHTML =
          '<tr><td colspan="12" class="de-empty">Could not score plans: ' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  function refresh() {
    clearError();
    refreshBtn.disabled = true;
    return loadOverview()
      .then(loadBookDetail)
      .then(loadCandidates)
      .catch(function (err) { showError(err.message); })
      .then(function () { refreshBtn.disabled = false; });
  }

  /* ── Actions (admin-gated) ─────────────────────────────── */

  function postAdmin(url, body) {
    return window.AdminKey.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      });
    });
  }

  /* ── Backtest ──────────────────────────────────────────── */

  // A compact inline equity curve. No chart library on this page, and one
  // polyline says everything a sparkline needs to.
  function equitySparkline(curve) {
    if (!curve || curve.length < 2) return "";
    var values = curve.map(function (p) { return p.equity; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;
    var width = 600;
    var height = 60;
    var points = values
      .map(function (v, i) {
        var x = (i / (values.length - 1)) * width;
        var y = height - ((v - min) / span) * height;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    var up = values[values.length - 1] >= values[0];
    return (
      '<svg class="tl-spark" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" ' +
      'role="img" aria-label="Equity curve">' +
      '<polyline fill="none" stroke-width="2" points="' + points + '" ' +
      'stroke="' + (up ? "#00e676" : "#ff5252") + '" /></svg>'
    );
  }

  // The backtester applies fees, slippage and funding inside the paper trader
  // (see BACKTEST_* env vars). They default to zero, and a zero-cost run read
  // as a realistic one is exactly the mistake this line exists to prevent —
  // so say which assumptions produced the numbers above them, every time.
  function pct(rate) {
    return (Number(rate) * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") + "%";
  }

  function costsLine(costs) {
    if (!costs) return "";
    if (costs.gasUsd != null) {
      return '<div class="tl-bt-meta tl-bt-costs">Event costs applied: gas $' + escapeHtml(costs.gasUsd) +
        " &middot; slippage " + pct(costs.slippagePct) +
        " &middot; MEV " + pct(costs.mevPenaltyPct) +
        " &middot; failed tx " + pct(costs.failedTxPct) + "</div>";
    }
    var free =
      !Number(costs.takerFeeRate) && !Number(costs.slippageRate) && !Number(costs.fundingRate8h);
    if (free) {
      return '<div class="tl-bt-meta tl-bt-costs">&#9888;&#65039; Frictionless run: no fees, slippage or funding applied. ' +
        "Set BACKTEST_TAKER_FEE_RATE, BACKTEST_SLIPPAGE_RATE and BACKTEST_FUNDING_RATE_8H for realistic costs.</div>";
    }
    return '<div class="tl-bt-meta tl-bt-costs">Costs applied: taker fee ' + pct(costs.takerFeeRate) +
      " · slippage " + pct(costs.slippageRate) +
      " · funding " + pct(costs.fundingRate8h) + " per 8h</div>";
  }

  function renderBacktest(data) {
    if (data.status === "insufficient-data") {
      btResult.innerHTML =
        '<div class="de-empty">Insufficient event-replay data for ' +
        escapeHtml(data.strategyName || data.strategy) +
        ". " +
        escapeHtml((data.dataset && data.dataset.reason) || "Historical point-in-time candidate snapshots are not available.") +
        "</div>" +
        '<div class="tl-bt-meta">Dataset: ' +
        escapeHtml((data.dataset && data.dataset.source) || data.dataSource || "not configured") +
        " &middot; no candle-only performance was calculated</div>";
      return;
    }
    var s = data.stats;
    var m = s.riskMetrics || {};
    var tiles =
      statTile("Net P&L", fmtUsd(s.realizedPnl), pnlClass(s.realizedPnl)) +
      statTile("Closed trades", m.closedTrades || 0) +
      statTile("Win rate", s.totalTrades ? s.winRate + "%" : "—") +
      statTile("Expectancy", m.closedTrades ? (m.expectancyR > 0 ? "+" : "") + m.expectancyR + "R" : "—", pnlClass(m.expectancyR)) +
      statTile("Profit factor", m.profitFactor == null ? (m.closedTrades ? "∞" : "—") : m.profitFactor) +
      statTile("Max drawdown", m.closedTrades ? m.maxDrawdownPct + "%" : "—") +
      statTile("Worst streak", m.worstConsecutiveLosses || 0) +
      statTile("Refused", (data.skipped || []).length);

    var caveats = (data.caveats || []).concat(
      data.openAtEnd && data.openAtEnd.length
        ? [data.openAtEnd.length + " position(s) still open at the end — excluded from closed-trade stats rather than force-closed"]
        : [],
    );

    btResult.innerHTML =
      '<div class="tl-stat-grid">' + tiles + "</div>" +
      equitySparkline(data.equityCurve) +
      '<div class="tl-bt-meta">' +
      escapeHtml(data.strategyName || data.strategy || "—") +
      " (" + escapeHtml(data.strategy || "—") + ")" +
      " · " + escapeHtml(data.symbol) + " " + escapeHtml(data.interval) +
      " · " + data.bars + " bars (" + data.warmupBars + " warmup)" +
      " · " + fmtTime(data.from) + " → " + fmtTime(data.to) +
      "</div>" +
      costsLine(data.costs) +
      (caveats.length
        ? '<div class="de-warnings" style="display:block">' +
          caveats.map(function (c) { return "<div>" + escapeHtml(c) + "</div>"; }).join("") +
          "</div>"
        : "");
  }

  // The catalogue is public, so the selector fills in on page load whether or
  // not an admin key has been entered. A failure here leaves the selector with
  // the default option rather than blocking the card.
  function loadStrategies() {
    return fetch("/api/trading-lab/strategies")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        strategies = (data && data.strategies) || [];
        if (!strategies.length) return;
        btStrategy.innerHTML = strategies
          .map(function (s) {
            var selected = s.id === data.default ? " selected" : "";
            var suffix = s.supportsEventReplay ? " (event replay)" : "";
            return '<option value="' + escapeHtml(s.id) + '"' + selected + ">" + escapeHtml(s.name + suffix) + "</option>";
          })
          .join("");
        renderStrategyNote();
      })
      .catch(function () {
        btStrategy.innerHTML = '<option value="mindset_v1" selected>Mindset v1</option>';
      });
  }

  function selectedStrategy() {
    return btStrategy.value || "mindset_v1";
  }

  function renderStrategyNote() {
    var found = strategies.filter(function (s) { return s.id === selectedStrategy(); })[0];
    btStrategyNote.textContent = found
      ? found.description +
        (found.supportsEventReplay
          ? " Dataset: " + ((found.datasetAvailability && found.datasetAvailability.productionStatus) || "event snapshots required") + "."
          : " Needs " + found.requiredWarmupBars + " warmup bars.")
      : "";
  }

  function compareCell(value, className) {
    return '<td class="' + (className || "") + '">' + value + "</td>";
  }

  function renderComparison(data) {
    var rows = (data && data.results) || [];
    if (!rows.length) {
      btCompareResult.innerHTML = '<div class="de-empty">No strategies to compare.</div>';
      return;
    }

    var body = rows
      .map(function (r) {
        return (
          "<tr>" +
          "<td>" + escapeHtml(r.strategyName || r.strategy) + "<br /><small>" + escapeHtml(r.strategy) + "</small></td>" +
          compareCell(r.bars + " <small>(" + r.warmupBars + " warmup)</small>") +
          compareCell(r.status === "insufficient-data" ? "insufficient data" : escapeHtml(r.replayType || "candle")) +
          compareCell(r.signals) +
          compareCell(r.closedTrades) +
          compareCell(fmtUsd(r.netPnlUsd), pnlClass(r.netPnlUsd)) +
          compareCell(r.closedTrades ? (r.expectancyR > 0 ? "+" : "") + r.expectancyR + "R" : "—", pnlClass(r.expectancyR)) +
          compareCell(r.profitFactor == null ? (r.closedTrades ? "∞" : "—") : r.profitFactor) +
          compareCell(r.closedTrades ? r.maxDrawdownPct + "%" : "—") +
          compareCell(r.closedTrades ? r.winRate + "%" : "—") +
          compareCell(r.worstLossStreak) +
          "</tr>"
        );
      })
      .join("");

    btCompareResult.innerHTML =
      '<div class="de-table-wrap"><table class="de-table"><thead><tr>' +
      "<th>Strategy</th><th>Bars</th><th>Replay</th><th>Signals</th><th>Closed</th><th>Net P&amp;L</th>" +
      "<th>Expectancy</th><th>Profit factor</th><th>Max DD</th><th>Win rate</th><th>Worst streak</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      '<div class="tl-bt-meta">' + escapeHtml(data.symbol) + " " + escapeHtml(data.interval) +
      " · ranked by expectancy, then profit factor, then drawdown · " + fmtTime(data.ranAt) +
      " · backtest only, the live scanner is unaffected</div>" +
      costsLine(rows[0] && rows[0].costs);
  }

  btStrategy.addEventListener("change", renderStrategyNote);

  btCompareBtn.addEventListener("click", function () {
    var symbol = (btSymbol.value || "").trim().toUpperCase();
    if (!symbol) {
      showError("Enter a symbol to compare.");
      return;
    }
    btCompareBtn.disabled = true;
    btCompareResult.innerHTML = '<div class="de-empty">Replaying every strategy&hellip;</div>';
    postAdmin("/api/trading-lab/backtest/compare", {
      symbol: symbol,
      interval: btInterval.value,
      strategies: strategies.map(function (s) { return s.id; }),
    })
      .then(renderComparison)
      .catch(function (err) {
        btCompareResult.innerHTML = '<div class="de-empty">Comparison failed: ' + escapeHtml(err.message) + "</div>";
      })
      .then(function () { btCompareBtn.disabled = false; });
  });

  btRunBtn.addEventListener("click", function () {
    var symbol = (btSymbol.value || "").trim().toUpperCase();
    if (!symbol) {
      showError("Enter a symbol to backtest.");
      return;
    }
    btRunBtn.disabled = true;
    btResult.innerHTML = '<div class="de-empty">Replaying bars&hellip;</div>';
    postAdmin("/api/trading-lab/backtest", {
      symbol: symbol,
      interval: btInterval.value,
      strategy: selectedStrategy(),
    })
      .then(renderBacktest)
      .catch(function (err) {
        btResult.innerHTML = '<div class="de-empty">Backtest failed: ' + escapeHtml(err.message) + "</div>";
      })
      .then(function () { btRunBtn.disabled = false; });
  });

  refreshBtn.addEventListener("click", refresh);
  bookSelect.addEventListener("change", refresh);
  intervalSelect.addEventListener("change", loadCandidates);

  markBtn.addEventListener("click", function () {
    markBtn.disabled = true;
    postAdmin("/api/trading-lab/mark", { book: currentBook() })
      .then(function (data) {
        if (data.events && data.events.length) {
          clearError();
          notice.style.display = "block";
          notice.innerHTML =
            "&#9989; " +
            data.events
              .map(function (e) { return escapeHtml(e.type + " on " + e.symbol); })
              .join(", ");
        }
        return refresh();
      })
      .catch(function (err) { showError(err.message); })
      .then(function () { markBtn.disabled = false; });
  });

  positionsTbody.addEventListener("click", function (event) {
    var btn = event.target.closest(".tl-close-btn");
    if (!btn) return;
    btn.disabled = true;
    postAdmin("/api/trading-lab/positions/" + encodeURIComponent(btn.dataset.id) + "/close", {
      book: currentBook(),
      reason: "MANUAL",
    })
      .then(refresh)
      .catch(function (err) { showError(err.message); btn.disabled = false; });
  });

  candidatesTbody.addEventListener("click", function (event) {
    var btn = event.target.closest(".tl-open-btn");
    if (!btn) return;
    btn.disabled = true;
    postAdmin("/api/trading-lab/positions", {
      book: currentBook(),
      symbol: btn.dataset.symbol,
      direction: btn.dataset.direction,
      entryPrice: Number(btn.dataset.entry),
      atr: btn.dataset.atr ? Number(btn.dataset.atr) : null,
      signalSource: "decision-engine",
    })
      .then(function (data) {
        if (!data.opened) showError("Not opened: " + (data.reasons || []).join(" · "));
        return refresh();
      })
      .catch(function (err) { showError(err.message); btn.disabled = false; });
  });

  loadStrategies();
  refresh();
})();
