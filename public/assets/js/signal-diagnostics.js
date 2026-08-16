(function () {
  "use strict";

  // Panels that moved out of the Backtest Lab because none of them serve a
  // demo account: signal sources, loop health, and archived ledgers.
  //
  // They are observation surfaces. Nothing on this page can open a position or
  // write to a strategy ledger — the Decision Engine's plans are scored in an
  // unattributed, non-persistent context, and the Signal Bot has no registered
  // strategy identity to attribute a trade to.

  var notice = document.getElementById("sd-notice");
  var updatedEl = document.getElementById("sd-updated");
  var intervalSelect = document.getElementById("sd-interval");
  var refreshBtn = document.getElementById("sd-refresh");
  var candidatesTbody = document.getElementById("sd-candidates-tbody");
  var signalActionsTbody = document.getElementById("sd-signal-actions-tbody");
  var scannerEl = document.getElementById("sd-scanner");
  var legacyBooksEl = document.getElementById("sd-legacy-books");

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

  function decisionClass(decision) {
    if (decision === "SKIP" || decision === "BLOCK") return "tl-badge tl-badge--skip";
    if (decision === "REDUCE" || decision === "TAKE_QUARTER" || decision === "TAKE_HALF") return "tl-badge tl-badge--reduce";
    return "tl-badge tl-badge--take";
  }

  function reasonsTitle(reasons) {
    return escapeHtml((reasons || []).join("\n"));
  }

  function statTile(label, value, cls) {
    return (
      '<div class="tl-stat"><div class="tl-stat-label">' + escapeHtml(label) + "</div>" +
      '<div class="tl-stat-value ' + (cls || "") + '">' + value + "</div></div>"
    );
  }

  function showError(message) {
    notice.style.display = "block";
    notice.innerHTML = "&#9888;&#65039; " + escapeHtml(message);
  }

  function clearError() {
    notice.style.display = "none";
    notice.textContent = "";
  }

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /* ── Decision Engine candidates ────────────────────────── */

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

  /* ── Signal Bot bridge ─────────────────────────────────── */

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

  /* ── Live scanner health ───────────────────────────────── */

  // Enabled, last scan, last candle, last signal, last error — the five things
  // that answer "is it actually running?" without needing the server logs.
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

  /* ── Archived ledgers ──────────────────────────────────── */

  function renderLegacyBooks(books) {
    if (!legacyBooksEl) return;
    if (!books || !books.length) {
      legacyBooksEl.innerHTML = '<div class="de-empty">No legacy ledgers found.</div>';
      return;
    }
    legacyBooksEl.innerHTML =
      '<div class="de-table-wrap"><table class="de-table"><thead><tr>' +
      '<th>Ledger</th><th>Status</th><th>Closed trades</th><th>Historical balance</th><th>P&amp;L</th>' +
      "</tr></thead><tbody>" +
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

  /* ── Loading ───────────────────────────────────────────── */

  // Each panel loads and fails independently: an unreachable Decision Engine
  // must not blank the scanner health beside it, which is the one panel you
  // most want when something else is broken.
  function loadCandidates() {
    candidatesTbody.innerHTML = '<tr><td colspan="12" class="de-empty">Scoring Decision Engine plans&hellip;</td></tr>';
    return getJson("/api/trading-lab/decision-candidates?interval=" + encodeURIComponent(intervalSelect.value))
      .then(renderCandidates)
      .catch(function (err) {
        candidatesTbody.innerHTML =
          '<tr><td colspan="12" class="de-empty">Could not score plans: ' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  function loadScanner() {
    return getJson("/api/live-scanner/status")
      .then(renderScanner)
      .catch(function (err) {
        scannerEl.innerHTML = '<div class="de-empty">Could not read scanner status: ' + escapeHtml(err.message) + "</div>";
      });
  }

  function loadSignalActions() {
    return getJson("/api/trading-lab/signal-actions?limit=25")
      .then(renderSignalActions)
      .catch(function (err) {
        signalActionsTbody.innerHTML =
          '<tr><td colspan="10" class="de-empty">Could not read bridge actions: ' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  function loadLegacyBooks() {
    return getJson("/api/trading-lab")
      .then(function (data) { renderLegacyBooks(data.legacyBooks || data.books || []); })
      .catch(function (err) {
        legacyBooksEl.innerHTML = '<div class="de-empty">Could not read legacy ledgers: ' + escapeHtml(err.message) + "</div>";
      });
  }

  function refresh() {
    clearError();
    refreshBtn.disabled = true;
    return Promise.all([loadCandidates(), loadScanner(), loadSignalActions(), loadLegacyBooks()])
      .then(function () { updatedEl.textContent = "Updated " + fmtTime(new Date().toISOString()); })
      .catch(function (err) { showError(err.message); })
      .then(function () { refreshBtn.disabled = false; });
  }

  refreshBtn.addEventListener("click", refresh);
  intervalSelect.addEventListener("change", loadCandidates);

  refresh();
})();
