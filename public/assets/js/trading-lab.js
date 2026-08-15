(function () {
  "use strict";

  var notice = document.getElementById("tl-notice");
  var updatedEl = document.getElementById("tl-updated");
  var modeEl = document.getElementById("tl-mode");
  var selectedAccountEl = document.getElementById("tl-selected-account");
  var intervalSelect = document.getElementById("tl-interval");
  var refreshBtn = document.getElementById("tl-refresh-btn");
  var markBtn = document.getElementById("tl-mark-btn");
  var legacyBooksEl = document.getElementById("tl-legacy-books");
  var positionsTbody = document.getElementById("tl-positions-tbody");
  var candidatesTbody = document.getElementById("tl-candidates-tbody");
  var signalActionsTbody = document.getElementById("tl-signal-actions-tbody");
  var scannerEl = document.getElementById("tl-scanner");
  var metricsEl = document.getElementById("tl-metrics");
  var strategyAccountsEl = document.getElementById("tl-strategy-accounts");
  var activityShell = document.getElementById("tl-activity-shell");
  var activityTitle = document.getElementById("tl-activity-title");
  var activityContent = document.getElementById("tl-activity-content");
  var regimeEl = document.getElementById("tl-regime");
  var regimeMatrixEl = document.getElementById("tl-regime-matrix");
  var regimeSymbol = document.getElementById("tl-regime-symbol");
  var regimeInterval = document.getElementById("tl-regime-interval");
  var regimeBtn = document.getElementById("tl-regime-btn");
  var regimeMin = document.getElementById("tl-regime-min");
  var historyTbody = document.getElementById("tl-history-tbody");
  var btSymbol = document.getElementById("tl-bt-symbol");
  var btInterval = document.getElementById("tl-bt-interval");
  var btStrategy = document.getElementById("tl-bt-strategy");
  var btStrategyNote = document.getElementById("tl-bt-strategy-note");
  var btMode = document.getElementById("tl-bt-mode");
  var btRunBtn = document.getElementById("tl-bt-run");
  var btCompareBtn = document.getElementById("tl-bt-compare");
  var btResult = document.getElementById("tl-bt-result");
  var btCompareResult = document.getElementById("tl-bt-compare-result");
  var strategies = [];
  var strategyAccounts = [];
  var selectedStrategyId = "mindset_v1";

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

  // Date only. A chart axis on a phone has room for "1/1/2026" and not for
  // "1/1/2026, 12:00:00 AM", and the time of day is noise on a run measured
  // in months.
  function fmtDay(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
  }

  function showError(message) {
    notice.style.display = "block";
    notice.innerHTML = "&#9888;&#65039; " + escapeHtml(message);
  }

  function clearError() {
    notice.style.display = "none";
    notice.textContent = "";
  }

  function currentStrategy() {
    return selectedStrategyId || "mindset_v1";
  }

  function fmtAgo(iso) {
    if (!iso) return "never";
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "unknown";
    if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + " sec ago";
    if (ms < 3600000) return Math.round(ms / 60000) + " min ago";
    return Math.round(ms / 3600000) + " hr ago";
  }

  function statusLabel(value) {
    return String(value || "UNKNOWN").replace(/_/g, " ");
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

  // `window` is one book's history slice: { items, openingBalance, truncated }.
  //
  // The curve starts at the balance BEFORE that slice, not at the account's
  // original starting balance. Those are the same number only while the whole
  // history fits in the requested window — past that (80 trades today),
  // starting from the original balance redraws the account as if the earlier
  // trades never happened, then jumps to current equity at the right-hand
  // edge. The chart looked plausible and was wrong.
  function performanceSparkline(book, window) {
    var stats = book.stats || {};
    var history = (window && window.items) || [];
    var opening = window && isFinite(Number(window.openingBalance))
      ? Number(window.openingBalance)
      : Number(stats.startingBalance) || 0;
    var equity = Number(stats.equity);
    var points = [{ at: "start", equity: opening }];
    var running = opening;

    (history || [])
      .slice()
      .reverse()
      .forEach(function (trade) {
        var pnl = Number(trade.pnl != null ? trade.pnl : trade.realizedPnl);
        if (!isFinite(pnl)) return;
        running += pnl;
        points.push({ at: trade.closedAt || trade.closed_at || "", equity: running });
      });

    if (isFinite(equity) && (!points.length || points[points.length - 1].equity !== equity)) {
      points.push({ at: "now", equity: equity });
    }
    if (points.length < 2) points.push({ at: "now", equity: opening });

    var values = points.map(function (p) { return Number(p.equity) || 0; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || Math.max(Math.abs(max), 1);
    var width = 320;
    var height = 84;
    var poly = values
      .map(function (value, i) {
        var x = values.length === 1 ? width : (i / (values.length - 1)) * width;
        var y = height - ((value - min) / span) * (height - 10) - 5;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    var up = values[values.length - 1] >= values[0];
    return (
      '<svg class="tl-account-graph" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" ' +
      'role="img" aria-label="' + escapeHtml(book.name || book.id) + ' account performance">' +
      '<line x1="0" y1="' + (height - 5) + '" x2="' + width + '" y2="' + (height - 5) + '" />' +
      '<polyline fill="none" stroke-width="3" points="' + poly + '" ' +
      'stroke="' + (up ? "#00e676" : "#ff5252") + '" /></svg>'
    );
  }

  function accountMetric(label, value, cls) {
    return (
      '<div class="tl-account-metric"><span>' + escapeHtml(label) + "</span>" +
      '<strong class="' + (cls || "") + '">' + value + "</strong></div>"
    );
  }

  /* ── Strategy paper accounts ───────────────────────────────
     The primary area, and visually distinct from the book cards below it,
     because the two answer different questions. Every registered strategy
     appears — including the four that may not trade forward, which show why
     rather than being hidden. An empty account is information. */

  function accountStatusClass(account) {
    var runner = account.liveResearch || {};
    if (runner.healthStatus === "ERROR") return "tl-acct-status tl-acct-status--error";
    if (runner.healthStatus === "EVENT_REPLAY_ONLY") return "tl-acct-status tl-acct-status--replay";
    if (runner.enabled) return "tl-acct-status tl-acct-status--live";
    return "tl-acct-status tl-acct-status--idle";
  }

  function accountStatusDot(account) {
    var runner = account.liveResearch || {};
    if (runner.healthStatus === "ERROR") return "●";
    if (runner.healthStatus === "EVENT_REPLAY_ONLY") return "◆";
    if (runner.enabled) return "●";
    return "○";
  }

  function renderStrategyAccounts(data) {
    if (!strategyAccountsEl) return;
    var accounts = (data && data.accounts) || [];
    if (!accounts.length) {
      strategyAccountsEl.innerHTML = '<div class="de-empty">No strategies registered.</div>';
      return;
    }

    strategyAccountsEl.innerHTML = accounts
      .map(function (account) {
        var s = account.stats || {};
        var m = s.riskMetrics || {};
        var runner = account.liveResearch || {};
        var intent = runner.currentIntent || {};
        var traded = Number(s.totalTrades) > 0;
        var selected = account.id === currentStrategy() ? " is-active" : "";
        var netPnl = Number(s.equity || 0) - Number(s.startingBalance || 0);

        return (
          '<article class="tl-account-card tl-acct' + selected + (runner.enabled ? " tl-acct--live" : "") +
          '" data-strategy="' + escapeHtml(account.id) + '" tabindex="0">' +
          '<div class="tl-account-body">' +
          '<div class="tl-account-head"><span>' + escapeHtml(account.name) + "</span>" +
          '<small class="tl-acct-research">Research: ' + escapeHtml(String(account.status || "unknown").toUpperCase()) + "</small></div>" +
          // What the strategy IS, straight from registry metadata. Distinct
          // from Current intent below, which is what it is doing right now:
          // this line does not change between refreshes, and that difference
          // is the point of showing both.
          (account.shortDescription
            ? '<p class="tl-acct-desc">' + escapeHtml(account.shortDescription) + "</p>"
            : "") +
          '<div class="' + accountStatusClass(account) + '">' +
          accountStatusDot(account) + " LIVE DEMO: " + escapeHtml(statusLabel(runner.runnerStatus || "PAUSED")) +
          "</div>" +
          '<div class="tl-account-equity"><span>Equity</span><strong>$' +
          Number(s.equity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
          "</strong></div>" +
          '<div class="tl-acct-intent"><span>Current intent</span><strong>' +
          escapeHtml(intent.title || "Waiting for runner state") + "</strong></div>" +
          '<div class="tl-account-metrics">' +
          accountMetric("Net P&L", fmtUsd(netPnl), pnlClass(netPnl)) +
          accountMetric("Signal", escapeHtml(runner.currentSignal || "FLAT")) +
          accountMetric("Win rate", traded ? s.winRate + "%" : "—") +
          accountMetric("Expectancy", m.closedTrades ? (m.expectancyR > 0 ? "+" : "") + m.expectancyR + "R" : "—", pnlClass(m.expectancyR)) +
          accountMetric("Trades", (s.totalTrades || 0) + " closed / " + (s.openPositions || 0) + " open") +
          "</div>" +
          '<div class="tl-acct-updated">Updated ' + escapeHtml(fmtAgo(runner.lastSuccessfulEvaluationAt)) + "</div>" +
          '<button class="tl-activity-btn" type="button" data-activity-strategy="' + escapeHtml(account.id) + '">' +
          "What is it doing?</button>" +
          "</div></article>"
        );
      })
      .join("");
  }

  function renderLegacyBooks(books) {
    if (!legacyBooksEl) return;
    if (!books || !books.length) {
      legacyBooksEl.innerHTML = '<div class="de-empty">No legacy ledgers found.</div>';
      return;
    }
    legacyBooksEl.innerHTML =
      '<div class="de-table-wrap"><table class="de-table"><thead><tr>' +
      '<th>Ledger</th><th>Status</th><th>Closed trades</th><th>Historical balance</th><th>P&amp;L</th>' +
      '</tr></thead><tbody>' +
      books.map(function (book) {
        var s = book.stats || {};
        return "<tr><td>" + escapeHtml(book.name) + "</td>" +
          '<td><span class="tl-tag">Archived · read only</span></td>' +
          "<td>" + Number(book.totalTrades || s.totalTrades || 0) + "</td>" +
          "<td>$" + Number(s.balance || s.startingBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "</td>" +
          '<td class="' + pnlClass(s.realizedPnl) + '">' + fmtUsd(s.realizedPnl) + "</td></tr>";
      }).join("") +
      "</tbody></table></div>";
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
          '<td><span class="tl-tag" title="No registered strategy identity">Research only</span></td></tr>'
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

  /* ── Market environment ────────────────────────────────────
     Two panels, deliberately kept apart. The read is a measurement of the
     market; the routing is a reading of our own trade history. A surprising
     answer should say which of the two it came from. */

  // Each regime gets one colour, used everywhere it appears so a label reads
  // the same in the environment card and in the matrix below it.
  function regimeClass(regime) {
    switch (regime) {
      case "TREND_UP": return "tl-regime--up";
      case "TREND_DOWN": return "tl-regime--down";
      case "ACCUMULATION": return "tl-regime--accum";
      case "DISTRIBUTION": return "tl-regime--dist";
      case "VOLATILE_EXPANSION": return "tl-regime--volatile";
      case "LOW_COMPRESSION": return "tl-regime--coiled";
      case "TRANSITION": return "tl-regime--transition";
      case "RANGE": return "tl-regime--range";
      default: return "tl-regime--unknown";
    }
  }

  function prettyLabel(value) {
    return String(value == null ? "—" : value).replace(/_/g, " ");
  }

  function regimeRow(label, value, cls) {
    return (
      '<div class="tl-regime-row"><span class="tl-regime-key">' + escapeHtml(label) + "</span>" +
      '<span class="tl-regime-val ' + (cls || "") + '">' + escapeHtml(value) + "</span></div>"
    );
  }

  function renderRouting(routing) {
    if (!routing) return "";

    // The refusal case. Every candidate is held, none blamed — nothing about
    // these strategies failed, the environment is simply unreadable.
    if (!routing.actionable) {
      return (
        '<div class="tl-route tl-route--held">' +
        '<div class="tl-route-verdict">NO STRATEGY SELECTED</div>' +
        '<div class="tl-route-why">' + escapeHtml(routing.reasons[0] || "") + "</div>" +
        (routing.held && routing.held.length
          ? '<div class="tl-route-line"><span class="tl-route-tag">Held</span> ' +
            routing.held.map(function (h) { return escapeHtml(h.name); }).join(", ") + "</div>"
          : "") +
        "</div>"
      );
    }

    var parts = ['<div class="tl-route">'];

    if (routing.preferred) {
      parts.push(
        '<div class="tl-route-verdict">Preferred: ' + escapeHtml(routing.preferred.name) +
          (routing.preferred.scannerEligible ? "" : ' <span class="tl-tag">research only</span>') +
          "</div>",
        '<div class="tl-route-why">' + escapeHtml(routing.preferred.reason) + "</div>",
      );
    } else {
      parts.push('<div class="tl-route-verdict">No strategy has measured favourably here yet</div>');
    }

    var others = routing.eligible.slice(1);
    if (others.length) {
      parts.push(
        '<div class="tl-route-line"><span class="tl-route-tag tl-route-tag--ok">Eligible</span> ' +
          others.map(function (c) { return escapeHtml(c.name); }).join(", ") + "</div>",
      );
    }
    if (routing.suppressed.length) {
      parts.push(
        '<div class="tl-route-line"><span class="tl-route-tag tl-route-tag--no">Suppressed</span> ' +
          routing.suppressed
            .map(function (c) { return escapeHtml(c.name) + " (" + escapeHtml(c.reason) + ")"; })
            .join(", ") + "</div>",
      );
    }
    // Unproven is kept visually distinct from suppressed: never having traded
    // in a regime is not the same as having lost money there.
    if (routing.unproven.length) {
      parts.push(
        '<div class="tl-route-line"><span class="tl-route-tag">Unproven here</span> ' +
          routing.unproven.map(function (c) { return escapeHtml(c.name); }).join(", ") + "</div>",
      );
    }

    parts.push("</div>");
    return parts.join("");
  }

  function renderRegime(data) {
    if (!regimeEl) return;
    var read = data && data.regime;
    if (!read) {
      regimeEl.innerHTML = '<div class="de-empty">No regime read available.</div>';
      return;
    }

    var ind = read.indicators || {};
    var head =
      '<div class="tl-regime-head ' + regimeClass(read.regime) + '">' +
      '<div class="tl-regime-symbol">' + escapeHtml(data.symbol) + " &middot; " + escapeHtml(data.interval) + "</div>" +
      '<div class="tl-regime-label">' + escapeHtml(prettyLabel(read.regime)) + "</div>" +
      '<div class="tl-regime-conf">' + read.confidence + "% confidence</div>" +
      '<div class="tl-regime-action">' + escapeHtml(read.action) + "</div>" +
      "</div>";

    var facts =
      '<div class="tl-regime-facts">' +
      // `trend`, not `direction`: outside a trend regime the EMA ordering is
      // noise the engine has already measured as such — see regime.js.
      regimeRow("Trend", prettyLabel(read.trend),
        read.trend === "UP" ? "tl-up" : read.trend === "DOWN" ? "tl-down" : "tl-flat") +
      regimeRow("ADX", ind.adx == null ? "—" : String(ind.adx)) +
      regimeRow("Volatility", prettyLabel(read.volatility) + (ind.atrRatio == null ? "" : " (" + ind.atrRatio + "× ATR)")) +
      regimeRow("Volume", prettyLabel(read.volumeState) + (ind.volumeRatio == null ? "" : " (" + ind.volumeRatio + "×)")) +
      regimeRow("Structure", read.structure ? prettyLabel(read.structure.label) : "—") +
      regimeRow("Preferred mode", prettyLabel(read.preferredMode)) +
      regimeRow("Risk", prettyLabel(read.riskPosture),
        read.riskPosture === "NONE" ? "tl-down" : read.riskPosture === "REDUCED" ? "tl-flat" : "tl-up") +
      "</div>";

    var why =
      '<div class="tl-regime-reasons"><div class="tl-metric-title">Why</div><ul>' +
      (read.reasons || []).map(function (r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("") +
      "</ul></div>";

    regimeEl.innerHTML =
      '<div class="tl-regime-grid">' + head + facts + "</div>" + renderRouting(data.routing) + why;
  }

  function renderRegimeMatrix(data) {
    if (!regimeMatrixEl) return;
    var rows = (data && data.rows) || [];
    if (!rows.length) {
      regimeMatrixEl.innerHTML =
        '<div class="de-empty">No closed trades yet — the regime table fills in as trades finish.</div>';
      return;
    }

    var regimes = data.regimes || [];
    var cov = data.coverage || {};
    // Coverage first, deliberately. A table built from mostly-untagged history
    // is not a regime analysis, and that should be visible at a glance rather
    // than inferred by summing the cells.
    var coverage =
      '<div class="tl-regime-coverage' + (cov.taggedPct < 50 ? " tl-regime-coverage--thin" : "") + '">' +
      escapeHtml(
        cov.tagged + " of " + cov.trades + " closed trades carry a regime tag (" + cov.taggedPct + "%)" +
          (cov.untagged ? " — untagged trades predate regime tagging and are shown in their own column" : ""),
      ) +
      "</div>";

    var header =
      "<tr><th>Strategy</th><th>All</th>" +
      regimes.map(function (r) { return "<th>" + escapeHtml(prettyLabel(r)) + "</th>"; }).join("") +
      "</tr>";

    var body = rows
      .map(function (row) {
        var cells = regimes
          .map(function (regime) {
            var cell = row.cells[regime];
            if (!cell) return '<td class="tl-cell-empty">—</td>';
            var cls = cell.sufficient ? pnlClass(cell.expectancyR) : "tl-cell-thin";
            return (
              '<td class="' + cls + '" title="' +
              escapeHtml(
                cell.closedTrades + " trades, PF " + (cell.profitFactor == null ? "∞" : cell.profitFactor) +
                  (cell.sufficient ? "" : " — below the evidence threshold"),
              ) + '">' +
              (cell.expectancyR > 0 ? "+" : "") + cell.expectancyR + "R" +
              '<span class="tl-cell-n">' + cell.closedTrades + "</span>" +
              "</td>"
            );
          })
          .join("");

        return (
          "<tr><td>" + escapeHtml(row.strategy) + "</td>" +
          '<td class="' + pnlClass(row.summary.expectancyR) + '">' +
          (row.summary.expectancyR > 0 ? "+" : "") + row.summary.expectancyR + "R" +
          '<span class="tl-cell-n">' + row.summary.closedTrades + "</span></td>" +
          cells + "</tr>"
        );
      })
      .join("");

    regimeMatrixEl.innerHTML =
      coverage +
      '<div class="de-table-wrap"><table class="de-table tl-regime-table"><thead>' +
      header + "</thead><tbody>" + body + "</tbody></table></div>" +
      '<div class="de-card-note">Each cell is expectancy in R with its trade count. Dimmed cells are below the ' +
      escapeHtml(String(data.minTrades)) + '-trade evidence threshold — visible so a thin sample is never mistaken for a finding.</div>';
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

  /* ── Account Activity inspector ────────────────────────── */

  function activityField(label, value, cls) {
    return '<div class="tl-activity-field"><span>' + escapeHtml(label) + '</span><strong class="' +
      (cls || "") + '">' + value + "</strong></div>";
  }

  function renderRules(rules) {
    if (!rules) return '<div class="de-empty">No structured rule description is registered.</div>';
    var rows = [
      ["Purpose", rules.purpose], ["Looks for", rules.looksFor], ["Long entry", rules.longEntry],
      ["Short entry", rules.shortEntry], ["Trend filter", rules.trendFilter], ["Stop", rules.stop],
      ["Target", rules.target], ["Position sizing", rules.positionSizing],
    ];
    return '<dl class="tl-rule-list">' + rows.map(function (row) {
      return "<dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(row[1] || "—") + "</dd>";
    }).join("") + "</dl>";
  }

  function renderMarketRead(runner) {
    var read = runner.marketRead || {};
    var specific = runner.strategyRead || {};
    var rows = Object.keys(specific).filter(function (key) { return specific[key] != null; });
    return '<div class="tl-activity-grid">' +
      activityField("Regime", escapeHtml(read.regime || "UNKNOWN")) +
      activityField("Regime confidence", read.regimeConfidence == null ? "—" : escapeHtml(String(read.regimeConfidence)) + "%") +
      activityField("Strategy signal", escapeHtml(runner.currentSignal || "FLAT")) +
      activityField("Current price", fmtPrice(read.price)) +
      rows.map(function (key) {
        var value = specific[key];
        return activityField(key.replace(/([A-Z])/g, " $1"), typeof value === "number" ? fmtPrice(value) : escapeHtml(String(value)));
      }).join("") + "</div>";
  }

  function renderDecisionTrail(rows) {
    if (!rows || !rows.length) return '<div class="de-empty">No decision has been processed yet.</div>';
    return '<div class="tl-pipeline">' + rows.map(function (row, index) {
      return '<div class="tl-pipeline-step' + (row.failed ? " is-failed" : "") + '">' +
        '<span>' + escapeHtml(row.step) + '</span><strong>' + escapeHtml(row.status) + '</strong>' +
        (row.detail ? '<small>' + escapeHtml(row.detail) + "</small>" : "") + "</div>" +
        (index < rows.length - 1 ? '<div class="tl-pipeline-arrow">&#8595;</div>' : "");
    }).join("") + "</div>";
  }

  function renderOpenPosition(position) {
    var currentR = position.riskUsd
      ? Number(position.unrealizedPnl || 0) / Number(position.riskUsd)
      : null;
    return '<div class="tl-position-detail">' +
      '<div class="tl-position-title"><strong>' + escapeHtml(position.symbol) + " " + escapeHtml(position.direction) +
      '</strong><span class="' + pnlClass(position.unrealizedPnl) + '">' + fmtUsd(position.unrealizedPnl) + "</span></div>" +
      '<div class="tl-activity-grid">' +
      activityField("Entry", fmtPrice(position.entryPrice)) +
      activityField("Current", fmtPrice(position.currentPrice)) +
      activityField("Stop", fmtPrice(position.stopLoss)) +
      activityField("TP1", fmtPrice(position.tp1)) +
      activityField("TP2", fmtPrice(position.tp2)) +
      activityField("Risk", fmtUsd(position.riskUsd)) +
      activityField("Current R", currentR == null ? "—" : (currentR > 0 ? "+" : "") + currentR.toFixed(2) + "R", pnlClass(currentR)) +
      activityField("Opened", escapeHtml(fmtTime(position.openedAt))) +
      activityField("Version", escapeHtml((position.meta && position.meta.strategyVersion) || "—")) +
      activityField("Timeframe", escapeHtml((position.meta && position.meta.timeframe) || "—")) +
      activityField("Entry regime", escapeHtml((position.meta && position.meta.regime) || "—")) +
      activityField("Partial exits", escapeHtml(String((position.exits || []).length))) +
      activityField("Breakeven", position.tp1Hit ? "ACTIVE" : "NOT YET") +
      "</div></div>";
  }

  function renderTimeline(items) {
    if (!items || !items.length) return '<div class="de-empty">No runner activity recorded yet.</div>';
    return '<ol class="tl-activity-timeline">' + items.map(function (item) {
      return '<li><time>' + escapeHtml(fmtTime(item.at)) + '</time><div><strong>' +
        escapeHtml(statusLabel(item.type)) + '</strong><span>' + escapeHtml(item.message) + "</span></div></li>";
    }).join("") + "</ol>";
  }

  function renderAccountActivity(detail) {
    var runner = detail.liveResearch || {};
    var intent = runner.currentIntent || {};
    var s = detail.stats || {};
    var m = s.riskMetrics || {};
    var netPnl = Number(s.equity || 0) - Number(s.startingBalance || 0);
    activityTitle.textContent = detail.name || detail.id;
    activityContent.innerHTML =
      '<section class="tl-activity-hero">' +
      '<div class="' + accountStatusClass(detail) + '">' + accountStatusDot(detail) + " " +
      escapeHtml(statusLabel(runner.runnerStatus || "PAUSED")) + "</div>" +
      '<div class="tl-activity-meta">Research: <strong>' + escapeHtml(String(detail.status || "unknown").toUpperCase()) +
      '</strong> &middot; Live demo: <strong>' + escapeHtml(statusLabel(runner.healthStatus || "PAUSED")) + "</strong></div>" +
      '<div class="tl-activity-grid">' +
      activityField("Watching", escapeHtml((runner.symbol || "—") + (runner.timeframe ? " · " + runner.timeframe : ""))) +
      activityField("Last candle", escapeHtml(fmtTime(runner.lastProcessedCandle && runner.lastProcessedCandle.closedAt))) +
      activityField("Next expected", escapeHtml(fmtTime(runner.nextExpectedCandle))) +
      activityField("Last successful", escapeHtml(fmtTime(runner.lastSuccessfulEvaluationAt))) +
      "</div></section>" +

      '<section class="tl-intent-callout"><div class="tl-kicker">Current intent</div><h3>' +
      escapeHtml(intent.title || "WAITING FOR RUNNER STATE") + '</h3><p>' + escapeHtml(intent.summary || "—") +
      '</p><div class="tl-intent-reason"><strong>Reason</strong><span>' + escapeHtml(intent.reason || "—") +
      '</span></div><div class="tl-intent-reason"><strong>Next action</strong><span>' +
      escapeHtml(intent.nextAction || "—") + "</span></div></section>" +

      '<section><h3>Market Read</h3>' + renderMarketRead(runner) + "</section>" +
      '<section><h3>Decision Pipeline</h3>' + renderDecisionTrail(runner.decisionTrail) + "</section>" +
      '<section><h3>Demo Wallet</h3><div class="tl-activity-grid">' +
      activityField("Starting balance", "$" + Number(s.startingBalance || 0).toLocaleString()) +
      activityField("Current balance", "$" + Number(s.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })) +
      activityField("Equity", "$" + Number(s.equity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })) +
      activityField("Realized P&L", fmtUsd(s.realizedPnl), pnlClass(s.realizedPnl)) +
      activityField("Unrealized P&L", fmtUsd(s.unrealizedPnl), pnlClass(s.unrealizedPnl)) +
      activityField("Net P&L", fmtUsd(netPnl), pnlClass(netPnl)) +
      activityField("Closed trades", escapeHtml(String(s.totalTrades || 0))) +
      activityField("Open trades", escapeHtml(String(s.openPositions || 0))) +
      activityField("Win rate", s.totalTrades ? escapeHtml(String(s.winRate)) + "%" : "—") +
      activityField("Expectancy", m.closedTrades ? escapeHtml(String(m.expectancyR)) + "R" : "—", pnlClass(m.expectancyR)) +
      activityField("Profit factor", m.closedTrades ? escapeHtml(String(m.profitFactor == null ? "∞" : m.profitFactor)) : "—") +
      activityField("Max drawdown", m.closedTrades ? escapeHtml(String(m.maxDrawdownPct)) + "%" : "—") +
      "</div></section>" +
      ((detail.history || []).length
        ? '<section><h3>Equity Curve</h3><div class="tl-account-graph-wrap">' + performanceSparkline(detail, { items: detail.history, openingBalance: s.startingBalance }) + "</div></section>"
        : "") +
      '<section><h3>Open Position</h3>' +
      ((detail.openPositions || []).length ? detail.openPositions.map(renderOpenPosition).join("") : '<div class="de-empty">No open position.</div>') +
      "</section>" +
      '<details class="tl-rules"><summary>How this strategy trades</summary>' + renderRules(detail.rules) + "</details>" +
      '<section><h3>Recent Activity</h3>' + renderTimeline(runner.activity) + "</section>" +
      (runner.lastError
        ? '<section class="tl-runner-error"><h3>Runner Error</h3><p>' + escapeHtml(runner.lastError) +
          "</p><small>Retry: " + escapeHtml(statusLabel(runner.retryStatus)) + "</small></section>"
        : "");
  }

  function openAccountActivity(strategyId) {
    selectedStrategyId = strategyId;
    activityShell.hidden = false;
    document.body.classList.add("tl-activity-open");
    activityTitle.textContent = strategyId;
    activityContent.innerHTML = '<div class="de-empty">Loading account activity&hellip;</div>';
    return getJson("/api/trading-lab/strategy-accounts/" + encodeURIComponent(strategyId) + "?limit=100&min_trades=1")
      .then(renderAccountActivity)
      .catch(function (err) {
        activityContent.innerHTML = '<div class="de-empty">Could not load account activity: ' + escapeHtml(err.message) + "</div>";
      });
  }

  function closeAccountActivity() {
    activityShell.hidden = true;
    document.body.classList.remove("tl-activity-open");
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
      strategyAccounts = data.accounts || [];
      if (!strategyAccounts.some(function (account) { return account.id === currentStrategy(); })) {
        selectedStrategyId = strategyAccounts.length ? strategyAccounts[0].id : "mindset_v1";
      }
      modeEl.textContent = data.mode === "live" ? "LIVE" : "PAPER";
      modeEl.className = "tl-mode " + (data.mode === "live" ? "tl-mode--live" : "tl-mode--paper");
      updatedEl.textContent = "Updated " + fmtTime(data.updatedAt);
      renderStrategyAccounts({ accounts: strategyAccounts });
      renderLegacyBooks(data.legacyBooks || data.books || []);
      var selected = strategyAccounts.filter(function (account) { return account.id === currentStrategy(); })[0];
      if (selectedAccountEl) selectedAccountEl.textContent = selected ? selected.name : currentStrategy();
    });
  }

  function loadStrategyDetail() {
    var strategyId = encodeURIComponent(currentStrategy());
    return Promise.all([
      getJson(
        "/api/trading-lab/strategy-accounts/" + strategyId +
          "?limit=50&min_trades=" + encodeURIComponent(currentRegimeMinTrades()),
      ).then(function (detail) {
        renderPositions(detail.openPositions);
        renderMetrics(detail.metrics);
        renderHistory(detail.history);
        renderRegimeMatrix(detail.regimeMetrics);
      }),
      getJson("/api/trading-lab/signal-actions?limit=25").then(renderSignalActions),
      // The scanner panel is independent of the selected strategy: a failure to read it
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

  function currentRegimeMinTrades() {
    return (regimeMin && regimeMin.value) || "20";
  }

  // The regime read needs candles, so it is the one panel here that can be slow
  // or unavailable (503 when no candle source is configured). It loads on its
  // own and reports its own failure rather than blanking the page around it.
  function loadRegime() {
    if (!regimeEl) return Promise.resolve();
    regimeEl.innerHTML = '<div class="de-empty">Reading the market environment&hellip;</div>';
    return getJson(
      "/api/trading-lab/regime?symbol=" + encodeURIComponent((regimeSymbol.value || "BTCUSDT").toUpperCase()) +
        "&interval=" + encodeURIComponent(regimeInterval.value) +
        "&min_trades=" + encodeURIComponent(currentRegimeMinTrades()),
    )
      .then(renderRegime)
      .catch(function (err) {
        regimeEl.innerHTML = '<div class="de-empty">Could not read the regime: ' + escapeHtml(err.message) + "</div>";
      });
  }

  function loadRegimeMatrix() {
    if (!regimeMatrixEl) return Promise.resolve();
    return getJson(
      "/api/trading-lab/regime-matrix?strategyId=" + encodeURIComponent(currentStrategy()) +
        "&min_trades=" + encodeURIComponent(currentRegimeMinTrades()),
    )
      .then(renderRegimeMatrix)
      .catch(function (err) {
        regimeMatrixEl.innerHTML =
          '<div class="de-empty">Could not read the regime table: ' + escapeHtml(err.message) + "</div>";
      });
  }

  function loadCandidates() {
    candidatesTbody.innerHTML = '<tr><td colspan="12" class="de-empty">Scoring Decision Engine plans&hellip;</td></tr>';
    return getJson(
      "/api/trading-lab/decision-candidates?interval=" +
        encodeURIComponent(intervalSelect.value),
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
      .then(loadStrategyDetail)
      .then(loadCandidates)
      .then(loadRegime)
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

  /* ── Charts ────────────────────────────────────────────────
     No chart library on this page, so these are hand-built SVG.
     Two rules hold across all of them, both for mobile's sake:

     1. No text inside the SVG. A viewBox scaled down to a 340px phone
        scales its type down with it, and 11px becomes 6px. Every label
        is HTML beside the plot instead, so it stays at its own size and
        the plot is free to squash.
     2. The plot is drawn in its own viewBox units with
        preserveAspectRatio="none", so it fills whatever width it is
        given. Strokes carry vector-effect="non-scaling-stroke" so a
        squashed plot does not also squash its line weight.
     ──────────────────────────────────────────────────────── */

  var CHART_W = 600;

  // Series colour is semantic here, not categorical: these charts show
  // profit and loss, and this page already reads green as up and coral as
  // down everywhere else. Five overlaid strategy colours were tried first
  // and abandoned — at this surface's lightness no five-hue set separates
  // safely for colour-vision deficiency, which is why the comparison below
  // is small multiples rather than one chart with five lines on it.
  var UP = "#00e396";
  var DOWN = "#ff4d6d";

  function curveValues(curve) {
    return curve.map(function (p) { return Number(p.equity); });
  }

  // Percent return from the run's own first point, which is what makes two
  // strategies with different balances comparable on one scale.
  function curvePct(curve) {
    var values = curveValues(curve);
    var base = values[0] || 1;
    return values.map(function (v) { return ((v - base) / Math.abs(base)) * 100; });
  }

  function pointsFor(values, min, span, width, height) {
    return values
      .map(function (v, i) {
        var x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
        var y = height - ((v - min) / span) * height;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
  }

  // The main equity chart: the curve, the peak-to-trough shading underneath
  // it, and a baseline at break-even.
  //
  // The drawdown band is the point of the chart. Two runs can finish at the
  // same equity having felt completely different on the way, and a bare line
  // hides that — the shaded gap between the running peak and the curve is the
  // pain the number at the end does not show.
  function equityChart(curve, id) {
    if (!curve || curve.length < 2) return '<div class="de-empty tl-chart-empty">No equity curve — this run closed no trades.</div>';

    var values = curveValues(curve);
    var height = 160;
    var peaks = [];
    var peak = -Infinity;
    for (var i = 0; i < values.length; i += 1) {
      peak = Math.max(peak, values[i]);
      peaks.push(peak);
    }

    var base = values[0];
    var all = values.concat(peaks).concat([base]);
    var min = Math.min.apply(null, all);
    var max = Math.max.apply(null, all);
    var span = max - min || 1;
    // A little headroom so the line never runs along the frame edge.
    min -= span * 0.06;
    max += span * 0.06;
    span = max - min;

    var linePts = pointsFor(values, min, span, CHART_W, height);
    var peakPts = pointsFor(peaks, min, span, CHART_W, height);
    // Closed band between the running peak and the equity line.
    var band = peakPts + " " + linePts.split(" ").reverse().join(" ");
    var baseY = (height - ((base - min) / span) * height).toFixed(1);
    var up = values[values.length - 1] >= base;

    return (
      '<div class="tl-chart" data-chart="' + escapeHtml(id) + '">' +
      '<svg class="tl-chart-plot" viewBox="0 0 ' + CHART_W + " " + height + '" preserveAspectRatio="none" ' +
      'role="img" aria-label="Equity curve with drawdown from peak shaded">' +
      '<polygon class="tl-chart-dd" points="' + band + '" />' +
      '<line class="tl-chart-base" x1="0" y1="' + baseY + '" x2="' + CHART_W + '" y2="' + baseY + '" ' +
      'vector-effect="non-scaling-stroke" />' +
      '<polyline class="tl-chart-line" fill="none" points="' + linePts + '" ' +
      'stroke="' + (up ? UP : DOWN) + '" vector-effect="non-scaling-stroke" />' +
      '<line class="tl-chart-cursor" x1="0" y1="0" x2="0" y2="' + height + '" ' +
      'vector-effect="non-scaling-stroke" style="display:none" />' +
      "</svg>" +
      "</div>"
    );
  }

  // A facet in the comparison grid. One line, no shading, no axis — it is
  // read against its siblings, and `min`/`span` are passed in so every facet
  // shares one scale. Facets on independent scales would make a 2% run and a
  // 40% run look identical, which is the whole thing the grid exists to show.
  function miniEquity(curve, min, span) {
    if (!curve || curve.length < 2) return '<div class="tl-mini tl-mini--empty">no trades</div>';
    var values = curvePct(curve);
    var height = 44;
    var pts = pointsFor(values, min, span, CHART_W, height);
    var zeroY = (height - ((0 - min) / span) * height).toFixed(1);
    var up = values[values.length - 1] >= 0;
    return (
      '<svg class="tl-mini" viewBox="0 0 ' + CHART_W + " " + height + '" preserveAspectRatio="none" ' +
      'role="img" aria-label="Equity curve">' +
      '<line class="tl-chart-base" x1="0" y1="' + zeroY + '" x2="' + CHART_W + '" y2="' + zeroY + '" ' +
      'vector-effect="non-scaling-stroke" />' +
      '<polyline fill="none" points="' + pts + '" stroke="' + (up ? UP : DOWN) + '" ' +
      'stroke-width="2" vector-effect="non-scaling-stroke" /></svg>'
    );
  }

  // R-multiple distribution.
  //
  // Expectancy is a mean, and a mean hides its own shape: +0.4R from many
  // small wins and one catastrophic loss is a different strategy from +0.4R
  // spread evenly, and only one of them survives a bad month. This is the
  // chart that tells those apart, so it is worth the space even when the
  // trade count is small.
  function rMultipleChart(trades) {
    var values = (trades || [])
      .map(function (t) { return Number(t.rMultiple); })
      .filter(function (v) { return isFinite(v); });
    if (!values.length) return "";

    var lo = Math.floor(Math.min.apply(null, values) * 2) / 2;
    var hi = Math.ceil(Math.max.apply(null, values) * 2) / 2;
    var step = 0.5;
    var buckets = [];
    for (var edge = lo; edge < hi; edge += step) {
      var from = Math.round(edge * 2) / 2;
      buckets.push({ from: from, to: from + step, count: 0 });
    }
    if (!buckets.length) buckets.push({ from: lo, to: lo + step, count: 0 });

    values.forEach(function (v) {
      var idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((v - lo) / step)));
      buckets[idx].count += 1;
    });

    var tallest = buckets.reduce(function (m, b) { return Math.max(m, b.count); }, 0) || 1;
    var height = 90;
    var gap = 2; // the 2px surface gap that keeps adjacent bars separate
    var barW = CHART_W / buckets.length;
    var bars = buckets
      .map(function (b, i) {
        if (!b.count) return "";
        var h = (b.count / tallest) * height;
        var x = i * barW + gap / 2;
        return (
          '<rect x="' + x.toFixed(1) + '" y="' + (height - h).toFixed(1) + '" ' +
          'width="' + Math.max(1, barW - gap).toFixed(1) + '" height="' + h.toFixed(1) + '" ' +
          'rx="2" fill="' + (b.from < 0 ? DOWN : UP) + '">' +
          "<title>" + b.count + " trade(s) between " + b.from + "R and " + b.to + "R</title>" +
          "</rect>"
        );
      })
      .join("");

    // Break-even is drawn INSIDE the plot rather than labelled beneath it.
    // A "0" in the HTML label row would be positioned by the flex row, which
    // puts it at the visual midpoint — and the midpoint of this axis is almost
    // never zero. A line at the computed x cannot drift from the data.
    var zeroX = (((0 - lo) / (hi - lo || 1)) * CHART_W).toFixed(1);

    return (
      '<div class="tl-chart-block">' +
      '<div class="tl-chart-head"><span class="tl-chart-title">R-multiple distribution</span>' +
      '<span class="tl-chart-note">' + values.length + " closed trade(s)</span></div>" +
      '<svg class="tl-hist" viewBox="0 0 ' + CHART_W + " " + height + '" preserveAspectRatio="none" ' +
      'role="img" aria-label="Distribution of trade results in R multiples">' + bars +
      '<line class="tl-chart-base" x1="' + zeroX + '" y1="0" x2="' + zeroX + '" y2="' + height + '" ' +
      'vector-effect="non-scaling-stroke" /></svg>' +
      '<div class="tl-chart-axis"><span>' + lo + "R</span>" +
      "<span>dashed line is break-even</span>" +
      "<span>" + hi + "R</span></div>" +
      "</div>"
    );
  }

  // The crosshair. An HTML/SVG chart is interactive by default, and on a
  // phone the readout IS the axis — there is no room for one otherwise.
  // Pointer events cover mouse and touch in one path.
  function attachCrosshair(root, curve) {
    var wrap = root.querySelector(".tl-chart");
    var readout = root.querySelector(".tl-chart-readout");
    if (!wrap || !readout || !curve || curve.length < 2) return;
    var cursor = wrap.querySelector(".tl-chart-cursor");
    var idle = readout.innerHTML;

    function move(event) {
      var box = wrap.getBoundingClientRect();
      if (!box.width) return;
      var ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      var point = curve[Math.round(ratio * (curve.length - 1))];
      if (!point) return;
      cursor.setAttribute("x1", (ratio * CHART_W).toFixed(1));
      cursor.setAttribute("x2", (ratio * CHART_W).toFixed(1));
      cursor.style.display = "";
      readout.innerHTML =
        "<strong>" + escapeHtml(fmtUsd(point.equity)) + "</strong> equity &middot; " +
        escapeHtml(fmtTime(point.at));
      if (event.cancelable && event.pointerType === "touch") event.preventDefault();
    }

    function leave() {
      cursor.style.display = "none";
      readout.innerHTML = idle;
    }

    wrap.addEventListener("pointerdown", move);
    wrap.addEventListener("pointermove", move);
    wrap.addEventListener("pointerleave", leave);
    wrap.addEventListener("pointercancel", leave);
  }

  // The backtester applies fees, slippage and funding inside the paper trader
  // (see BACKTEST_* env vars). They default to zero, and a zero-cost run read
  // as a realistic one is exactly the mistake this line exists to prevent —
  // so say which assumptions produced the numbers above them, every time.
  function pct(rate) {
    return (Number(rate) * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") + "%";
  }

  function costsLine(costs, scenario) {
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

    // A zero rate is an EXCLUDED cost, not a neutral one. Printing "funding 0%"
    // beside two real rates reads as "funding was accounted for and came to
    // nothing", which is the opposite of the truth — no funding feed exists, so
    // charging a rate would mean inventing one. Each excluded cost is named.
    var excluded = [];
    if (!Number(costs.takerFeeRate)) excluded.push("fees");
    if (!Number(costs.slippageRate)) excluded.push("slippage");
    if (!Number(costs.fundingRate8h)) excluded.push("funding");

    var applied = [];
    if (Number(costs.takerFeeRate)) applied.push("taker fee " + pct(costs.takerFeeRate));
    if (Number(costs.slippageRate)) applied.push("slippage " + pct(costs.slippageRate));
    if (Number(costs.fundingRate8h)) applied.push("funding " + pct(costs.fundingRate8h) + " per 8h");

    return '<div class="tl-bt-meta tl-bt-costs">' +
      (scenario ? escapeHtml(scenario) + ": " : "Costs applied: ") + applied.join(" · ") +
      (excluded.length
        ? ' <span class="tl-tag">&#9888;&#65039; ' + escapeHtml(excluded.join(" and ")) +
          " NOT charged</span>"
        : "") +
      "</div>";
  }

  // Which exit rules produced the numbers. Shown on every result because it
  // changes what they mean: shared execution compares ENTRY signals on one
  // execution model, native runs each strategy's own stop and target.
  function executionModeLabel(mode) {
    return mode === "native" ? "native strategy exits" : "shared execution";
  }

  // What a row ACTUALLY ran on, which is a different question from what the
  // comparison asked for. A strategy that publishes no stop/target hints falls
  // back to shared levels trade by trade, so a row inside a run headed "native
  // strategy exits" can be a shared-execution result from top to bottom. The
  // header is not the place to find that out; the row is.
  function appliedExecutionLabel(applied) {
    if (applied === "native") return "Native";
    if (applied === "shared-fallback") return "Shared fallback";
    if (applied === "mixed") return "Mixed";
    if (applied === "none") return "—";
    return "Shared";
  }

  // Only the states a reader could misread need calling out. "Shared" under a
  // shared run and "Native" under a native one are the expected cases.
  function appliedExecutionTitle(r) {
    if (r.executionApplied === "shared-fallback") {
      return "Requested native, but " + (r.strategy || "this strategy") +
        " published no usable stop/target — every trade used shared levels";
    }
    if (r.executionApplied === "mixed") {
      return r.nativeTrades + " trade(s) used the strategy's own levels, " +
        r.sharedTrades + " fell back to shared levels";
    }
    return "";
  }

  function appliedExecutionCell(r) {
    var label = appliedExecutionLabel(r.executionApplied);
    var warn = r.executionApplied === "shared-fallback" || r.executionApplied === "mixed";
    var title = appliedExecutionTitle(r);
    return (
      (warn ? '<span class="tl-tag" title="' + escapeHtml(title) + '">' : "<span>") +
      escapeHtml(label) +
      "</span>"
    );
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

    var curve = data.equityCurve || [];
    var endEquity = curve.length ? curve[curve.length - 1].equity : null;

    btResult.innerHTML =
      '<div class="tl-stat-grid">' + tiles + "</div>" +
      '<div class="tl-chart-block">' +
      '<div class="tl-chart-head">' +
      '<span class="tl-chart-title">Equity</span>' +
      '<span class="tl-chart-note tl-chart-readout">' +
      (endEquity == null
        ? "no closed trades"
        : "ended " + escapeHtml(fmtUsd(endEquity)) + " &middot; shaded band is drawdown from peak") +
      "</span></div>" +
      equityChart(curve, "bt-equity") +
      (curve.length > 1
        ? '<div class="tl-chart-axis"><span>' + escapeHtml(fmtDay(data.from)) +
          "</span><span>" + escapeHtml(fmtDay(data.to)) + "</span></div>"
        : "") +
      "</div>" +
      rMultipleChart(data.trades) +
      '<div class="tl-bt-meta">' +
      escapeHtml(data.strategyName || data.strategy || "—") +
      " (" + escapeHtml(data.strategy || "—") + ")" +
      " · " + escapeHtml(data.symbol) + " " + escapeHtml(data.interval) +
      " · " + data.bars + " bars (" + data.warmupBars + " warmup)" +
      " · " + escapeHtml(executionModeLabel(data.executionMode)) +
      // Requested mode above, applied execution here — they differ whenever a
      // strategy publishes no usable levels, and the difference is the whole
      // meaning of the numbers on this card.
      (data.executionApplied && data.executionApplied !== "none"
        ? " (applied: " + escapeHtml(appliedExecutionLabel(data.executionApplied)) + ")"
        : "") +
      " · " + fmtTime(data.from) + " → " + fmtTime(data.to) +
      "</div>" +
      costsLine(data.costs, data.costScenario) +
      (caveats.length
        ? '<div class="de-warnings" style="display:block">' +
          caveats.map(function (c) { return "<div>" + escapeHtml(c) + "</div>"; }).join("") +
          "</div>"
        : "");

    attachCrosshair(btResult, curve);
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

  // The label rides along on every cell so the table can restack itself as a
  // list of labelled rows on a narrow screen. An eleven-column table on a
  // phone is either a horizontal scroll nobody discovers or type too small to
  // read, and this card is the one people will actually open on a phone.
  function compareCell(value, className, label) {
    return (
      '<td class="' + (className || "") + '"' +
      (label ? ' data-label="' + escapeHtml(label) + '"' : "") +
      ">" + value + "</td>"
    );
  }

  // Why a strategy has no line. "insufficient data" and "ran but never traded"
  // are completely different outcomes and must not look alike: one is a
  // missing dataset, the other is a strategy that refused every setup it saw.
  function facetReason(r) {
    if (r.status === "insufficient-data") return "insufficient data";
    if (!r.closedTrades && r.signals) return "signalled, no fills";
    if (!r.closedTrades) return "no trades";
    return "no curve";
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
          '<td class="tl-compare-name">' + escapeHtml(r.strategyName || r.strategy) +
          "<br /><small>" + escapeHtml(r.strategy) +
          // A row that is not ranked says so where the reader is looking,
          // rather than sitting silently in the order as if it had earned it.
          (r.rankable === false
            ? ' <span class="tl-tag">unranked: ' + escapeHtml(r.unrankedReason || "no trades") + "</span>"
            : "") +
          "</small></td>" +
          compareCell(appliedExecutionCell(r), "", "Execution") +
          compareCell(r.bars + " <small>(" + r.warmupBars + " warmup)</small>", "", "Bars") +
          compareCell(r.status === "insufficient-data" ? "insufficient data" : escapeHtml(r.replayType || "candle"), "", "Replay") +
          compareCell(r.signals, "", "Signals") +
          compareCell(r.closedTrades, "", "Closed") +
          compareCell(fmtUsd(r.netPnlUsd), pnlClass(r.netPnlUsd), "Net P&L") +
          compareCell(r.closedTrades ? (r.expectancyR > 0 ? "+" : "") + r.expectancyR + "R" : "—", pnlClass(r.expectancyR), "Expectancy") +
          compareCell(r.profitFactor == null ? (r.closedTrades ? "∞" : "—") : r.profitFactor, "", "Profit factor") +
          compareCell(r.closedTrades ? r.maxDrawdownPct + "%" : "—", "", "Max DD") +
          compareCell(r.closedTrades ? r.winRate + "%" : "—", "", "Win rate") +
          compareCell(r.worstLossStreak, "", "Worst streak") +
          "</tr>"
        );
      })
      .join("");

    // Small multiples rather than five lines on one chart. Two reasons, and
    // the second is the load-bearing one:
    //
    //   1. On a phone, five overlaid curves in a 340px-wide box is a scribble.
    //   2. Telling five lines apart needs five colours that separate under
    //      colour-vision deficiency at this surface's lightness, and no such
    //      five-hue set exists here — the candidates collided at ΔE 2.1
    //      (deutan). A grid needs no series colours at all: each facet is one
    //      line, labelled by name, coloured only by whether it made money.
    //
    // Every facet shares one scale, computed across all of them.
    // EVERY strategy gets a facet, including the ones with nothing to draw.
    // Dropping the curveless ones silently leaves this grid and the table
    // below disagreeing about how many strategies ran, and a reader counting
    // five and finding four has to go work out which one vanished. A facet
    // that says "no curve, and here is why" answers that in place.
    var plotted = rows.filter(function (r) { return r.equityCurve && r.equityCurve.length > 1; });
    var lo = 0;
    var hi = 0;
    plotted.forEach(function (r) {
      curvePct(r.equityCurve).forEach(function (v) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      });
    });
    var pad = (hi - lo || 1) * 0.08;
    lo -= pad;
    hi += pad;
    var span = hi - lo || 1;

    var facets =
      '<div class="tl-facets">' +
      rows
        .map(function (r) {
          var drawable = r.equityCurve && r.equityCurve.length > 1;
          var pctReturn = r.netReturnPct;
          return (
            '<div class="tl-facet' + (drawable ? "" : " tl-facet--empty") + '">' +
            '<div class="tl-facet-head">' +
            '<span class="tl-facet-name">' + escapeHtml(r.strategyName || r.strategy) + "</span>" +
            '<span class="tl-facet-value ' + (drawable ? pnlClass(pctReturn) : "tl-flat") + '">' +
            (drawable ? (pctReturn > 0 ? "+" : "") + escapeHtml(String(pctReturn)) + "%" : "—") +
            "</span></div>" +
            (drawable
              ? miniEquity(r.equityCurve, lo, span)
              : '<div class="tl-mini tl-mini--empty">' + escapeHtml(facetReason(r)) + "</div>") +
            '<div class="tl-facet-foot">' +
            (drawable
              ? r.closedTrades + " trades &middot; " +
                (r.closedTrades ? (r.expectancyR > 0 ? "+" : "") + escapeHtml(String(r.expectancyR)) + "R" : "no expectancy")
              : escapeHtml(r.replayType || "candle") + " replay") +
            // The facets are what most readers scan first, so the applied
            // execution rides here too rather than only in the table below.
            (r.executionApplied && r.executionApplied !== "none"
              ? " &middot; " + escapeHtml(appliedExecutionLabel(r.executionApplied))
              : "") +
            "</div></div>"
          );
        })
        .join("") +
      "</div>" +
      (plotted.length
        ? '<div class="tl-chart-axis"><span>shared scale ' + lo.toFixed(1) + "% to " + hi.toFixed(1) +
          "%</span><span>% return from each run&#39;s own start</span></div>"
        : "");

    btCompareResult.innerHTML =
      facets +
      '<div class="de-table-wrap"><table class="de-table tl-compare-table"><thead><tr>' +
      "<th>Strategy</th><th>Execution</th><th>Bars</th><th>Replay</th><th>Signals</th><th>Closed</th><th>Net P&amp;L</th>" +
      "<th>Expectancy</th><th>Profit factor</th><th>Max DD</th><th>Win rate</th><th>Worst streak</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      '<div class="tl-bt-meta">' + escapeHtml(data.symbol) + " " + escapeHtml(data.interval) +
      " · " + escapeHtml(executionModeLabel(data.executionMode)) +
      " · ranked by expectancy, then profit factor, then drawdown · " + fmtTime(data.ranAt) +
      " · backtest only, the live scanner is unaffected</div>" +
      costsLine(rows[0] && rows[0].costs, data.costScenario || (rows[0] && rows[0].costScenario));
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
      executionMode: btMode.value,
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
      executionMode: btMode.value,
    })
      .then(renderBacktest)
      .catch(function (err) {
        btResult.innerHTML = '<div class="de-empty">Backtest failed: ' + escapeHtml(err.message) + "</div>";
      })
      .then(function () { btRunBtn.disabled = false; });
  });

  if (regimeBtn) regimeBtn.addEventListener("click", loadRegime);
  if (regimeInterval) regimeInterval.addEventListener("change", loadRegime);
  if (regimeSymbol) {
    regimeSymbol.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadRegime();
    });
  }
  // The threshold decides which cells count as evidence in both panels, so
  // changing it reloads both rather than leaving the two disagreeing.
  if (regimeMin) {
    regimeMin.addEventListener("change", function () {
      loadStrategyDetail();
      loadRegime();
    });
  }

  refreshBtn.addEventListener("click", refresh);
  intervalSelect.addEventListener("change", loadCandidates);

  strategyAccountsEl.addEventListener("click", function (event) {
    var activityButton = event.target.closest("[data-activity-strategy]");
    if (activityButton) {
      openAccountActivity(activityButton.dataset.activityStrategy);
      return;
    }
    var card = event.target.closest("[data-strategy]");
    if (!card || !card.dataset.strategy || card.dataset.strategy === currentStrategy()) return;
    selectedStrategyId = card.dataset.strategy;
    refresh();
  });

  strategyAccountsEl.addEventListener("keydown", function (event) {
    var card = event.target.closest("[data-strategy]");
    if (!card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    selectedStrategyId = card.dataset.strategy;
    refresh();
  });

  if (activityShell) {
    activityShell.addEventListener("click", function (event) {
      if (event.target.closest("[data-close-activity]")) closeAccountActivity();
    });
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && activityShell && !activityShell.hidden) closeAccountActivity();
  });

  markBtn.addEventListener("click", function () {
    markBtn.disabled = true;
    postAdmin("/api/trading-lab/mark", { strategyId: currentStrategy() })
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
      strategyId: currentStrategy(),
      reason: "MANUAL",
    })
      .then(refresh)
      .catch(function (err) { showError(err.message); btn.disabled = false; });
  });

  loadStrategies();
  refresh();
  window.setInterval(function () {
    loadOverview().catch(function () {});
    if (activityShell && !activityShell.hidden) openAccountActivity(currentStrategy());
  }, 30000);
})();
