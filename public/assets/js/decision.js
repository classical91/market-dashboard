(function () {
  "use strict";

  function tick() {
    var el = document.getElementById("cmd-clock");
    if (el) el.textContent = new Date().toLocaleString(undefined, {
      weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }
  tick(); setInterval(tick, 1000);

  var notice = document.getElementById("de-notice");
  var warningsEl = document.getElementById("de-warnings");
  var updatedEl = document.getElementById("de-updated");
  var refreshBtn = document.getElementById("de-refresh-btn");
  var intervalSelect = document.getElementById("de-interval");
  var regimeBody = document.getElementById("de-regime-body");
  var rotationBody = document.getElementById("de-rotation-body");
  var newsStrip = document.getElementById("de-news-strip");
  var setupsTbody = document.getElementById("de-setups-tbody");
  var execGrid = document.getElementById("de-exec-grid");
  var journalTbody = document.getElementById("de-journal-tbody");
  var journalStats = document.getElementById("de-journal-stats");

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtPrice(px) {
    if (px == null) return "—";
    if (px >= 1000) return px.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (px >= 1) return px.toFixed(4);
    return px.toFixed(6);
  }

  function fmtPct(value) {
    if (value == null) return "—";
    var n = Number(value);
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function showError(message) {
    notice.style.display = "block";
    notice.innerHTML = "&#9888;&#65039; " + escapeHtml(message);
  }

  /* ── Regime ──────────────────────────────────────────── */

  function regimeClass(label) {
    return "de-regime--" + String(label || "unknown").toLowerCase().replace(/[^a-z]+/g, "-");
  }

  function voteBar(vote) {
    var pct = Math.min(Math.abs(Number(vote) || 0), 1) * 50;
    var cls = (Number(vote) || 0) >= 0 ? "de-vote-fill--pos" : "de-vote-fill--neg";
    return (
      '<div class="de-vote-bar"><div class="de-vote-fill ' + cls + '" style="width:' + pct.toFixed(0) + '%"></div></div>'
    );
  }

  function renderRegime(regime) {
    if (!regime) { regimeBody.innerHTML = '<div class="de-empty">No regime data.</div>'; return; }
    var chips = [regime.volatility ? "Volatility: " + regime.volatility : null]
      .concat(regime.modifiers || [])
      .filter(Boolean)
      .map(function (chip) { return '<span class="de-chip">' + escapeHtml(chip) + "</span>"; })
      .join("");

    var rows = (regime.components || []).map(function (c) {
      return (
        "<tr><td>" + escapeHtml(c.name) + "</td>" +
        '<td class="de-vote-cell">' + voteBar(c.vote) + "</td>" +
        '<td class="de-note-cell">' + escapeHtml(c.detail || "") + "</td></tr>"
      );
    }).join("");

    regimeBody.innerHTML =
      '<div class="de-regime-head">' +
        '<span class="de-regime-label ' + regimeClass(regime.label) + '">' + escapeHtml(regime.label) + "</span>" +
        chips +
      "</div>" +
      '<div class="de-score-track"><div class="de-score-needle" style="left:' + (regime.score || 50) + '%"></div></div>' +
      '<div class="de-score-scale"><span>0 &middot; Risk-Off</span><span>' + (regime.score || 50) + "/100</span><span>Risk-On &middot; 100</span></div>" +
      '<div class="de-regime-summary">' + escapeHtml(regime.summary || "") + "</div>" +
      '<div class="de-table-wrap"><table class="de-table"><thead><tr><th>Input</th><th>Vote</th><th>Detail</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="3" class="de-empty">No inputs available.</td></tr>') +
      "</tbody></table></div>";
  }

  /* ── Rotation ────────────────────────────────────────── */

  function dirClass(direction) {
    var d = String(direction || "").toLowerCase();
    if (d.indexOf("up") !== -1) return "de-dir--up";
    if (d.indexOf("down") !== -1) return "de-dir--down";
    if (d === "no data") return "de-dir--nodata";
    return "de-dir--flat";
  }

  function strengthBadge(strength) {
    var s = String(strength || "-").toLowerCase();
    var cls = s === "strong" ? "de-badge--strong" : s === "medium" ? "de-badge--medium" : s === "weak" ? "de-badge--weak" : "de-badge--none";
    return '<span class="de-badge ' + cls + '">' + escapeHtml(strength || "-") + "</span>";
  }

  function renderRotation(rotation) {
    if (!rotation || !rotation.rows || !rotation.rows.length) {
      rotationBody.innerHTML = '<div class="de-empty">No rotation data.</div>';
      return;
    }
    var rows = rotation.rows.map(function (row) {
      return (
        "<tr><td>" + escapeHtml(row.assetClass) + "</td>" +
        '<td class="' + dirClass(row.direction) + '">' + escapeHtml(row.direction) + "</td>" +
        "<td>" + strengthBadge(row.strength) + "</td>" +
        "<td>" + fmtPct(row.changePercent) + "</td>" +
        '<td class="de-note-cell">' + escapeHtml(row.note || "") + "</td></tr>"
      );
    }).join("");
    rotationBody.innerHTML =
      '<div class="de-table-wrap"><table class="de-table"><thead><tr>' +
      "<th>Asset Class</th><th>Direction</th><th>Strength</th><th>24h</th><th>Note</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<div class="de-regime-summary" style="margin-top:10px">' + escapeHtml(rotation.summary || "") + "</div>";
  }

  /* ── News risk ───────────────────────────────────────── */

  function renderNews(newsRisk) {
    if (!newsRisk) { newsStrip.style.display = "none"; return; }
    newsStrip.style.display = "flex";
    newsStrip.className = "de-news-strip de-news--" + escapeHtml(newsRisk.level || "low");
    var icon = newsRisk.level === "high" ? "&#128680;" : newsRisk.level === "medium" ? "&#9888;&#65039;" : "&#128994;";
    newsStrip.innerHTML =
      "<span>" + icon + " <b>News risk: " + escapeHtml((newsRisk.level || "low").toUpperCase()) + "</b></span>" +
      "<span>" + escapeHtml(newsRisk.reason || "") + "</span>";
  }

  /* ── Setup ranking ───────────────────────────────────── */

  function scoreBadge(score) {
    if (score == null) return '<span class="de-badge de-badge--none">—</span>';
    var cls = score >= 75 ? "de-score--high" : score >= 60 ? "de-score--mid" : score >= 45 ? "de-score--neutral" : "de-score--low";
    return '<span class="de-badge ' + cls + '">' + score + "</span>";
  }

  function actionClass(action) {
    var a = String(action || "").toLowerCase();
    if (a.indexOf("ready") === 0) return "de-action--ready";
    if (a === "watch") return "de-action--watch";
    if (a.indexOf("low") === 0) return "de-action--low";
    if (a.indexOf("stand down") === 0) return "de-action--standdown";
    if (a === "skip") return "de-action--skip";
    return "de-action--none";
  }

  function signalClass(signal) {
    return signal === "LONG" ? "de-signal--long" : signal === "SHORT" ? "de-signal--short" : "de-signal--flat";
  }

  function renderSetups(setups) {
    if (!setups || !setups.length) {
      setupsTbody.innerHTML = '<tr><td colspan="9" class="de-empty">No screener results.</td></tr>';
      return;
    }
    setupsTbody.innerHTML = setups.map(function (row) {
      if (row.error) {
        return '<tr><td>' + escapeHtml(row.symbol) + '</td><td colspan="8" class="de-note-cell">' + escapeHtml(row.error) + "</td></tr>";
      }
      var c = row.components || {};
      return (
        "<tr><td>" + escapeHtml(row.symbol) + "</td>" +
        '<td class="' + signalClass(row.signal) + '">' + escapeHtml(row.signal) + "</td>" +
        "<td>" + scoreBadge(row.setupScore) + "</td>" +
        '<td class="' + actionClass(row.action) + '">' + escapeHtml(row.action || "") + "</td>" +
        "<td>" + (c.confluence != null ? c.confluence : "—") + "</td>" +
        "<td>" + (c.regimeAlignment != null ? c.regimeAlignment : "—") + "</td>" +
        "<td>" + (c.trendStrength != null ? c.trendStrength : "—") + "</td>" +
        "<td>" + (c.newsSafety != null ? c.newsSafety : "—") + "</td>" +
        "<td>" + fmtPrice(row.price) + "</td></tr>"
      );
    }).join("");
  }

  /* ── Execution panel ─────────────────────────────────── */

  function renderExecution(execution, decision) {
    if (!execution || !execution.length) {
      execGrid.innerHTML = '<div class="de-empty">No directional setups strong enough for an execution plan right now.</div>';
      return;
    }
    execGrid.innerHTML = execution.map(function (plan, index) {
      if (plan.error) {
        return (
          '<div class="de-exec-card"><div class="de-exec-head"><span class="de-exec-symbol">' +
          escapeHtml(plan.symbol) + '</span></div><div class="de-note-cell">' + escapeHtml(plan.error) + "</div></div>"
        );
      }
      var dnt = plan.doNotTrade && plan.doNotTrade.length
        ? '<div class="de-exec-dnt">' + plan.doNotTrade.map(function (reason) {
            return "<div>&#9940; " + escapeHtml(reason) + "</div>";
          }).join("") + "</div>"
        : '<div class="de-exec-clear">&#9989; No blocking conditions &mdash; still confirm on the chart</div>';
      return (
        '<div class="de-exec-card de-exec-card--' + (plan.signal === "LONG" ? "long" : "short") + (plan.tradeable ? "" : " de-exec-card--blocked") + '">' +
          '<div class="de-exec-head">' +
            '<span class="de-exec-symbol">' + escapeHtml(plan.symbol) + "</span>" +
            '<span class="' + signalClass(plan.signal) + '">' + escapeHtml(plan.bias) + "</span>" +
            scoreBadge(plan.setupScore) +
          "</div>" +
          '<dl class="de-exec-levels">' +
            "<dt>Last price</dt><dd>" + fmtPrice(plan.price) + "</dd>" +
            "<dt>Trigger</dt><dd>" + (plan.signal === "LONG" ? "Break above " : "Break below ") + fmtPrice(plan.trigger) + "</dd>" +
            "<dt>Invalidation</dt><dd>" + fmtPrice(plan.invalidation) + "</dd>" +
            "<dt>Target</dt><dd>" + fmtPrice(plan.target) + "</dd>" +
            "<dt>Risk / Reward</dt><dd>" + (plan.riskReward != null ? plan.riskReward.toFixed(2) : "—") + "</dd>" +
            "<dt>Risk (ATR)</dt><dd>" + escapeHtml(plan.riskLabel || "—") + (plan.atrPercent != null ? " (" + plan.atrPercent.toFixed(2) + "%)" : "") + "</dd>" +
          "</dl>" +
          dnt +
          '<button class="de-log-btn" type="button" data-log-index="' + index + '">&#128221; Log to journal</button>' +
        "</div>"
      );
    }).join("");

    execGrid.querySelectorAll("[data-log-index]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        logToJournal(execution[Number(btn.getAttribute("data-log-index"))], decision, btn);
      });
    });
  }

  function logToJournal(plan, decision, btn) {
    if (!plan || plan.error) return;
    var setup = (decision.setups || []).find(function (row) { return row.symbol === plan.symbol; }) || {};
    btn.disabled = true;
    btn.textContent = "Logging…";
    window.AdminKey.fetch("/api/decision/journal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: plan.symbol,
        interval: decision.interval,
        signal: plan.signal,
        price: plan.price,
        setupScore: plan.setupScore,
        screenerScore: setup.screenerScore,
        regimeLabel: decision.regime && decision.regime.label,
        regimeScore: decision.regime && decision.regime.score,
        newsRisk: decision.newsRisk && decision.newsRisk.level,
        plan: {
          trigger: plan.trigger,
          invalidation: plan.invalidation,
          target: plan.target,
          riskReward: plan.riskReward,
          riskLabel: plan.riskLabel,
        },
      }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (body) { throw new Error(body.error || ("HTTP " + res.status)); });
        return loadJournal();
      })
      .then(function () { btn.textContent = "✓ Logged"; })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Log to journal";
        showError("Journal log failed: " + err.message);
      });
  }

  /* ── Journal ─────────────────────────────────────────── */

  function renderJournalStats(stats) {
    if (!stats || !stats.total) { journalStats.style.display = "none"; return; }
    journalStats.style.display = "flex";
    journalStats.innerHTML =
      "<span><b>" + stats.total + "</b> logged</span>" +
      "<span><b>" + stats.taken + "</b> taken</span>" +
      "<span>Win rate <b>" + (stats.winRate != null ? stats.winRate + "%" : "—") + "</b> (" + stats.wins + "W / " + stats.losses + "L)</span>" +
      "<span>Avg score W <b>" + (stats.avgSetupScoreWins != null ? stats.avgSetupScoreWins : "—") + "</b> vs L <b>" + (stats.avgSetupScoreLosses != null ? stats.avgSetupScoreLosses : "—") + "</b></span>" +
      "<span>Regime read right <b>" + (stats.regimeAccuracy != null ? stats.regimeAccuracy + "%" : "—") + "</b></span>" +
      "<span>Pattern right <b>" + (stats.patternAccuracy != null ? stats.patternAccuracy + "%" : "—") + "</b></span>" +
      "<span>News risk missed <b>" + stats.newsRiskMissed + "</b></span>";
  }

  var RESULT_OPTIONS = ["", "win", "loss", "breakeven", "skipped"];

  function renderJournal(items) {
    if (!items || !items.length) {
      journalTbody.innerHTML = '<tr><td colspan="10" class="de-empty">Nothing logged yet. Use &ldquo;Log to journal&rdquo; on an execution card when a signal fires.</td></tr>';
      return;
    }
    journalTbody.innerHTML = items.map(function (item) {
      var options = RESULT_OPTIONS.map(function (value) {
        return '<option value="' + value + '"' + ((item.result || "") === value ? " selected" : "") + ">" + (value || "—") + "</option>";
      }).join("");
      var rr = item.plan && item.plan.riskReward != null ? Number(item.plan.riskReward).toFixed(2) : "—";
      return (
        '<tr data-journal-id="' + escapeHtml(item.id) + '">' +
          "<td>" + escapeHtml(String(item.loggedAt || "").slice(0, 10)) + "</td>" +
          "<td>" + escapeHtml(item.symbol) + " <span style=\"color:#8892a6\">" + escapeHtml(item.interval || "") + "</span></td>" +
          '<td class="' + signalClass(item.signal) + '">' + escapeHtml(item.signal) + "</td>" +
          "<td>" + scoreBadge(item.setupScore) + "</td>" +
          "<td>" + escapeHtml(item.regimeLabel || "—") + "</td>" +
          "<td>" + rr + "</td>" +
          '<td><input type="checkbox" data-field="taken"' + (item.taken ? " checked" : "") + "></td>" +
          '<td><select class="de-journal-select" data-field="result">' + options + "</select></td>" +
          '<td><span class="de-flag-group">' +
            '<label title="Was the regime call correct?"><input type="checkbox" data-field="regimeCorrect"' + (item.regimeCorrect ? " checked" : "") + ">Regime</label>" +
            '<label title="Did the pattern play out?"><input type="checkbox" data-field="patternCorrect"' + (item.patternCorrect ? " checked" : "") + ">Pattern</label>" +
            '<label title="Was a news risk missed?"><input type="checkbox" data-field="newsRiskMissed"' + (item.newsRiskMissed ? " checked" : "") + ">News miss</label>" +
          "</span></td>" +
          '<td><button class="de-del-btn" type="button" data-action="delete">&#10005;</button></td>' +
        "</tr>"
      );
    }).join("");

    journalTbody.querySelectorAll("[data-field]").forEach(function (input) {
      input.addEventListener("change", function () {
        var id = input.closest("tr").getAttribute("data-journal-id");
        var patch = {};
        patch[input.getAttribute("data-field")] = input.type === "checkbox" ? input.checked : input.value;
        patchJournal(id, patch);
      });
    });
    journalTbody.querySelectorAll('[data-action="delete"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.closest("tr").getAttribute("data-journal-id");
        window.AdminKey.fetch("/api/decision/journal/" + encodeURIComponent(id), { method: "DELETE" })
          .then(function (res) {
            if (!res.ok) return res.json().then(function (body) { throw new Error(body.error || ("HTTP " + res.status)); });
            return loadJournal();
          })
          .catch(function (err) { showError("Journal delete failed: " + err.message); });
      });
    });
  }

  function patchJournal(id, patch) {
    window.AdminKey.fetch("/api/decision/journal/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (body) { throw new Error(body.error || ("HTTP " + res.status)); });
        return res.json();
      })
      .then(function (body) { renderJournalStats(body.stats); })
      .catch(function (err) {
        showError("Journal update failed: " + err.message);
        loadJournal();
      });
  }

  function loadJournal() {
    return fetch("/api/decision/journal")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderJournal(data.items || []);
        renderJournalStats(data.stats);
      })
      .catch(function (err) { showError("Failed to load journal: " + err.message); });
  }

  /* ── Main load ───────────────────────────────────────── */

  function renderWarnings(dataQuality) {
    var warnings = (dataQuality && dataQuality.warnings) || [];
    if (!warnings.length) { warningsEl.style.display = "none"; return; }
    warningsEl.style.display = "block";
    warningsEl.innerHTML = warnings.map(function (warning) {
      return "<div>&#9888;&#65039; " + escapeHtml(warning) + "</div>";
    }).join("");
  }

  function load() {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Computing…";
    notice.style.display = "none";
    fetch("/api/decision?interval=" + encodeURIComponent(intervalSelect.value))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderRegime(data.regime);
        renderRotation(data.rotation);
        renderNews(data.newsRisk);
        renderSetups(data.setups);
        renderExecution(data.execution, data);
        renderWarnings(data.dataQuality);
        updatedEl.textContent = "Updated " + new Date().toLocaleTimeString() + " · " + data.interval;
      })
      .catch(function (err) { showError("Failed to load decision payload: " + err.message); })
      .finally(function () {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Refresh";
      });
  }

  refreshBtn.addEventListener("click", load);
  intervalSelect.addEventListener("change", load);
  load();
  loadJournal();
})();
