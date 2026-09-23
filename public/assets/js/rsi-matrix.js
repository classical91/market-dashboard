/**
 * RSI Matrix page.
 *
 * Everything numeric — RSI values, states, the AVG and its MTF flag, the group
 * summaries — arrives from /api/rsi-matrix already computed. This file only
 * lays it out, sorts it for the current view, and explains missing cells.
 * Sorting never touches the configured order; that lives in Settings.
 */
(function () {
  "use strict";

  var API = "/api/rsi-matrix";
  var AUTO_REFRESH_MS = 5 * 60 * 1000;

  var groupsEl = document.getElementById("rm-groups");
  var legendEl = document.getElementById("rm-legend");
  var sortEl = document.getElementById("rm-sort");
  var refreshBtn = document.getElementById("rm-refresh-btn");
  var updatedEl = document.getElementById("rm-updated");
  var noticeEl = document.getElementById("rm-notice");

  var data = null;
  var collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem("rsiMatrixCollapsed") || "{}") || {}; } catch (e) { collapsed = {}; }

  var STATE_LABELS = {
    "strong-bullish": "Strong bullish momentum",
    "bullish": "Bullish momentum",
    "weak-bullish": "Weak bullish momentum",
    "neutral": "Neutral",
    "weak-bearish": "Weak bearish momentum",
    "bearish": "Bearish momentum",
    "strong-bearish": "Strong bearish momentum"
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmt(value) {
    return value == null || !isFinite(value) ? "—" : Number(value).toFixed(2);
  }

  function tfLabel(tf) {
    return (data && data.timeframeLabels && data.timeframeLabels[tf]) || tf;
  }

  function showNotice(message, isError) {
    if (!message) { noticeEl.style.display = "none"; noticeEl.textContent = ""; return; }
    noticeEl.style.display = "";
    noticeEl.className = "aia-notice" + (isError ? " aia-notice--error" : "");
    noticeEl.textContent = message;
  }

  function persistCollapsed() {
    try { localStorage.setItem("rsiMatrixCollapsed", JSON.stringify(collapsed)); } catch (e) { /* private mode */ }
  }

  // ── Sorting (view only) ────────────────────────────────────
  function buildSortOptions() {
    var current = sortEl.value || "default";
    var options = [["default", "Default order"], ["avg:desc", "Highest AVG RSI"], ["avg:asc", "Lowest AVG RSI"]];
    // Fastest timeframe first, matching how the options read in the brief.
    data.timeframes.slice().reverse().forEach(function (tf) {
      options.push([tf + ":desc", "Highest " + tfLabel(tf)]);
      options.push([tf + ":asc", "Lowest " + tfLabel(tf)]);
    });
    sortEl.innerHTML = options.map(function (o) {
      return '<option value="' + escapeHtml(o[0]) + '">' + escapeHtml(o[1]) + "</option>";
    }).join("");
    sortEl.value = options.some(function (o) { return o[0] === current; }) ? current : "default";
  }

  function sortRows(rows) {
    var mode = sortEl.value || "default";
    if (mode === "default") return rows;
    var parts = mode.split(":");
    var key = parts[0];
    var dir = parts[1] === "asc" ? 1 : -1;
    function pick(row) { return key === "avg" ? row.average : row.values[key]; }
    return rows.slice().sort(function (a, b) {
      var va = pick(a);
      var vb = pick(b);
      // Missing readings sink to the end in both directions: an unavailable
      // cell is neither the strongest nor the weakest market.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }

  // ── Rendering ─────────────────────────────────────────────
  function renderLegend() {
    var bands = [
      ["strong-bullish", "≥ 75"], ["bullish", "65–75"], ["weak-bullish", "55–65"],
      ["neutral", "45–55"], ["weak-bearish", "35–45"], ["bearish", "25–35"], ["strong-bearish", "≤ 25"]
    ];
    var avg = (data && data.thresholds && data.thresholds.average) || { overbought: 70, oversold: 30 };
    legendEl.innerHTML = bands.map(function (b) {
      return '<span class="rm-legend-item"><span class="rm-swatch rm-cell--' + b[0] + '"></span>' +
        escapeHtml(b[1]) + " " + escapeHtml(STATE_LABELS[b[0]]) + "</span>";
    }).join("") +
      '<span class="rm-legend-item"><span class="rm-swatch rm-avg--mtf-overbought"></span>AVG ≥ ' + avg.overbought + " MTF overbought</span>" +
      '<span class="rm-legend-item"><span class="rm-swatch rm-avg--mtf-oversold"></span>AVG ≤ ' + avg.oversold + " MTF oversold</span>";
  }

  function cellTitle(row, tf) {
    var base = row.label + " · RSI " + data.rsiLength + " · " + tfLabel(tf);
    var value = row.values[tf];
    if (value == null) return base + " · unavailable" + (row.errors[tf] ? " — " + row.errors[tf] : "");
    var title = base + " · " + fmt(value) + " · " + (STATE_LABELS[row.states[tf]] || "");
    var fresh = row.freshness && row.freshness[tf];
    if (fresh && fresh.lastBarClose) title += "\nLast closed bar: " + new Date(fresh.lastBarClose).toLocaleString();
    if (fresh && fresh.barsBehind > 1) title += " (" + fresh.barsBehind + " bars behind — market closed or feed lagging)";
    return title;
  }

  function avgTitle(row) {
    var base = row.label + " · AVG RSI " + data.rsiLength;
    if (row.average == null) {
      return base + " · unavailable (" + row.averageAvailable + "/" + row.averageRequired + " timeframes)";
    }
    var state = row.averageState === "mtf-overbought" ? "MTF overbought"
      : row.averageState === "mtf-oversold" ? "MTF oversold" : (STATE_LABELS[row.averageTone] || "");
    return base + " · " + fmt(row.average) + " · " + state;
  }

  function headerCell(row) {
    var source = row.sourceLabel + " · " + row.providerSymbol + (row.note ? "\n" + row.note : "");
    return '<th scope="col" class="rm-col-head' + (row.error ? " rm-col-head--down" : "") + '" title="' + escapeHtml(source) + '">' +
      '<span class="rm-col-label">' + escapeHtml(row.label) + "</span>" +
      '<span class="rm-col-source">' + escapeHtml(row.sourceLabel.split(" ")[0]) + "</span></th>";
  }

  function valueCell(row, tf) {
    var value = row.values[tf];
    var cls = value == null ? "rm-cell rm-cell--na" : "rm-cell rm-cell--" + row.states[tf];
    var title = cellTitle(row, tf);
    return '<td class="' + cls + '" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '" tabindex="0">' + fmt(value) + "</td>";
  }

  function avgCell(row) {
    var title = avgTitle(row);
    if (row.average == null) {
      var partial = row.averageRequired ? row.averageAvailable + "/" + row.averageRequired : "";
      return '<td class="rm-cell rm-cell--na rm-avg" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '" tabindex="0">' +
        "—" + (partial ? '<span class="rm-avg-partial">' + escapeHtml(partial) + "</span>" : "") + "</td>";
    }
    var cls = "rm-cell rm-avg rm-cell--" + row.averageTone;
    if (row.averageState === "mtf-overbought" || row.averageState === "mtf-oversold") cls += " rm-avg--" + row.averageState;
    var flag = row.averageState === "mtf-overbought" ? '<span class="rm-avg-flag">OB</span>'
      : row.averageState === "mtf-oversold" ? '<span class="rm-avg-flag">OS</span>' : "";
    return '<td class="' + cls + '" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '" tabindex="0">' + fmt(row.average) + flag + "</td>";
  }

  function statTile(label, item, withTf) {
    var body = item
      ? '<strong>' + escapeHtml(item.label) + "</strong> " + fmt(item.value) + (withTf ? ' <span class="rm-stat-tf">' + escapeHtml(tfLabel(item.timeframe)) + "</span>" : "")
      : '<span class="rm-stat-empty">—</span>';
    return '<div class="rm-stat"><div class="rm-stat-label">' + escapeHtml(label) + '</div><div class="rm-stat-value">' + body + "</div></div>";
  }

  function extremesLine(summary) {
    function names(list) { return list.map(function (a) { return escapeHtml(a.label) + " " + fmt(a.value); }).join(", "); }
    var parts = [];
    if (summary.mtfOverbought.length) parts.push('<span class="rm-ext rm-ext--ob">MTF overbought: ' + names(summary.mtfOverbought) + "</span>");
    if (summary.mtfOversold.length) parts.push('<span class="rm-ext rm-ext--os">MTF oversold: ' + names(summary.mtfOversold) + "</span>");
    return parts.length ? '<div class="rm-extremes">' + parts.join("") + "</div>" : "";
  }

  function renderGroup(group, rowsById) {
    var rows = sortRows(group.rows.map(function (id) { return rowsById[id]; }).filter(Boolean));
    var s = group.summary;
    var open = !collapsed[group.id];
    var html = '<details class="rm-group" data-group="' + escapeHtml(group.id) + '"' + (open ? " open" : "") + ">" +
      '<summary class="rm-group-head"><span class="rm-group-title">' + escapeHtml(group.label) + "</span>" +
      '<span class="rm-group-count">' + rows.length + (rows.length === 1 ? " instrument" : " instruments") + "</span></summary>";

    if (!rows.length) {
      html += '<div class="rm-empty">No enabled instruments in this group. Add or enable some in <a href="/settings.html#rsi-matrix-settings">Settings</a>.</div></details>';
      return html;
    }

    html += '<div class="rm-stats">' +
      statTile("Most overbought", s.mostOverbought, true) +
      statTile("Most oversold", s.mostOversold, true) +
      statTile("Strongest AVG RSI", s.strongestAverage, false) +
      statTile("Weakest AVG RSI", s.weakestAverage, false) +
      "</div>" + extremesLine(s);

    html += '<div class="rm-table-wrap"><table class="rm-table"><thead><tr><th scope="col" class="rm-axis">RSI ' + data.rsiLength + "</th>" +
      rows.map(headerCell).join("") + "</tr></thead><tbody>";
    data.timeframes.forEach(function (tf) {
      html += '<tr><th scope="row" class="rm-axis">RSI ' + escapeHtml(tfLabel(tf)) + "</th>" +
        rows.map(function (row) { return valueCell(row, tf); }).join("") + "</tr>";
    });
    html += '<tr class="rm-avg-row"><th scope="row" class="rm-axis">AVG</th>' + rows.map(avgCell).join("") + "</tr>";
    html += "</tbody></table></div>" +
      // Touch screens have no hover: tapping a cell writes its tooltip here.
      '<div class="rm-cell-detail" aria-live="polite">Tap or hover a cell for its details.</div></details>';
    return html;
  }

  function render() {
    if (!data) return;
    renderLegend();
    var rowsById = {};
    data.instruments.forEach(function (row) { rowsById[row.id] = row; });
    if (!data.timeframes.length) {
      groupsEl.innerHTML = '<div class="rm-empty">Every timeframe is disabled. Enable at least one in Settings.</div>';
      return;
    }
    groupsEl.innerHTML = data.groups.map(function (g) { return renderGroup(g, rowsById); }).join("");
    Array.prototype.forEach.call(groupsEl.querySelectorAll("details.rm-group"), function (el) {
      el.addEventListener("toggle", function () {
        collapsed[el.getAttribute("data-group")] = !el.open;
        persistCollapsed();
      });
    });
  }

  function describeUpdated() {
    if (!data) return;
    var at = new Date(data.updatedAt);
    updatedEl.textContent = "Updated " + at.toLocaleTimeString();
    var down = data.instruments.filter(function (r) { return r.error; }).length;
    var messages = [];
    if (data.refresh && data.refresh.requested && !data.refresh.forced) {
      messages.push("Refresh is limited to once a minute across all viewers — showing cached readings.");
    }
    if (down) messages.push(down + " instrument" + (down === 1 ? " has" : "s have") + " no data right now; hover a — cell for the reason.");
    showNotice(messages.join(" "), false);
  }

  function load(force) {
    refreshBtn.disabled = true;
    return fetch(API + (force ? "?force=1" : ""), { credentials: "same-origin" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
          return body;
        });
      })
      .then(function (body) {
        data = body;
        buildSortOptions();
        render();
        describeUpdated();
      })
      .catch(function (err) {
        if (!data) groupsEl.innerHTML = '<div class="rm-empty rm-error">Could not load the RSI Matrix: ' + escapeHtml(err.message) + "</div>";
        showNotice("⚠ " + err.message, true);
      })
      .finally(function () { refreshBtn.disabled = false; });
  }

  groupsEl.addEventListener("click", function (event) {
    var cell = event.target.closest ? event.target.closest(".rm-cell") : null;
    if (!cell) return;
    var group = cell.closest(".rm-group");
    var detail = group && group.querySelector(".rm-cell-detail");
    if (detail) detail.textContent = cell.getAttribute("title") || "";
  });
  sortEl.addEventListener("change", render);
  refreshBtn.addEventListener("click", function () { load(true); });
  load(false);
  setInterval(function () { if (!document.hidden) load(false); }, AUTO_REFRESH_MS);
})();
