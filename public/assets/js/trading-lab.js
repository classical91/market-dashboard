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
  var metricsEl = document.getElementById("tl-metrics");
  var historyTbody = document.getElementById("tl-history-tbody");

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

  refresh();
})();
