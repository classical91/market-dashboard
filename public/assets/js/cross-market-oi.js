/**
 * Cross-Market Open Interest.
 *
 * Draws the elliptical comparison: instrument table, numbered instruments
 * around an ellipse, concentric value bands, each value projected along its
 * axis, and the polygon joining them. Every number arrives from
 * /api/cross-market-oi already normalised and labelled with its metricType;
 * this file only selects, scales and draws. A null stays a gap, never zero.
 */
(function () {
  "use strict";

  var UI = window.MarketUI;
  var esc = UI.escapeHtml;
  var SVG_NS = "http://www.w3.org/2000/svg";

  // Categorical identity, fixed order by comparison slot. Validated for the
  // page's near-black surface; identity is always also carried by the slot
  // number, so no instrument is told apart by colour alone.
  var SLOT_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  var STORAGE_KEY = "crossMarketOi.selection";

  var el = {
    metric: document.getElementById("xoi-metric"),
    lookback: document.getElementById("xoi-lookback"),
    timeframe: document.getElementById("xoi-timeframe"),
    tfNote: document.getElementById("xoi-tf-note"),
    refresh: document.getElementById("xoi-refresh"),
    classes: document.getElementById("xoi-classes"),
    notice: document.getElementById("xoi-notice"),
    table: document.getElementById("xoi-table"),
    plot: document.getElementById("xoi-plot"),
    tooltip: document.getElementById("xoi-tooltip"),
    detail: document.getElementById("xoi-detail"),
    source: document.getElementById("xoi-source"),
    edit: document.getElementById("xoi-edit"),
    editCount: document.getElementById("xoi-edit-count"),
    editHint: document.getElementById("xoi-edit-hint"),
    editGroups: document.getElementById("xoi-edit-groups"),
    editReset: document.getElementById("xoi-edit-reset"),
  };

  var state = {
    data: null,
    metric: "OI",
    timeframe: "W",
    lookback: "1w",
    assetClass: "all",
    selection: null,
    selectedId: null,
    loading: false,
  };

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function fmtSigned(v, digits) {
    if (!isNum(v)) return "—";
    var d = digits == null ? 2 : digits;
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
  }

  function fmtInt(v) {
    return isNum(v) ? Math.round(v).toLocaleString() : "—";
  }

  function fmtScale(v) {
    var s = Math.abs(v) % 1 === 0 ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
    return (v > 0 ? "+" : v < 0 ? "−" : "") + s;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  function metricInfo() {
    var list = (state.data && state.data.metrics) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].type === state.metric) return list[i];
    return { type: state.metric, label: state.metric, plotted: "", plottedUnit: "%", defaultScale: 25 };
  }

  // ── selection ────────────────────────────────────────────

  function loadSelection() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (Array.isArray(saved)) return saved;
    } catch (e) { /* private mode or bad JSON: fall back to the reference set */ }
    return null;
  }

  function saveSelection() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.selection)); } catch (e) { /* nothing to persist */ }
  }

  function instrumentsById() {
    var map = {};
    (state.data ? state.data.instruments : []).forEach(function (i) { map[i.id] = i; });
    return map;
  }

  function sanitizeSelection(list) {
    var byId = instrumentsById();
    var limits = state.data.selectionLimits;
    var out = [];
    (list || []).forEach(function (id) { if (byId[id] && out.indexOf(id) === -1 && out.length < limits.max) out.push(id); });
    return out.length >= limits.min ? out : state.data.defaultSelection.slice();
  }

  /** The instruments on the ellipse right now, in slot order. */
  function plottedIds() {
    if (!state.data) return [];
    if (state.assetClass === "all") return state.selection.slice();
    return state.data.instruments
      .filter(function (i) { return i.assetClass === state.assetClass; })
      .slice(0, state.data.selectionLimits.max)
      .map(function (i) { return i.id; });
  }

  function rowFor(id) {
    var rows = state.data ? state.data.rows : [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].id === id && rows[i].metricType === state.metric) return rows[i];
    }
    return null;
  }

  function plotted() {
    return plottedIds().map(function (id, index) {
      return { id: id, slot: index + 1, color: SLOT_COLORS[index % SLOT_COLORS.length], row: rowFor(id) };
    });
  }

  // ── scale ────────────────────────────────────────────────

  /**
   * Symmetric scale: the metric's default (±25 for OI change, ±50 for
   * positioning), widened to the next nice step only when a plotted value
   * would otherwise sit past the outer ring.
   */
  function scaleFor(items) {
    var info = metricInfo();
    var max = 0;
    items.forEach(function (it) {
      var v = it.row && it.row.normalizedValue;
      if (isNum(v)) max = Math.max(max, Math.abs(v));
    });
    var steps = [5, 10, 25, 50, 100, 200, 500];
    // Daily moves are a session's worth: ±1% is a large one. On the weekly
    // ±25 scale every point would sit on the zero ring, so Daily opens at ±5.
    var scale = state.timeframe === "D" && state.metric === "OI" ? 5 : info.defaultScale || 25;
    if (max > scale) {
      for (var i = 0; i < steps.length; i += 1) { if (steps[i] >= max) { scale = steps[i]; break; } }
      if (max > scale) scale = Math.ceil(max / 100) * 100;
    }
    if (state.metric === "COT_NET_SPEC") scale = Math.min(scale, 100);
    return scale;
  }

  // ── geometry ─────────────────────────────────────────────

  var INNER = 0.2; // fraction of the outer radius where −scale sits

  function frac(v, scale) {
    var clamped = Math.max(-scale, Math.min(scale, v));
    return INNER + ((clamped + scale) / (2 * scale)) * (1 - INNER);
  }

  /**
   * The reference Pine script builds its outline from shape = sqrt(1 − x²)
   * over a normalised horizontal basis, then mirrors it for the lower half.
   * Same construction here, sampled into an SVG path.
   */
  function ellipsePath(cx, cy, rx, ry) {
    var n = 96;
    var upper = [];
    for (var i = 0; i <= n; i += 1) {
      var basis = -1 + (2 * i) / n;
      var shape = Math.sqrt(Math.max(0, 1 - basis * basis));
      upper.push([cx + basis * rx, cy - shape * ry]);
    }
    var lower = upper.slice().reverse().map(function (p) { return [p[0], 2 * cy - p[1]]; });
    var pts = upper.concat(lower.slice(1));
    return "M" + pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("L") + "Z";
  }

  function geometry() {
    var mobile = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
    // Wide oval on a desktop, close to a circle on a phone, so the plot fills
    // the screen either way.
    return mobile
      ? { w: 400, h: 430, cx: 200, cy: 212, rx: 148, ry: 156 }
      : { w: 920, h: 520, cx: 460, cy: 262, rx: 330, ry: 196 };
  }

  function angle(i, n) {
    return -Math.PI / 2 + (i / n) * Math.PI * 2;
  }

  function project(g, i, n, f) {
    var a = angle(i, n);
    return [g.cx + Math.cos(a) * g.rx * f, g.cy + Math.sin(a) * g.ry * f];
  }

  // ── rendering ────────────────────────────────────────────

  function renderClasses() {
    var chips = [{ key: "all", label: "All" }].concat(state.data ? state.data.assetClasses : []);
    el.classes.innerHTML = chips.map(function (c) {
      var on = c.key === state.assetClass;
      return '<button type="button" class="xoi-chip' + (on ? " is-active" : "") + '" data-class="' + esc(c.key) +
        '" aria-pressed="' + on + '">' + esc(c.label) + "</button>";
    }).join("");
  }

  function sourceTag() {
    return state.metric === "OI" ? "OI" : "COT";
  }

  function valueText(row) {
    if (!row || row.error) return "—";
    return fmtSigned(row.normalizedValue, 2);
  }

  function subText(row) {
    if (!row) return "";
    if (row.error) return row.error;
    if (row.metricType === "OI") {
      return fmtInt(row.currentValue) + " contracts · Δ " + fmtSigned(row.change, 0) + " vs " + fmtDate(row.previousDate);
    }
    return "Net " + fmtSigned(row.netContracts, 0) + " contracts · Δ " + fmtSigned(row.change, 2) + " pp vs " + fmtDate(row.previousDate);
  }

  function renderTable(items) {
    if (!items.length) {
      el.table.innerHTML = UI.emptyState("No instruments", "Pick at least three under Edit comparison.");
      return;
    }
    el.table.innerHTML = items.map(function (it) {
      var row = it.row;
      var inst = instrumentsById()[it.id] || {};
      var selected = state.selectedId === it.id;
      var v = row && !row.error ? row.normalizedValue : null;
      var tone = isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "flat") : "none";
      var badges = "";
      // The roll distorts total OI, not the long/short split, so the flag
      // belongs to the OI view only.
      if (row && row.rollWindow && state.metric === "OI") badges += '<span class="xoi-badge xoi-badge--roll" title="Quarterly contract near expiry: OI swings are usually the roll">ROLL</span>';
      if (row && row.freshness && row.freshness.state === "STALE") badges += '<span class="xoi-badge xoi-badge--stale" title="' + esc(row.freshness.reason || "") + '">STALE</span>';
      return '<div role="listitem"><button type="button" class="xoi-row' + (selected ? " is-selected" : "") + (row && row.error ? " is-missing" : "") +
        '" data-id="' + esc(it.id) + '" aria-pressed="' + selected + '" style="--slot:' + it.color + '">' +
        '<span class="xoi-slot" aria-hidden="true">' + it.slot + "</span>" +
        '<span class="xoi-tag">' + sourceTag() + "</span>" +
        '<span class="xoi-name"><span class="xoi-name-main">' + esc(String(inst.marketName || it.id).toUpperCase()) + "</span>" +
          '<span class="xoi-name-sub"> · ' + esc(inst.exchange || "") + " · F</span>" + badges +
          '<span class="xoi-row-sub">' + esc(subText(row)) + "</span></span>" +
        '<span class="xoi-value xoi-value--' + tone + '">' + esc(valueText(row)) + "</span>" +
        '<span class="xoi-sr">Instrument ' + it.slot + "</span>" +
        "</button></div>";
    }).join("");
  }

  function svgEl(name, attrs, text) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function renderPlot(items) {
    var g = geometry();
    var n = items.length;
    var scale = scaleFor(items);
    var info = metricInfo();
    var svg = svgEl("svg", {
      viewBox: "0 0 " + g.w + " " + g.h,
      class: "xoi-svg",
      role: "group",
      "aria-label": info.label + " comparison of " + n + " futures markets on a ±" + scale + " scale",
    });

    // Value bands: −scale (inner) … 0 (dashed) … +scale (outer).
    var levels = [-1, -0.5, 0, 0.5, 1];
    levels.forEach(function (l) {
      var f = frac(l * scale, scale);
      svg.appendChild(svgEl("path", {
        d: ellipsePath(g.cx, g.cy, g.rx * f, g.ry * f),
        class: "xoi-ring" + (l === 0 ? " xoi-ring--zero" : "") + (l === 1 ? " xoi-ring--outer" : ""),
      }));
      // Band labels run along the empty bisector between the last and the
      // first instrument, like a ruler, so they never sit under a value.
      var ra = angle(-0.5, Math.max(n, 1));
      svg.appendChild(svgEl("text", {
        x: g.cx + Math.cos(ra) * g.rx * f, y: g.cy + Math.sin(ra) * g.ry * f - 3,
        "text-anchor": "middle", class: "xoi-ring-label",
      }, fmtScale(l * scale)));
    });

    // Dotted radial guides and numbered instrument positions.
    items.forEach(function (it, i) {
      var outer = project(g, i, n, 1);
      svg.appendChild(svgEl("line", { x1: g.cx, y1: g.cy, x2: outer[0], y2: outer[1], class: "xoi-guide" }));
    });

    // The comparison polygon. It is filled only when every market has a
    // value; a missing market breaks the outline rather than being drawn
    // at zero.
    var pts = items.map(function (it, i) {
      var v = it.row && !it.row.error ? it.row.normalizedValue : null;
      return isNum(v) ? project(g, i, n, frac(v, scale)) : null;
    });
    var complete = pts.every(Boolean);
    if (n >= 3 && complete) {
      svg.appendChild(svgEl("polygon", { points: pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: "xoi-poly" }));
    } else {
      var d = "";
      var pen = false;
      pts.concat(n >= 3 ? [pts[0]] : []).forEach(function (p) {
        if (!p) { pen = false; return; }
        d += (pen ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
        pen = true;
      });
      if (d) svg.appendChild(svgEl("path", { d: d, class: "xoi-poly xoi-poly--open" }));
    }

    items.forEach(function (it, i) {
      var row = it.row;
      var v = row && !row.error ? row.normalizedValue : null;
      var label = project(g, i, n, 1.13);
      var selected = state.selectedId === it.id;
      var inst = instrumentsById()[it.id] || {};
      var group = svgEl("g", {
        class: "xoi-node" + (selected ? " is-selected" : "") + (isNum(v) ? "" : " is-missing"),
        tabindex: "0",
        role: "button",
        "data-id": it.id,
        "aria-pressed": String(selected),
        "aria-label": "Instrument " + it.slot + ": " + (inst.marketName || it.id) + " " + (inst.exchange || "") + ", " +
          (isNum(v) ? fmtSigned(v, 2) + " " + info.plottedUnit : "no data"),
      });
      // Numbered badge on the outer edge, in the instrument's slot colour.
      group.appendChild(svgEl("circle", { cx: label[0], cy: label[1], r: 11, class: "xoi-badge-dot", style: "fill:" + it.color }));
      group.appendChild(svgEl("text", { x: label[0], y: label[1] + 4, "text-anchor": "middle", class: "xoi-badge-num" }, String(it.slot)));
      var cos = Math.cos(angle(i, n));
      var anchor = cos > 0.25 ? "start" : cos < -0.25 ? "end" : "middle";
      var dx = anchor === "start" ? 16 : anchor === "end" ? -16 : 0;
      var dy = anchor === "middle" ? (Math.sin(angle(i, n)) < 0 ? -18 : 26) : 4;
      group.appendChild(svgEl("text", { x: label[0] + dx, y: label[1] + dy, "text-anchor": anchor, class: "xoi-axis-label" }, inst.symbol || it.id));
      if (isNum(v)) {
        var p = project(g, i, n, frac(v, scale));
        if (selected) group.appendChild(svgEl("circle", { cx: p[0], cy: p[1], r: 13, class: "xoi-halo" }));
        group.appendChild(svgEl("circle", { cx: p[0], cy: p[1], r: selected ? 7 : 6, class: "xoi-point" }));
        // Outer-half values are labelled on their inward side, so they never
        // land on their own numbered badge; inner-half values outward, so they
        // stay clear of the band ruler near the centre.
        var outward = frac(v, scale) < 0.6;
        var right = (cos >= 0) === outward;
        if (Math.abs(cos) < 0.25) right = true;
        group.appendChild(svgEl("text", {
          x: p[0] + (right ? 10 : -10), y: p[1] - 9, "text-anchor": right ? "start" : "end", class: "xoi-point-label",
        }, fmtSigned(v, 2)));
      }
      // A generous invisible hit target around the badge, for touch.
      group.appendChild(svgEl("circle", { cx: label[0], cy: label[1], r: 22, class: "xoi-hit" }));
      svg.appendChild(group);
    });

    // Corner labels, as on the reference: timeframe and metric.
    var d0 = state.data;
    svg.appendChild(svgEl("text", { x: 14, y: 22, class: "xoi-corner" }, "TF: " + (d0 ? d0.timeframe : "W") + " · Δ " + (d0 ? d0.lookback : "")));
    svg.appendChild(svgEl("text", { x: 14, y: 40, class: "xoi-corner xoi-corner--dim" }, "As of " + fmtDate(d0 && d0.source.reportDate)));
    svg.appendChild(svgEl("text", { x: g.w - 14, y: 22, "text-anchor": "end", class: "xoi-corner" }, info.label));
    svg.appendChild(svgEl("text", { x: g.w - 14, y: 40, "text-anchor": "end", class: "xoi-corner xoi-corner--dim" }, "Scale ±" + scale + " " + info.plottedUnit));

    el.plot.innerHTML = "";
    el.plot.appendChild(svg);
    if (!complete && n) {
      var missing = items.filter(function (it, i) { return !pts[i]; }).map(function (it) { return it.slot; });
      var gap = document.createElement("p");
      gap.className = "xoi-gap-note";
      gap.textContent = "No data for instrument " + missing.join(", ") + ". The shape has a gap there rather than a zero.";
      el.plot.appendChild(gap);
    }
  }

  function renderDetail(items) {
    var it = null;
    items.forEach(function (x) { if (x.id === state.selectedId) it = x; });
    if (!it) {
      el.detail.innerHTML = '<p class="xoi-muted">Tap a numbered instrument or a table row to inspect it. ' + esc(metricInfo().plotted) + ".</p>";
      return;
    }
    var row = it.row;
    var inst = instrumentsById()[it.id] || {};
    if (!row || row.error) {
      el.detail.innerHTML = '<div class="xoi-detail-head" style="--slot:' + it.color + '"><span class="xoi-slot">' + it.slot + "</span>" +
        esc(inst.marketName + " · " + inst.exchange) + "</div>" + UI.errorState("No data", row ? row.error : "Not in the report");
      return;
    }
    var facts = [];
    if (row.metricType === "OI") {
      facts.push(["Open interest", fmtInt(row.currentValue) + " contracts"]);
      facts.push(["Previous (" + fmtDate(row.previousDate) + ")", fmtInt(row.previousValue)]);
      facts.push(["Change", fmtSigned(row.change, 0) + " (" + fmtSigned(row.changePct, 2) + "%)"]);
    } else {
      facts.push(["Net speculator position", fmtSigned(row.currentValue, 2) + "% of OI"]);
      facts.push(["Net contracts", fmtSigned(row.netContracts, 0)]);
      facts.push(["Previous (" + fmtDate(row.previousDate) + ")", fmtSigned(row.previousValue, 2) + "% of OI"]);
      facts.push(["Change", fmtSigned(row.change, 2) + " pp"]);
    }
    facts.push(["Report date", fmtDate(row.observationDate)]);
    facts.push(["CFTC contract", row.contract + (row.reportName ? " · " + row.reportName : "")]);
    facts.push(["Metric", row.metricType + " — " + metricInfo().plotted]);
    el.detail.innerHTML =
      '<div class="xoi-detail-head" style="--slot:' + it.color + '"><span class="xoi-slot">' + it.slot + "</span>" +
        esc(inst.marketName + " · " + inst.exchange) + ' <span class="xoi-muted">' + esc(inst.assetClass) + "</span></div>" +
      '<dl class="xoi-facts">' + facts.map(function (f) { return "<dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd>"; }).join("") + "</dl>" +
      (row.rollWindow && row.metricType === "OI" ? '<p class="xoi-roll-note">Quarterly roll window. A large OI change here is usually contracts moving to the next expiry, not new positioning.</p>' : "");
  }

  var STATUS_TEXT = {
    LIVE: "Live",
    CACHED: "Cached copy — CFTC unreachable",
    STALE: "Stale — CFTC unreachable and the saved report is old",
    UNAVAILABLE: "Unavailable",
  };

  function renderSource() {
    var s = state.data.source;
    var f = state.data.freshness;
    el.source.innerHTML =
      '<span class="xoi-status xoi-status--' + esc(String(s.status).toLowerCase()) + '">' + esc(STATUS_TEXT[s.status] || s.status) + "</span>" +
      '<span>Source: <a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + "</a></span>" +
      "<span>" + esc(s.cadence) + "</span>" +
      "<span>Report as of " + esc(fmtDate(s.reportDate)) + (f && f.state === "STALE" ? ' · <strong class="xoi-stale-text">STALE</strong>' : "") + "</span>" +
      (s.fetchedAt ? "<span>Fetched " + esc(new Date(s.fetchedAt).toLocaleString()) + "</span>" : "") +
      "<span>" + esc(state.data.coverage.withData + " of " + state.data.coverage.markets + " markets reported") + "</span>";
  }

  function renderEdit() {
    var limits = state.data.selectionLimits;
    el.editCount.textContent = "(" + state.selection.length + " of " + limits.max + ")";
    el.editHint.textContent = "Choose " + limits.min + "–" + limits.max + " markets for the All view. Order sets the numbering.";
    el.editGroups.innerHTML = state.data.assetClasses.map(function (c) {
      var inClass = state.data.instruments.filter(function (i) { return i.assetClass === c.key; });
      return '<fieldset class="xoi-edit-group"><legend>' + esc(c.label) + "</legend>" + inClass.map(function (i) {
        var on = state.selection.indexOf(i.id) !== -1;
        var full = !on && state.selection.length >= limits.max;
        var last = on && state.selection.length <= limits.min;
        return '<label class="xoi-check' + (full || last ? " is-locked" : "") + '"><input type="checkbox" data-edit="' + esc(i.id) + '"' +
          (on ? " checked" : "") + (full || last ? " disabled" : "") + " /> " + esc(i.marketName) + ' <span class="xoi-muted">' + esc(i.exchange) + "</span></label>";
      }).join("") + "</fieldset>";
    }).join("");
  }

  function timeframeInfo(key) {
    var list = (state.data && state.data.timeframes) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].key === key) return list[i];
    return null;
  }

  /**
   * Timeframe, lookback and metric controls follow the server: Daily is
   * enabled only when a daily source is configured, lookbacks are the
   * timeframe's own (sessions for Daily, reports for Weekly), and a metric
   * the timeframe cannot serve is disabled rather than shown empty.
   */
  function renderTimeframes() {
    var daily = timeframeInfo("D");
    var dBtn = el.timeframe.querySelector('[data-tf="D"]');
    var dailyOk = Boolean(daily && daily.available);
    dBtn.disabled = !dailyOk;
    dBtn.setAttribute("aria-disabled", String(!dailyOk));
    dBtn.title = dailyOk ? "Exchange open interest per trading session" : (daily && daily.reason) || "Daily is unavailable";
    el.tfNote.hidden = dailyOk;
    el.tfNote.textContent = dailyOk ? "" : "Daily needs a data key";
    el.tfNote.title = dBtn.title;
    setPressed(el.timeframe, "data-tf", state.timeframe);

    var current = timeframeInfo(state.timeframe);
    var lookbacks = (state.data && state.data.lookbacks) || [];
    el.lookback.innerHTML = lookbacks.map(function (l) {
      var on = l.key === state.lookback;
      return '<button type="button" data-lookback="' + esc(l.key) + '" aria-pressed="' + on + '"' + (on ? ' class="is-active"' : "") + ">Δ " + esc(l.label) + "</button>";
    }).join("");

    var allowed = current && current.metrics ? current.metrics : ["OI", "COT_NET_SPEC"];
    Array.prototype.forEach.call(el.metric.querySelectorAll("[data-metric]"), function (b) {
      var ok = allowed.indexOf(b.getAttribute("data-metric")) !== -1;
      b.disabled = !ok;
      b.title = ok ? "" : "COT positioning is published weekly only";
    });
  }

  function render() {
    if (!state.data) return;
    var items = plotted();
    if (state.selectedId && !items.some(function (it) { return it.id === state.selectedId; })) state.selectedId = null;
    renderClasses();
    renderTable(items);
    renderPlot(items);
    renderDetail(items);
    renderSource();
    renderEdit();
    renderTimeframes();
    setPressed(el.metric, "data-metric", state.metric);
  }

  function setPressed(group, attr, value) {
    Array.prototype.forEach.call(group.querySelectorAll("[" + attr + "]"), function (b) {
      var on = b.getAttribute(attr) === value;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  // ── tooltip ──────────────────────────────────────────────

  function showTooltip(id, clientX, clientY) {
    var it = null;
    plotted().forEach(function (x) { if (x.id === id) it = x; });
    if (!it) return;
    var inst = instrumentsById()[id] || {};
    var row = it.row;
    el.tooltip.innerHTML = "<strong>" + it.slot + ". " + esc(inst.marketName + " · " + inst.exchange) + "</strong><br />" +
      esc(row && !row.error ? fmtSigned(row.normalizedValue, 2) + " " + metricInfo().plottedUnit : "No data") +
      '<br /><span class="xoi-muted">' + esc(subText(row)) + "</span>";
    var box = el.plot.getBoundingClientRect();
    el.tooltip.hidden = false;
    var x = Math.min(box.width - 220, Math.max(0, clientX - box.left + 12));
    el.tooltip.style.left = x + "px";
    el.tooltip.style.top = (clientY - box.top + 14) + "px";
  }

  function hideTooltip() { el.tooltip.hidden = true; }

  // ── data ─────────────────────────────────────────────────

  function showNotice(text, tone) {
    el.notice.style.display = text ? "" : "none";
    el.notice.className = "aia-notice xoi-notice" + (tone ? " xoi-notice--" + tone : "");
    el.notice.textContent = text || "";
  }

  function load(force) {
    state.loading = true;
    el.refresh.disabled = true;
    if (!state.data) {
      el.table.innerHTML = UI.skeletonCard(4);
      el.plot.innerHTML = '<div class="xoi-plot-loading">Loading open interest…</div>';
    }
    return fetch("/api/cross-market-oi?timeframe=" + encodeURIComponent(state.timeframe) +
      "&lookback=" + encodeURIComponent(state.lookback) + (force ? "&force=1" : ""))
      .then(function (res) { return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || "HTTP " + res.status); return body; }); })
      .then(function (body) {
        state.data = body;
        state.selection = sanitizeSelection(state.selection || loadSelection() || body.defaultSelection);
        var s = body.source;
        var what = body.timeframe === "D" ? "daily open interest" : "CFTC report";
        if (s.status === "UNAVAILABLE") showNotice("The " + what + " is unavailable and no earlier copy is saved: " + (s.error || "unknown error"), "error");
        else if (s.status === "CACHED" || s.status === "STALE") showNotice("Showing the last saved " + what + " because the latest request failed (" + s.error + ").", "warn");
        else if (body.freshness.state === "STALE") showNotice(body.freshness.reason, "warn");
        else if (body.coverage.withData < body.coverage.markets) showNotice(body.coverage.withData + " of " + body.coverage.markets + " markets are in the latest report; the rest show —.", "warn");
        else showNotice("");
        render();
      })
      .catch(function (err) {
        showNotice("Could not load cross-market open interest: " + err.message, "error");
        if (!state.data) {
          el.table.innerHTML = UI.errorState("Could not load the CFTC report", err.message);
          el.plot.innerHTML = "";
        }
      })
      .finally(function () { state.loading = false; el.refresh.disabled = false; });
  }

  // ── events ───────────────────────────────────────────────

  // Every selection re-renders the table and the plot, which replaces the
  // focused element; focus is put back on the same control in its new DOM.
  function select(id, origin) {
    state.selectedId = state.selectedId === id ? null : id;
    render();
    var target = origin === "plot"
      ? el.plot.querySelector('.xoi-node[data-id="' + id + '"]')
      : el.table.querySelector('.xoi-row[data-id="' + id + '"]');
    if (target) target.focus();
  }

  el.table.addEventListener("click", function (e) {
    var b = e.target.closest("[data-id]");
    if (b) select(b.getAttribute("data-id"), "table");
  });

  el.plot.addEventListener("click", function (e) {
    var node = e.target.closest(".xoi-node");
    if (node) select(node.getAttribute("data-id"), "plot");
  });

  el.plot.addEventListener("keydown", function (e) {
    var node = e.target.closest && e.target.closest(".xoi-node");
    if (!node) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(node.getAttribute("data-id"), "plot");
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      var nodes = Array.prototype.slice.call(el.plot.querySelectorAll(".xoi-node"));
      var i = nodes.indexOf(node);
      var next = nodes[(i + (e.key === "ArrowRight" ? 1 : nodes.length - 1)) % nodes.length];
      if (next) next.focus();
    }
  });

  el.plot.addEventListener("mousemove", function (e) {
    var node = e.target.closest && e.target.closest(".xoi-node");
    if (node) showTooltip(node.getAttribute("data-id"), e.clientX, e.clientY);
    else hideTooltip();
  });
  el.plot.addEventListener("mouseleave", hideTooltip);
  el.plot.addEventListener("focusin", function (e) {
    var node = e.target.closest && e.target.closest(".xoi-node");
    if (!node) return;
    var r = node.getBoundingClientRect();
    showTooltip(node.getAttribute("data-id"), r.left + r.width / 2, r.top + r.height / 2);
  });
  el.plot.addEventListener("focusout", hideTooltip);

  el.metric.addEventListener("click", function (e) {
    var b = e.target.closest("[data-metric]");
    if (!b) return;
    state.metric = b.getAttribute("data-metric");
    render();
  });

  el.timeframe.addEventListener("click", function (e) {
    var b = e.target.closest("[data-tf]");
    if (!b || b.disabled || b.getAttribute("data-tf") === state.timeframe) return;
    state.timeframe = b.getAttribute("data-tf");
    state.lookback = state.timeframe === "D" ? "1d" : "1w";
    // Positioning is weekly-only; Daily always opens on open interest.
    if (state.timeframe === "D") state.metric = "OI";
    setPressed(el.timeframe, "data-tf", state.timeframe);
    load(false);
  });

  el.lookback.addEventListener("click", function (e) {
    var b = e.target.closest("[data-lookback]");
    if (!b || b.getAttribute("data-lookback") === state.lookback) return;
    state.lookback = b.getAttribute("data-lookback");
    setPressed(el.lookback, "data-lookback", state.lookback);
    load(false);
  });

  el.classes.addEventListener("click", function (e) {
    var b = e.target.closest("[data-class]");
    if (!b) return;
    state.assetClass = b.getAttribute("data-class");
    render();
  });

  el.editGroups.addEventListener("change", function (e) {
    var box = e.target.closest("[data-edit]");
    if (!box) return;
    var id = box.getAttribute("data-edit");
    var at = state.selection.indexOf(id);
    if (box.checked && at === -1) state.selection.push(id);
    if (!box.checked && at !== -1) state.selection.splice(at, 1);
    state.selection = sanitizeSelection(state.selection);
    state.assetClass = "all";
    saveSelection();
    render();
  });

  el.editReset.addEventListener("click", function () {
    state.selection = state.data.defaultSelection.slice();
    state.assetClass = "all";
    saveSelection();
    render();
  });

  el.refresh.addEventListener("click", function () { load(true); });

  // The SVG scales with its viewBox, so a resize only needs a redraw when it
  // crosses the phone breakpoint and the ellipse changes shape. Keyboard
  // focus on a plot node survives the redraw.
  var lastShape = geometry().w;
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      if (!state.data || geometry().w === lastShape) return;
      lastShape = geometry().w;
      var active = document.activeElement;
      var focusedId = active && active.closest && active.closest(".xoi-node") ? active.getAttribute("data-id") : null;
      renderPlot(plotted());
      if (focusedId) {
        var node = el.plot.querySelector('.xoi-node[data-id="' + focusedId + '"]');
        if (node) node.focus();
      }
    }, 150);
  });

  load(false);
})();
