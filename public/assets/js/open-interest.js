/**
 * Open Interest Intelligence.
 *
 * Every number on screen arrives from /api/open-interest (and the per-asset
 * detail from /api/open-interest/:symbol), already normalised, classified and
 * stamped with its source and age. This file sorts, filters and draws; it
 * never calls an exchange, never re-classifies a row, and never turns a
 * missing value into zero — a null renders as "—".
 */
(function () {
  "use strict";

  var S = window.ScreenerUI;
  var escapeHtml = S.escapeHtml;

  var el = {
    notice: document.getElementById("oi-notice"),
    horizon: document.getElementById("oi-horizon"),
    confluence: document.getElementById("oi-confluence"),
    search: document.getElementById("oi-search"),
    refresh: document.getElementById("oi-refresh-btn"),
    kpis: document.getElementById("oi-kpis"),
    sources: document.getElementById("oi-sources"),
    expansion: document.getElementById("oi-expansion"),
    contraction: document.getElementById("oi-contraction"),
    spikes: document.getElementById("oi-spikes"),
    tbody: document.getElementById("oi-tbody"),
    heatmap: document.getElementById("oi-heatmap"),
    radar: document.getElementById("oi-radar"),
    detail: document.getElementById("oi-detail"),
    detailTitle: document.getElementById("oi-detail-title"),
    detailSymbol: document.getElementById("oi-detail-symbol"),
    detailIntervals: document.getElementById("oi-detail-intervals"),
    charts: document.getElementById("oi-charts"),
    stats: document.getElementById("oi-stats"),
    detailFoot: document.getElementById("oi-detail-foot"),
  };
  var updated = S.createUpdatedStamp(document.getElementById("oi-updated"), "ss-updated");
  var horizonMemory = S.rememberSelect(el.horizon, "openInterestHorizon");
  var confluenceMemory = S.rememberSelect(el.confluence, "openInterestConfluence");

  var HORIZON_LABELS = { "15m": "15m", "1h": "1H", "4h": "4H", "24h": "24H" };
  var HORIZON_KEYS = ["15m", "1h", "4h", "24h"];

  var data = null;
  var view = "table";
  var detailSymbol = "BTCUSDT";
  var detailInterval = "1h";
  var detailRequest = 0;

  // ── formatting ────────────────────────────────────────────

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function fmtUsd(v) {
    if (!isNum(v)) return "—";
    var abs = Math.abs(v);
    if (abs >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  }

  function fmtPct(v, digits) {
    if (!isNum(v)) return "—";
    var d = digits == null ? 2 : digits;
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d) + "%";
  }

  function fmtCoins(v) {
    if (!isNum(v)) return "—";
    var abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(2);
  }

  function pctClass(v) {
    if (!isNum(v)) return "oi-pct oi-pct--none";
    if (v > 0) return "oi-pct oi-pct--up";
    if (v < 0) return "oi-pct oi-pct--down";
    return "oi-pct";
  }

  function pctCell(v, label) {
    return '<td data-label="' + escapeHtml(label) + '"><span class="' + pctClass(v) + '">' + fmtPct(v) + "</span></td>";
  }

  function stateBadge(state) {
    if (!state) return '<span class="oi-state oi-state--none">Unavailable</span>';
    return '<span class="oi-state oi-state--' + escapeHtml(state.tone || "none") + '" title="' + escapeHtml(state.meaning || "") + '">' +
      escapeHtml(state.label || "Unavailable") + "</span>";
  }

  var FRESH_LABELS = { FRESH: "FRESH", STALE: "STALE", UNKNOWN: "UNAVAILABLE" };

  function freshBadge(freshness) {
    var state = (freshness && freshness.state) || "UNKNOWN";
    var title = freshness && freshness.reason ? freshness.reason : state === "FRESH" ? "OI updated recently" : "No data age reported";
    return '<span class="ss-fresh ss-fresh--' + escapeHtml(state.toLowerCase()) + '" title="' + escapeHtml(title) + '">' +
      escapeHtml(FRESH_LABELS[state] || "UNAVAILABLE") + "</span>";
  }

  function asset(symbol) { return String(symbol || "").replace(/USDT$/, ""); }

  function horizon() { return el.horizon.value; }

  function showNotice(message, tone) {
    if (!message) {
      el.notice.style.display = "none";
      el.notice.textContent = "";
      return;
    }
    el.notice.style.display = "";
    el.notice.className = "aia-notice" + (tone ? " oi-notice--" + tone : "");
    el.notice.textContent = message;
  }

  // ── summary ───────────────────────────────────────────────

  var MARKET_STATE = {
    EXPANSION: { label: "Expansion", tone: "bull", hint: "Aggregate OI rising with broad participation" },
    CONTRACTION: { label: "Contraction", tone: "bear", hint: "Aggregate OI falling across most assets" },
    MIXED: { label: "Mixed", tone: "quiet", hint: "No broad agreement in positioning" },
    UNKNOWN: { label: "Unavailable", tone: "none", hint: "No asset reported OI changes" },
  };

  function kpi(label, value, sub, extra) {
    return '<div class="oi-kpi' + (extra ? " " + extra : "") + '">' +
      '<div class="oi-kpi-label">' + escapeHtml(label) + "</div>" +
      '<div class="oi-kpi-value">' + value + "</div>" +
      (sub ? '<div class="oi-kpi-sub">' + sub + "</div>" : "") +
      "</div>";
  }

  function coinKpi(label, ref, extra) {
    if (!ref) return kpi(label, "—", "No venue reported OI", extra);
    var h = horizon();
    return kpi(
      label,
      escapeHtml(fmtUsd(ref.oiUsd)),
      '<span class="' + pctClass(ref.oiChange[h]) + '">' + fmtPct(ref.oiChange[h]) + "</span> OI " + HORIZON_LABELS[h] +
        " · " + stateBadge(ref.states && ref.states[h]),
      extra,
    );
  }

  function renderSummary() {
    var s = data.summary;
    var h = horizon();
    var hs = s.horizons[h] || {};
    var coverage = s.assetsWithOi + " of " + s.assetsTracked + " assets";
    var ms = MARKET_STATE[hs.state] || MARKET_STATE.UNKNOWN;
    function change(key) {
      var entry = s.horizons[key] || {};
      return kpi(
        HORIZON_LABELS[key] + " OI Δ",
        '<span class="' + pctClass(entry.changePct) + '">' + fmtPct(entry.changePct) + "</span>",
        entry.covered ? escapeHtml(entry.covered + " assets, OI-weighted") : "No history",
      );
    }
    el.kpis.innerHTML =
      coinKpi("BTC OI", s.btc, "oi-kpi--hero") +
      kpi("Total tracked OI", escapeHtml(fmtUsd(s.totalOiUsd)), escapeHtml(coverage) + " · sum of each asset's serving venue, not a whole-market aggregate") +
      change("1h") + change("4h") + change("24h") +
      coinKpi("ETH OI", s.eth) +
      kpi("OI breadth " + HORIZON_LABELS[h], isNum(hs.breadthPct) ? escapeHtml(hs.breadthPct.toFixed(0) + "%") : "—",
        hs.covered ? escapeHtml(hs.rising + " rising · " + hs.falling + " falling") : "No history") +
      kpi("Market state " + HORIZON_LABELS[h], '<span class="oi-state oi-state--' + ms.tone + '">' + ms.label + "</span>", escapeHtml(ms.hint));
  }

  function renderSources() {
    var parts = data.sources.map(function (src) {
      var title = src.error ? src.error + (src.retryAt ? " — retrying after " + new Date(src.retryAt).toLocaleTimeString() : "") :
        src.supportsHistory ? "History venue" : "Current OI only";
      return '<span class="oi-source oi-source--' + escapeHtml(src.status) + '" title="' + escapeHtml(title) + '">' +
        escapeHtml(src.label) + " · " + (src.status === "down" ? "down" : src.assets + " assets") + "</span>";
    });
    var extras = [];
    if (data.summary.staleRows) extras.push('<span class="oi-source oi-source--down">' + data.summary.staleRows + " stale</span>");
    if (data.summary.errorRows) extras.push('<span class="oi-source oi-source--down">' + data.summary.errorRows + " unavailable</span>");
    if (!data.confluence.available && data.confluence.error) {
      extras.push('<span class="oi-source oi-source--down" title="' + escapeHtml(data.confluence.error) + '">Confluence unavailable</span>');
    }
    el.sources.innerHTML =
      '<span class="oi-sources-label">Sources</span>' + parts.join("") +
      '<span class="oi-source">Price: ' + escapeHtml(data.priceSource) + "</span>" +
      extras.join("") +
      '<span class="oi-sources-time">Server snapshot ' + escapeHtml(new Date(data.updatedAt).toLocaleTimeString()) + " · " +
      escapeHtml(data.resolution) + " OI resolution</span>";
  }

  // ── leaders ───────────────────────────────────────────────

  function usableRows() {
    return data.rows.filter(function (r) { return !r.error; });
  }

  function rankItem(row, value) {
    return '<li><button type="button" class="oi-rank-btn" data-symbol="' + escapeHtml(row.symbol) + '">' +
      '<span class="oi-rank-asset">' + escapeHtml(row.asset) + "</span>" +
      '<span class="' + pctClass(value) + '">' + fmtPct(value) + "</span>" +
      stateBadge(row.states[horizon()]) + "</button></li>";
  }

  function renderLeaders() {
    var h = horizon();
    var withChange = usableRows().filter(function (r) { return isNum(r.oiChange[h]); });
    var up = withChange.filter(function (r) { return r.oiChange[h] > 0; })
      .sort(function (a, b) { return b.oiChange[h] - a.oiChange[h]; }).slice(0, 5);
    var down = withChange.filter(function (r) { return r.oiChange[h] < 0; })
      .sort(function (a, b) { return a.oiChange[h] - b.oiChange[h]; }).slice(0, 5);
    el.expansion.innerHTML = up.length ? up.map(function (r) { return rankItem(r, r.oiChange[h]); }).join("") :
      '<li class="oi-rank-empty">No asset with rising OI on ' + HORIZON_LABELS[h] + "</li>";
    el.contraction.innerHTML = down.length ? down.map(function (r) { return rankItem(r, r.oiChange[h]); }).join("") :
      '<li class="oi-rank-empty">No asset with falling OI on ' + HORIZON_LABELS[h] + "</li>";
    var spikes = usableRows().filter(function (r) { return r.spike && r.spike.isSpike; })
      .sort(function (a, b) { return Math.abs(b.spike.zScore) - Math.abs(a.spike.zScore); });
    el.spikes.innerHTML = spikes.length ? spikes.map(function (r) {
      return '<li><button type="button" class="oi-rank-btn" data-symbol="' + escapeHtml(r.symbol) + '">' +
        '<span class="oi-rank-asset">' + escapeHtml(r.asset) + "</span>" +
        '<span class="oi-spike">OI SPIKE ' + (r.spike.direction === "UP" ? "&#9650;" : "&#9660;") + "</span>" +
        '<span class="' + pctClass(r.spike.changePct) + '">' + fmtPct(r.spike.changePct) + "</span>" +
        '<span class="oi-muted">z ' + escapeHtml(String(r.spike.zScore)) + "</span></button></li>";
    }).join("") : '<li class="oi-rank-empty">No abnormal 1H OI moves right now</li>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-role="horizon-tag"]'), function (node) {
      node.textContent = HORIZON_LABELS[h];
    });
  }

  // ── table ─────────────────────────────────────────────────

  function filteredRows() {
    var q = el.search.value.trim().toUpperCase();
    return data.rows.filter(function (r) { return !q || r.symbol.indexOf(q) !== -1; });
  }

  function confluenceCell(row) {
    var c = row.confluence;
    if (!c || (!c.bias && !c.extreme)) return '<td data-label="Confluence"><span class="oi-muted">—</span></td>';
    var parts = [];
    if (c.bias) parts.push('<span class="oi-bias oi-bias--' + c.bias.toLowerCase() + '">' + escapeHtml(c.bias) + (isNum(c.biasScore) ? " " + c.biasScore : "") + "</span>");
    if (c.extreme && c.extreme.dominant && c.extreme.state !== "NONE") {
      parts.push('<span class="oi-extreme">' + escapeHtml(c.extreme.dominant.toUpperCase() + " " + c.extreme.state) + "</span>");
    }
    var notes = (c.notes && c.notes[horizon()]) || [];
    var noteHtml = notes.map(function (n) {
      return '<div class="oi-note oi-note--' + escapeHtml(n.tone) + '">' + (n.tone === "warn" ? "&#9888;&#65039; " : "") + escapeHtml(n.text) + "</div>";
    }).join("");
    return '<td data-label="Confluence ' + escapeHtml(c.interval || "") + '" class="oi-conf-cell"><div class="oi-conf">' + parts.join(" ") + "</div>" + noteHtml + "</td>";
  }

  function renderRow(row) {
    var h = horizon();
    var pinned = row.symbol === "BTCUSDT";
    var head = '<td><span class="ss-token-head">' +
      (pinned ? '<span class="ss-pin-tag">Context</span>' : "") +
      '<button type="button" class="oi-asset-btn" data-symbol="' + escapeHtml(row.symbol) + '" aria-label="Open ' + escapeHtml(row.asset) + ' detail">' +
      escapeHtml(row.asset) + "</button>" +
      (row.spike && row.spike.isSpike ? '<span class="oi-spike" title="1H OI change z-score ' + escapeHtml(String(row.spike.zScore)) + '">SPIKE</span>' : "") +
      "</span></td>";
    if (row.error) {
      return '<tr class="ss-error-row">' + head + '<td colspan="10" class="oi-error-cell">' + escapeHtml(row.error) + "</td>" +
        '<td data-label="Freshness">' + freshBadge(row.freshness) + "</td></tr>";
    }
    var usdTitle = row.oiUsdBasis === "estimated" ? "Estimated: coins × spot price" : "Venue-reported USD value";
    return '<tr class="oi-row' + (pinned ? " oi-row--pinned" : "") + '">' + head +
      '<td data-label="Price">' + S.fmtPrice(row.price) + "</td>" +
      '<td data-label="OI" title="' + escapeHtml(usdTitle + " · " + fmtCoins(row.oiCoins) + " " + row.asset) + '">' +
        (row.oiUsdBasis === "estimated" ? "≈" : "") + fmtUsd(row.oiUsd) + "</td>" +
      pctCell(row.oiChange["15m"], "OI 15m") + pctCell(row.oiChange["1h"], "OI 1H") +
      pctCell(row.oiChange["4h"], "OI 4H") + pctCell(row.oiChange["24h"], "OI 24H") +
      pctCell(row.priceChange[h], "Price " + HORIZON_LABELS[h]) +
      '<td data-label="Interpretation">' + stateBadge(row.states[h]) + "</td>" +
      confluenceCell(row) +
      '<td data-label="Source"><span class="oi-muted" title="' + escapeHtml((row.source && row.source.venueSymbol) || "") + '">' +
        escapeHtml(row.source ? row.source.label : "—") + "</span></td>" +
      '<td data-label="Freshness">' + freshBadge(row.freshness) + "</td></tr>";
  }

  function renderTable() {
    var rows = filteredRows();
    el.tbody.innerHTML = rows.length ? rows.map(renderRow).join("") :
      '<tr class="ss-empty-row"><td colspan="12">No asset matches — the universe is set under Settings → Screeners → Open Interest.</td></tr>';
  }

  // ── heatmap ───────────────────────────────────────────────

  // Diverging: teal for rising OI, coral for falling, neutral grey at zero.
  // Colour is never the only carrier — every cell prints its signed value.
  function heatColor(v, scale) {
    if (!isNum(v)) return "transparent";
    var t = Math.min(1, Math.abs(v) / scale);
    var alpha = 0.12 + t * 0.68;
    return v >= 0 ? "rgba(0, 196, 160, " + alpha.toFixed(2) + ")" : "rgba(255, 99, 99, " + alpha.toFixed(2) + ")";
  }

  var HEAT_SCALE = { "15m": 1.5, "1h": 3, "4h": 6, "24h": 12 };

  function renderHeatmap() {
    var h = horizon();
    var rows = filteredRows().filter(function (r) { return !r.error; }).slice().sort(function (a, b) {
      var av = isNum(a.oiChange[h]) ? Math.abs(a.oiChange[h]) : -1;
      var bv = isNum(b.oiChange[h]) ? Math.abs(b.oiChange[h]) : -1;
      return bv - av;
    });
    if (!rows.length) {
      el.heatmap.innerHTML = window.MarketUI ? window.MarketUI.emptyState("No OI data") : "No OI data";
      return;
    }
    var head = '<div class="oi-heat-row oi-heat-row--head"><span></span>' +
      HORIZON_KEYS.map(function (k) { return '<span class="' + (k === h ? "is-selected" : "") + '">' + HORIZON_LABELS[k] + "</span>"; }).join("") + "</div>";
    el.heatmap.innerHTML = head + rows.map(function (r) {
      return '<div class="oi-heat-row"><button type="button" class="oi-asset-btn" data-symbol="' + escapeHtml(r.symbol) + '">' + escapeHtml(r.asset) + "</button>" +
        HORIZON_KEYS.map(function (k) {
          var v = r.oiChange[k];
          var tip = r.asset + " OI " + HORIZON_LABELS[k] + ": " + fmtPct(v) + " · price " + fmtPct(r.priceChange[k]) + " · " + (r.states[k] ? r.states[k].label : "");
          return '<span class="oi-heat-cell' + (isNum(v) ? "" : " oi-heat-cell--none") + '" style="background:' + heatColor(v, HEAT_SCALE[k]) + '" title="' + escapeHtml(tip) + '">' + fmtPct(v, 1) + "</span>";
        }).join("") + "</div>";
    }).join("");
  }

  // ── radar ─────────────────────────────────────────────────

  // Four horizons, four fixed hues in fixed order, each with its own dash so
  // identity never rests on colour alone.
  var RADAR_SERIES = [
    { key: "15m", color: "#7cc0ff", dash: "" },
    { key: "1h", color: "#f5c542", dash: "6 3" },
    { key: "4h", color: "#c792ea", dash: "2 3" },
    { key: "24h", color: "#00d3a7", dash: "10 3 2 3" },
  ];

  function renderRadar() {
    var rows = usableRows().filter(function (r) { return isNum(r.oiUsd); })
      .sort(function (a, b) { return b.oiUsd - a.oiUsd; }).slice(0, 8);
    if (rows.length < 3) {
      el.radar.innerHTML = window.MarketUI ? window.MarketUI.emptyState("Not enough assets with OI for a radar", "At least three are needed.") : "Not enough data";
      return;
    }
    var values = [];
    rows.forEach(function (r) { HORIZON_KEYS.forEach(function (k) { if (isNum(r.oiChange[k])) values.push(r.oiChange[k]); }); });
    var lo = Math.min(0, Math.min.apply(null, values.concat([0]))) ;
    var hi = Math.max(0, Math.max.apply(null, values.concat([0])));
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var size = 360, cx = size / 2, cy = size / 2, rMax = 130, rMin = 18;
    function radius(v) { return rMin + ((v - lo) / (hi - lo)) * (rMax - rMin); }
    function point(i, r) {
      var a = -Math.PI / 2 + (i / rows.length) * Math.PI * 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    }
    var svg = '<svg viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="Open interest change by horizon for the eight largest assets">';
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      var r = rMin + f * (rMax - rMin);
      svg += '<polygon class="oi-radar-grid" points="' + rows.map(function (_, i) { return point(i, r).join(","); }).join(" ") + '"/>';
    });
    svg += '<polygon class="oi-radar-zero" points="' + rows.map(function (_, i) { return point(i, radius(0)).join(","); }).join(" ") + '"/>';
    rows.forEach(function (r, i) {
      var p = point(i, rMax + 16);
      var axis = point(i, rMax);
      svg += '<line class="oi-radar-axis" x1="' + cx + '" y1="' + cy + '" x2="' + axis[0] + '" y2="' + axis[1] + '"/>';
      svg += '<text class="oi-radar-label" x="' + p[0] + '" y="' + p[1] + '" text-anchor="middle" dominant-baseline="middle">' + escapeHtml(r.asset) + "</text>";
    });
    RADAR_SERIES.forEach(function (series) {
      var pts = rows.map(function (r, i) {
        var v = r.oiChange[series.key];
        return isNum(v) ? point(i, radius(v)) : null;
      });
      if (pts.every(function (p) { return !p; })) return;
      // A missing value breaks the polygon into a path with gaps rather than
      // being drawn at zero.
      var d = "";
      var pen = false;
      pts.concat([pts[0]]).forEach(function (p) {
        if (!p) { pen = false; return; }
        d += (pen ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
        pen = true;
      });
      svg += '<path d="' + d + '" fill="none" stroke="' + series.color + '" stroke-width="2" stroke-dasharray="' + series.dash + '"/>';
      pts.forEach(function (p, i) {
        if (!p) return;
        svg += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="4" fill="' + series.color + '" stroke="#0a0a14" stroke-width="2"><title>' +
          escapeHtml(rows[i].asset + " OI " + HORIZON_LABELS[series.key] + ": " + fmtPct(rows[i].oiChange[series.key])) + "</title></circle>";
      });
    });
    svg += "</svg>";
    var legend = '<div class="oi-radar-legend">' + RADAR_SERIES.map(function (s) {
      return '<span><svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke="' + s.color + '" stroke-width="2" stroke-dasharray="' + s.dash + '"/></svg>OI ' + HORIZON_LABELS[s.key] + "</span>";
    }).join("") + '<span class="oi-muted">Scale ' + fmtPct(lo, 1) + " (centre) → " + fmtPct(hi, 1) + " (edge)</span></div>";
    el.radar.innerHTML = svg + legend;
  }

  // ── detail ────────────────────────────────────────────────

  function renderDetailSelect() {
    var symbols = data ? data.rows.map(function (r) { return r.symbol; }) : [detailSymbol];
    if (symbols.indexOf(detailSymbol) === -1) symbols.unshift(detailSymbol);
    el.detailSymbol.innerHTML = symbols.map(function (s) {
      return '<option value="' + escapeHtml(s) + '"' + (s === detailSymbol ? " selected" : "") + ">" + escapeHtml(asset(s)) + "</option>";
    }).join("");
  }

  function fmtTime(t, interval) {
    var d = new Date(t);
    if (interval === "1d") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /**
   * One line chart on its own axis. Price and OI are drawn as two stacked
   * charts sharing a time range rather than one chart with two y-scales.
   */
  function lineChart(opts) {
    var w = 720, h = opts.height || 180, padL = 8, padR = 64, padT = 10, padB = 20;
    var pts = opts.points.filter(function (p) { return isNum(p.t) && isNum(p.v); });
    if (pts.length < 2) {
      return '<div class="oi-chart-empty">' + escapeHtml(opts.emptyText || "No data") + "</div>";
    }
    var t0 = opts.tMin, t1 = opts.tMax;
    var vs = pts.map(function (p) { return p.v; });
    var v0 = Math.min.apply(null, vs), v1 = Math.max.apply(null, vs);
    if (v1 === v0) { v1 += 1; v0 -= 1; }
    var pad = (v1 - v0) * 0.08; v0 -= pad; v1 += pad;
    function x(t) { return padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR); }
    function y(v) { return padT + (1 - (v - v0) / (v1 - v0)) * (h - padT - padB); }
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p.v).toFixed(1); }).join("");
    var area = opts.area ? d + "L" + x(pts[pts.length - 1].t).toFixed(1) + "," + (h - padB) + "L" + x(pts[0].t).toFixed(1) + "," + (h - padB) + "Z" : "";
    var svg = '<svg class="oi-chart-svg" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" role="img" aria-label="' + escapeHtml(opts.label) + '" data-chart="' + escapeHtml(opts.id) + '">';
    [0, 0.5, 1].forEach(function (f) {
      var v = v0 + (v1 - v0) * f;
      var yy = y(v);
      svg += '<line class="oi-chart-grid" x1="' + padL + '" x2="' + (w - padR) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>' +
        '<text class="oi-chart-tick" x="' + (w - padR + 6) + '" y="' + yy.toFixed(1) + '" dominant-baseline="middle">' + escapeHtml(opts.fmt(v)) + "</text>";
    });
    if (area) svg += '<path class="oi-chart-area" d="' + area + '"/>';
    svg += '<path class="oi-chart-line oi-chart-line--' + escapeHtml(opts.id) + '" d="' + d + '"/>';
    svg += '<line class="oi-chart-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (h - padB) + '" style="display:none"/>';
    svg += '<circle class="oi-chart-dot oi-chart-dot--' + escapeHtml(opts.id) + '" r="4" style="display:none"/>';
    svg += '<text class="oi-chart-tick" x="' + padL + '" y="' + (h - 5) + '">' + escapeHtml(fmtTime(t0, opts.interval)) + "</text>";
    svg += '<text class="oi-chart-tick" x="' + (w - padR) + '" y="' + (h - 5) + '" text-anchor="end">' + escapeHtml(fmtTime(t1, opts.interval)) + "</text>";
    svg += "</svg>";
    return svg;
  }

  var chartState = null;
  var lastDetail = null;

  function renderCharts(detail) {
    var priceCandles = detail.series.price ? detail.series.price.candles : [];
    var oiPoints = detail.series.oi ? detail.series.oi.points : [];
    var times = priceCandles.map(function (c) { return c.t; }).concat(oiPoints.map(function (p) { return p.t; })).filter(isNum);
    if (!times.length) {
      el.charts.innerHTML = window.MarketUI.errorState("No chart data", detail.errors.join(" · "));
      return;
    }
    // Both charts share the overlapping window so the same x is the same time.
    var tMin = Math.max(
      priceCandles.length ? priceCandles[0].t : -Infinity,
      oiPoints.length ? oiPoints[0].t : -Infinity,
    );
    var tMax = Math.max.apply(null, times);
    if (!isFinite(tMin)) tMin = Math.min.apply(null, times);
    var price = priceCandles.filter(function (c) { return c.t >= tMin; }).map(function (c) { return { t: c.t, v: c.c }; });
    var oi = oiPoints.filter(function (p) { return p.t >= tMin; }).map(function (p) { return { t: p.t, v: p.oi, usd: p.oiUsd }; });
    chartState = { tMin: tMin, tMax: tMax, price: price, oi: oi, interval: detail.interval, asset: asset(detail.symbol) };
    el.charts.innerHTML =
      '<div class="oi-chart"><div class="oi-chart-title">Price · ' + escapeHtml(detail.series.price ? detail.series.price.source : "unavailable") + "</div>" +
        lineChart({ id: "price", label: "Price", points: price, tMin: tMin, tMax: tMax, fmt: S.fmtPrice, interval: detail.interval, emptyText: "Price unavailable", height: 170 }) + "</div>" +
      '<div class="oi-chart"><div class="oi-chart-title">Open interest (' + escapeHtml(asset(detail.symbol)) + " coins) · " +
        escapeHtml(detail.series.oi ? detail.series.oi.source.label : "unavailable") + "</div>" +
        lineChart({ id: "oi", label: "Open interest", points: oi, tMin: tMin, tMax: tMax, fmt: fmtCoins, interval: detail.interval, area: true, emptyText: "OI history unavailable from every history venue", height: 140 }) + "</div>" +
      '<div class="oi-chart-readout" id="oi-chart-readout">Hover a chart for values</div>';
    bindCrosshair();
  }

  function nearest(points, t) {
    var best = null;
    for (var i = 0; i < points.length; i += 1) {
      if (!best || Math.abs(points[i].t - t) < Math.abs(best.t - t)) best = points[i];
    }
    return best;
  }

  function bindCrosshair() {
    var svgs = el.charts.querySelectorAll("svg.oi-chart-svg");
    Array.prototype.forEach.call(svgs, function (svg) {
      function move(evt) {
        var rect = svg.getBoundingClientRect();
        var clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
        var vb = svg.viewBox.baseVal;
        var xView = ((clientX - rect.left) / rect.width) * vb.width;
        var plotW = vb.width - 8 - 64;
        var t = chartState.tMin + ((xView - 8) / plotW) * (chartState.tMax - chartState.tMin);
        var p = nearest(chartState.price, t);
        var o = nearest(chartState.oi, t);
        Array.prototype.forEach.call(svgs, function (s) {
          var cross = s.querySelector(".oi-chart-cross");
          cross.setAttribute("x1", xView); cross.setAttribute("x2", xView);
          cross.style.display = "";
        });
        var readout = document.getElementById("oi-chart-readout");
        var ref = p || o;
        readout.textContent = ref ? fmtTime(ref.t, chartState.interval) + " · price " + (p ? S.fmtPrice(p.v) : "—") +
          " · OI " + (o ? fmtCoins(o.v) + " " + chartState.asset + (isNum(o.usd) ? " (" + fmtUsd(o.usd) + ")" : "") : "—") : "";
      }
      function leave() {
        Array.prototype.forEach.call(svgs, function (s) { s.querySelector(".oi-chart-cross").style.display = "none"; });
      }
      svg.addEventListener("mousemove", move);
      svg.addEventListener("touchmove", move, { passive: true });
      svg.addEventListener("mouseleave", leave);
    });
  }

  function stat(label, value, sub) {
    return '<div class="oi-stat"><div class="oi-kpi-label">' + escapeHtml(label) + '</div><div class="oi-stat-value">' + value + "</div>" +
      (sub ? '<div class="oi-kpi-sub">' + sub + "</div>" : "") + "</div>";
  }

  function renderStats(detail) {
    var row = detail.row;
    var h = horizon();
    var html = "";
    html += stat("Current OI", (row.oiUsdBasis === "estimated" ? "≈" : "") + escapeHtml(fmtUsd(row.oiUsd)),
      escapeHtml(fmtCoins(row.oiCoins) + " " + row.asset + (row.source ? " · " + row.source.label : "")));
    html += stat("OI change", HORIZON_KEYS.map(function (k) {
      return '<span class="oi-mini">' + HORIZON_LABELS[k] + ' <span class="' + pctClass(row.oiChange[k]) + '">' + fmtPct(row.oiChange[k]) + "</span></span>";
    }).join(""));
    html += stat("Price change", HORIZON_KEYS.map(function (k) {
      return '<span class="oi-mini">' + HORIZON_LABELS[k] + ' <span class="' + pctClass(row.priceChange[k]) + '">' + fmtPct(row.priceChange[k]) + "</span></span>";
    }).join(""));
    html += stat("Classification " + HORIZON_LABELS[h], stateBadge(row.states[h]), escapeHtml(row.states[h] ? row.states[h].meaning : ""));
    var f = detail.funding;
    html += stat("Funding rate", f ? '<span class="' + pctClass(f.rate) + '">' + fmtPct(f.rate * 100, 4) + "</span>" : "—",
      f ? escapeHtml(f.source.label + (f.nextFundingTime ? " · next " + new Date(f.nextFundingTime).toLocaleTimeString() : "")) : "Not available from any venue");
    var ls = detail.longShort;
    html += stat("Long / short (accounts)", ls && isNum(ls.ratio) ? escapeHtml(ls.ratio.toFixed(2)) : "—",
      ls ? escapeHtml((isNum(ls.longPct) ? ls.longPct.toFixed(1) + "% long · " : "") + ls.source.label + " · 1h") : "Not available from any venue");
    html += stat("Liquidations", '<span class="oi-muted">Unavailable</span>',
      escapeHtml(detail.liquidations.reason) + " · " + detail.liquidations.links.map(function (l) {
        return '<a href="' + escapeHtml(l.href) + '" target="_blank" rel="noopener">' + escapeHtml(l.label) + "</a>";
      }).join(" · "));
    if (row.spike) {
      html += stat("1H spike check", row.spike.isSpike ? '<span class="oi-spike">OI SPIKE</span>' : '<span class="oi-muted">Normal</span>',
        escapeHtml("z " + row.spike.zScore + " over " + row.spike.samples + " samples"));
    }
    var c = row.confluence;
    if (c) {
      var notes = (c.notes && c.notes[h]) || [];
      html += stat("Confluence " + (c.interval || ""),
        (c.bias ? '<span class="oi-bias oi-bias--' + c.bias.toLowerCase() + '">' + escapeHtml(c.bias) + "</span> " : "") +
        (c.extreme && c.extreme.dominant ? '<span class="oi-extreme">' + escapeHtml(c.extreme.dominant.toUpperCase() + " " + c.extreme.state) + "</span>" : ""),
        notes.length ? notes.map(function (n) { return escapeHtml(n.text); }).join("<br />") : "No notable combination");
    }
    html += stat("Freshness", freshBadge(row.freshness), row.asOf ? escapeHtml("OI as of " + new Date(row.asOf).toLocaleTimeString()) : "");
    el.stats.innerHTML = html;
    el.detailFoot.textContent = detail.errors.length ? "Partial data — " + detail.errors.join(" · ") : "";
  }

  function loadDetail(force) {
    var id = ++detailRequest;
    el.detailTitle.textContent = asset(detailSymbol) + " Open Interest";
    el.charts.innerHTML = window.MarketUI.skeletonCard(4);
    el.stats.innerHTML = "";
    Array.prototype.forEach.call(el.detailIntervals.querySelectorAll("[data-interval]"), function (b) {
      var on = b.getAttribute("data-interval") === detailInterval;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var url = "/api/open-interest/" + encodeURIComponent(detailSymbol) + "?interval=" + encodeURIComponent(detailInterval) + (force ? "&force=1" : "");
    fetch(url)
      .then(function (res) { return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || "HTTP " + res.status); return body; }); })
      .then(function (detail) {
        if (id !== detailRequest) return;
        lastDetail = detail;
        renderCharts(detail);
        renderStats(detail);
      })
      .catch(function (err) {
        if (id !== detailRequest) return;
        el.charts.innerHTML = window.MarketUI.errorState("Could not load " + asset(detailSymbol) + " detail", err.message);
      });
  }

  function openDetail(symbol) {
    detailSymbol = symbol;
    renderDetailSelect();
    loadDetail(false);
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.detail.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }

  // ── orchestration ─────────────────────────────────────────

  function renderAll() {
    if (!data) return;
    renderSummary();
    renderSources();
    renderLeaders();
    if (view === "table") renderTable();
    if (view === "heatmap") renderHeatmap();
    if (view === "radar") renderRadar();
  }

  function load(force) {
    el.refresh.disabled = true;
    if (!data) {
      el.kpis.innerHTML = window.MarketUI.skeletonCard(2) + window.MarketUI.skeletonCard(2) + window.MarketUI.skeletonCard(2);
      el.tbody.innerHTML = '<tr class="ss-empty-row"><td colspan="12">Loading open interest…</td></tr>';
    }
    var url = "/api/open-interest?confluence=" + encodeURIComponent(el.confluence.value) + (force ? "&force=1" : "");
    return fetch(url)
      .then(function (res) { return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || "HTTP " + res.status); return body; }); })
      .then(function (body) {
        data = body;
        updated.mark();
        var down = body.sources.filter(function (s) { return s.status === "down"; });
        if (!body.summary.assetsWithOi) {
          showNotice("No venue returned open interest. " + down.map(function (s) { return s.label + ": " + s.error; }).join(" · "), "error");
        } else if (down.length && !body.summary.errorRows && !body.summary.staleRows) {
          showNotice("All " + body.summary.assetsTracked + " assets have OI via fallback venues. Unreachable: " +
            down.map(function (s) { return s.label; }).join(", ") + ".", "warn");
        } else if (down.length || body.summary.errorRows || body.summary.staleRows) {
          showNotice("Partial coverage — " + body.summary.assetsWithOi + " of " + body.summary.assetsTracked + " assets have OI." +
            (down.length ? " Unreachable: " + down.map(function (s) { return s.label; }).join(", ") + "." : "") +
            (body.summary.staleRows ? " " + body.summary.staleRows + " stale row(s) are marked." : ""), "warn");
        } else {
          showNotice("");
        }
        renderDetailSelect();
        renderAll();
      })
      .catch(function (err) {
        showNotice("Could not load open interest: " + err.message, "error");
        if (!data) {
          el.kpis.innerHTML = "";
          el.tbody.innerHTML = '<tr class="ss-error-row"><td colspan="12">' + escapeHtml(err.message) + "</td></tr>";
        }
      })
      .finally(function () { el.refresh.disabled = false; });
  }

  function setView(next) {
    view = next;
    Array.prototype.forEach.call(document.querySelectorAll(".ss-view-tabs[aria-label='Open interest view'] .ss-view-tab"), function (tab) {
      var on = tab.getAttribute("data-view") === view;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-view-panel]"), function (panel) {
      var on = panel.getAttribute("data-view-panel") === view;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    renderAll();
  }

  document.addEventListener("click", function (evt) {
    var tab = evt.target.closest(".ss-view-tab[data-view]");
    if (tab) { setView(tab.getAttribute("data-view")); return; }
    var interval = evt.target.closest("#oi-detail-intervals [data-interval]");
    if (interval) { detailInterval = interval.getAttribute("data-interval"); loadDetail(false); return; }
    var assetBtn = evt.target.closest("[data-symbol].oi-asset-btn, [data-symbol].oi-rank-btn");
    if (assetBtn) openDetail(assetBtn.getAttribute("data-symbol"));
  });

  el.horizon.addEventListener("change", function () {
    horizonMemory.remember();
    renderAll();
    // The detail's numbers don't depend on the horizon; only which of them
    // is highlighted does, so this re-renders rather than refetches.
    if (lastDetail) renderStats(lastDetail);
  });
  el.confluence.addEventListener("change", function () { confluenceMemory.remember(); load(false); });
  el.search.addEventListener("input", function () { if (view === "table") renderTable(); if (view === "heatmap") renderHeatmap(); });
  el.refresh.addEventListener("click", function () { load(true).then(function () { loadDetail(true); }); });
  el.detailSymbol.addEventListener("change", function () { detailSymbol = el.detailSymbol.value; loadDetail(false); });

  horizonMemory.restore();
  confluenceMemory.restore();
  renderDetailSelect();
  load(false);
  loadDetail(false);
})();
