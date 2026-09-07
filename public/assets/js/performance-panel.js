/* Pure logic for the Backtest Lab performance panel: the strategy equity
   curve, the buy-and-hold benchmark beside it, and the zoom/pan/hover state
   that makes the pair readable.

   Everything here is arithmetic on plain objects — no DOM, no network, no
   SVG strings. That is what lets the Node tests exercise the zoom clamp, the
   benchmark alignment and the hover lookup directly, instead of asserting on
   the shape of a rendered markup blob and hoping it means the chart works.
   trading-lab.js owns the rendering and the pointer wiring; this owns what
   the numbers are.

   Loaded as a plain script before trading-lab.js, and required as a module by
   the tests — the same arrangement x-freshness.js uses. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PerformancePanel = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // The plot's internal coordinate width. The SVG is stretched to the card by
  // CSS, so this is a resolution, not a pixel size.
  var PLOT_W = 600;
  var PLOT_H = 200;

  // Never zoom past a window this small a fraction of the run. Below roughly
  // this the chart stops being a chart and becomes two dots, and every pointer
  // gesture lands on the same bar.
  var MIN_SPAN = 0.005;
  // ...and never fewer than this many points on screen, which is what actually
  // matters on a short run where 0.5% is a fraction of one bar.
  var MIN_VISIBLE_POINTS = 3;

  var FULL_VIEW = { start: 0, end: 1 };

  // Number(null) and Number("") are both 0, so a bare isFinite() check would
  // read a missing benchmark value as a real $0 equity and plot the line
  // straight down to the floor. Absent is absent, and gets a gap in the line.
  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  /* ── Model ────────────────────────────────────────────────────────────────
     One normalisation of whatever the API returned, so no downstream caller
     has to re-check whether `performance` exists, whether the benchmark was
     computable, or whether a point is a number. Malformed input produces an
     unavailable model with a reason — never a half-drawn chart. */

  function buildModel(performance) {
    if (!performance || typeof performance !== "object") {
      return empty("This run returned no performance panel.");
    }
    var raw = Array.isArray(performance.series) ? performance.series : [];
    var points = [];
    for (var i = 0; i < raw.length; i += 1) {
      var point = raw[i];
      if (!point || typeof point !== "object") continue;
      var strategy = finite(point.strategy);
      // A point with no strategy equity is not a point on this chart. A
      // benchmark value on its own has nothing to be compared against.
      if (strategy === null) continue;
      // `at` is passed through with its own type intact. Candle timestamps
      // arrive as epoch milliseconds (a number — see signal-screener.js), and
      // String()-ing one produces "1741636800000", which new Date() cannot
      // parse: every tooltip and axis label would print the raw number.
      points.push({ at: point.at === undefined ? null : point.at, strategy: strategy, benchmark: finite(point.benchmark) });
    }

    if (points.length < 2) {
      return empty(
        points.length === 1
          ? "This run produced a single equity point — there is no curve to draw."
          : "This run produced no equity curve.",
      );
    }

    var benchmark = performance.benchmark || {};
    var warnings = [];
    if (!benchmark.available) {
      warnings.push(
        "No buy-and-hold benchmark: " + (benchmark.reason || "it could not be computed for this run") + ".",
      );
    }
    // Emitted by the server when the two curves did not come out the same
    // length. Drawing the shorter benchmark across the full width would
    // silently shift it against the strategy line.
    if (performance.aligned === false) {
      warnings.push(
        "The benchmark covers a different span from the strategy curve; only the " +
          points.length +
          " aligned point(s) are drawn.",
      );
    }
    var strategySummary = performance.strategy || {};
    if (strategySummary.openAtEnd) {
      warnings.push(
        strategySummary.openAtEnd +
          " position(s) were still open at the end. Net P&L here is marked to market, so it differs from the closed-trade figures below.",
      );
    }

    return {
      available: true,
      reason: null,
      points: points,
      hasBenchmark: Boolean(benchmark.available) && points.some(function (p) { return p.benchmark !== null; }),
      startingBalance: finite(performance.startingBalance),
      strategy: strategySummary,
      benchmark: benchmark,
      warnings: warnings,
    };
  }

  function empty(reason) {
    return {
      available: false,
      reason: reason,
      points: [],
      hasBenchmark: false,
      startingBalance: null,
      strategy: {},
      benchmark: {},
      warnings: [],
    };
  }

  /* ── Viewport ─────────────────────────────────────────────────────────────
     A view is a fraction of the index domain: { start: 0, end: 1 } is the
     whole run. Keeping it fractional rather than in indices means a view
     survives a re-render at a different width, and the reset control is
     simply "is this the full view". */

  function fullView() {
    return { start: FULL_VIEW.start, end: FULL_VIEW.end };
  }

  // The smallest span this many points can legibly support, so a 40-bar run
  // cannot be zoomed to a third of a bar.
  function minSpanFor(pointCount) {
    var count = Math.max(2, Number(pointCount) || 2);
    return Math.max(MIN_SPAN, (MIN_VISIBLE_POINTS - 1) / (count - 1));
  }

  // Every view that leaves this module goes through here: ordered, at least
  // one legible span wide, and never hanging off either end of the run.
  function clampView(view, pointCount) {
    var limit = minSpanFor(pointCount);
    var start = finite(view && view.start);
    var end = finite(view && view.end);
    if (start === null || end === null) return fullView();
    if (end < start) {
      var swap = start;
      start = end;
      end = swap;
    }
    var span = clamp(end - start, limit, 1);
    // Grow around the midpoint when the requested window is too narrow, so a
    // clamped zoom stays centred on what the reader aimed at.
    if (end - start < span) {
      var mid = (start + end) / 2;
      start = mid - span / 2;
      end = mid + span / 2;
    }
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > 1) {
      start -= end - 1;
      end = 1;
    }
    return { start: clamp(start, 0, 1), end: clamp(end, 0, 1) };
  }

  /**
   * Zoom about a fixed point.
   *
   * `focusRatio` is where the pointer is, as a fraction of the CURRENT view —
   * that point stays put while everything else moves toward or away from it,
   * which is the behaviour that makes wheel-zoom feel attached to the cursor
   * rather than to the chart's centre. `factor` below 1 zooms in.
   */
  function zoomView(view, focusRatio, factor, pointCount) {
    var current = clampView(view, pointCount);
    var span = current.end - current.start;
    var scale = finite(factor);
    if (scale === null || scale <= 0) return current;
    var focus = clamp(finite(focusRatio) === null ? 0.5 : focusRatio, 0, 1);
    var anchor = current.start + span * focus;
    var next = clamp(span * scale, minSpanFor(pointCount), 1);
    return clampView({ start: anchor - next * focus, end: anchor + next * (1 - focus) }, pointCount);
  }

  /**
   * Pan by a fraction of the VISIBLE span, not of the whole run.
   *
   * Dragging a zoomed-in chart by half its width should move it by half a
   * screen at any zoom level; panning by a fraction of the full domain would
   * make the same gesture fly across the run when zoomed in.
   */
  function panView(view, deltaRatio, pointCount) {
    var current = clampView(view, pointCount);
    var delta = finite(deltaRatio);
    if (delta === null || !delta) return current;
    var span = current.end - current.start;
    var shift = span * delta;
    return clampView({ start: current.start + shift, end: current.end + shift }, pointCount);
  }

  // Whether the Reset Zoom control has anything to do. A hair of floating
  // point drift after a zoom in and back out should not leave it armed.
  function isFullView(view) {
    var current = view || fullView();
    return Math.abs((finite(current.start) || 0) - 0) < 1e-9 && Math.abs((finite(current.end) || 1) - 1) < 1e-9;
  }

  // The points a view actually shows, as an inclusive index range. Rounded
  // outward so the line reaches both edges of the frame instead of stopping
  // short of them.
  function visibleRange(model, view) {
    var count = model.points.length;
    if (count < 2) return { from: 0, to: Math.max(0, count - 1) };
    var current = clampView(view, count);
    var from = Math.max(0, Math.floor(current.start * (count - 1)));
    var to = Math.min(count - 1, Math.ceil(current.end * (count - 1)));
    if (to <= from) to = Math.min(count - 1, from + 1);
    return { from: from, to: to };
  }

  function visiblePoints(model, view) {
    var range = visibleRange(model, view);
    return model.points.slice(range.from, range.to + 1);
  }

  /* ── Geometry ─────────────────────────────────────────────────────────────
     Plot coordinates for the visible window. Both lines share one y scale —
     drawing them on independent scales would let a strategy that lost money
     sit above a benchmark that made money, which is precisely the comparison
     the panel exists to prevent anyone getting wrong. */

  function buildGeometry(model, view, options) {
    var opts = options || {};
    var width = finite(opts.width) || PLOT_W;
    var height = finite(opts.height) || PLOT_H;
    var range = visibleRange(model, view);
    var points = model.points.slice(range.from, range.to + 1);

    var values = [];
    for (var i = 0; i < points.length; i += 1) {
      values.push(points[i].strategy);
      if (points[i].benchmark !== null) values.push(points[i].benchmark);
    }
    // The starting balance is always in frame: the break-even line is the
    // reference both curves are read against, and a chart that scrolls it off
    // the top makes a losing run look like a rising one.
    if (model.startingBalance !== null) values.push(model.startingBalance);

    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || Math.abs(max) || 1;
    var pad = span * 0.08;
    min -= pad;
    max += pad;
    span = max - min;

    function x(index) {
      return points.length < 2 ? 0 : (index / (points.length - 1)) * width;
    }
    function y(value) {
      return height - ((value - min) / span) * height;
    }

    return {
      from: range.from,
      to: range.to,
      points: points,
      width: width,
      height: height,
      min: min,
      max: max,
      // Segments, not one polyline: a gap in the benchmark must break the line
      // rather than be bridged by a straight run across missing bars.
      strategy: segments(points, function (p) { return p.strategy; }, x, y),
      benchmark: model.hasBenchmark ? segments(points, function (p) { return p.benchmark; }, x, y) : [],
      baselineY: model.startingBalance === null ? null : y(model.startingBalance),
      // The y labels the axis prints, top to bottom.
      ticks: buildTicks(min, max, y),
      xAt: x,
      yAt: y,
    };
  }

  function segments(points, valueOf, x, y) {
    var out = [];
    var current = [];
    for (var i = 0; i < points.length; i += 1) {
      var value = valueOf(points[i]);
      if (value === null) {
        if (current.length > 1) out.push(current);
        current = [];
        continue;
      }
      current.push(x(i).toFixed(1) + "," + y(value).toFixed(1));
    }
    if (current.length > 1) out.push(current);
    // A single surviving point still deserves to be seen — drawn as a
    // degenerate two-point segment rather than dropped.
    else if (current.length === 1) out.push([current[0], current[0]]);
    return out;
  }

  function buildTicks(min, max, y) {
    var ticks = [];
    for (var i = 0; i <= 3; i += 1) {
      var value = max - ((max - min) / 3) * i;
      ticks.push({ value: value, y: y(value) });
    }
    return ticks;
  }

  /* ── Hover ────────────────────────────────────────────────────────────────
     One lookup shared by mouse, touch and keyboard, so all three read the same
     bar for the same position and the tooltip can never disagree with the
     crosshair. */

  function pointAtRatio(model, view, ratio) {
    if (!model.available || !model.points.length) return null;
    var range = visibleRange(model, view);
    var count = range.to - range.from;
    var r = clamp(finite(ratio) === null ? 0 : ratio, 0, 1);
    var offset = count < 1 ? 0 : Math.round(r * count);
    var index = Math.min(range.to, range.from + offset);
    var point = model.points[index];
    if (!point) return null;
    return {
      index: index,
      at: point.at,
      strategy: point.strategy,
      benchmark: point.benchmark,
      // Where the crosshair belongs in the CURRENT frame, which is not the
      // pointer's own position: it snaps to the bar being reported.
      ratio: count < 1 ? 0 : (index - range.from) / count,
      // The comparison the tooltip is actually for.
      diff: point.benchmark === null ? null : point.strategy - point.benchmark,
    };
  }

  /* ── Formatting ───────────────────────────────────────────────────────── */

  function formatUsd(value) {
    var n = finite(value);
    if (n === null) return "—";
    return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function formatSignedUsd(value) {
    var n = finite(value);
    if (n === null) return "—";
    return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function formatPct(value) {
    var n = finite(value);
    if (n === null) return "—";
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  // null from metrics.js means "wins and no losses", which is not infinity and
  // not zero. It only earns the ∞ glyph when trades exist to justify it.
  function formatProfitFactor(value, trades) {
    if (value === null || value === undefined) return trades ? "∞" : "—";
    var n = finite(value);
    return n === null ? "—" : n.toFixed(2);
  }

  // Bar timestamps reach this panel in two shapes: epoch milliseconds from the
  // exchange candles, and ISO strings from anything that has been through
  // JSON.stringify of a Date. A numeric string is the trap — new Date() reads
  // "2026" as a year and "1741636800000" as nothing at all — so an all-digit
  // value is converted to a number before it is parsed.
  function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    var input = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    var date = new Date(input);
    return isNaN(date.getTime()) ? null : date;
  }

  function formatDateTime(value) {
    var date = toDate(value);
    if (!date) return value === null || value === undefined || value === "" ? "—" : String(value);
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDay(value) {
    var date = toDate(value);
    if (!date) return value === null || value === undefined || value === "" ? "—" : String(value);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  return {
    PLOT_W: PLOT_W,
    PLOT_H: PLOT_H,
    MIN_VISIBLE_POINTS: MIN_VISIBLE_POINTS,
    buildModel: buildModel,
    fullView: fullView,
    clampView: clampView,
    zoomView: zoomView,
    panView: panView,
    isFullView: isFullView,
    visibleRange: visibleRange,
    visiblePoints: visiblePoints,
    buildGeometry: buildGeometry,
    pointAtRatio: pointAtRatio,
    formatUsd: formatUsd,
    formatSignedUsd: formatSignedUsd,
    formatPct: formatPct,
    formatProfitFactor: formatProfitFactor,
    formatDateTime: formatDateTime,
    formatDay: formatDay,
  };
});
