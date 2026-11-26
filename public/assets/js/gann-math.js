/**
 * Gann geometry — pure, deterministic arithmetic shared by the server
 * (src/services/gann/*) and the Gann Intelligence page, so a level drawn in
 * the browser and a level reported to TraderClaw are the same number.
 *
 * Everything here works in DATA space — bar index and price — never in
 * pixels. A fan line is "price = anchor + slope × bars elapsed", so zooming
 * or resizing the chart changes where it is drawn, never what it says.
 *
 * Nothing in this file fetches, caches or predicts. Each function maps its
 * inputs to geometry; whether that geometry means anything for a market is
 * what the backtest (src/services/gann/backtest.js) exists to measure.
 * Formulas and assumptions are documented in docs/gann-intelligence.md.
 */
(function (global) {
  "use strict";

  // Fan angles as price-units : time-units multiples of the 1x1. "2x1" moves
  // two units of price per unit of time (steeper); "1x2" one unit of price
  // per two units of time (flatter).
  var FAN_ANGLES = [
    { name: "8x1", ratio: 8 },
    { name: "4x1", ratio: 4 },
    { name: "3x1", ratio: 3 },
    { name: "2x1", ratio: 2 },
    { name: "1x1", ratio: 1 },
    { name: "1x2", ratio: 1 / 2 },
    { name: "1x3", ratio: 1 / 3 },
    { name: "1x4", ratio: 1 / 4 },
    { name: "1x8", ratio: 1 / 8 },
  ];

  // Eighths and thirds — Gann's price/time divisions for boxes and ranges.
  var GANN_FRACTIONS = [0, 0.125, 0.25, 1 / 3, 0.375, 0.5, 0.625, 2 / 3, 0.75, 0.875, 1];

  // The Square of 144's divisions of its side (eighths and thirds of 144).
  var SQ144_DIVISIONS = [18, 36, 48, 54, 72, 90, 96, 108, 126, 144];

  // Bar-count cycles counted from an anchor. Gann's "natural" numbers plus
  // the 144 and 360 rotations.
  var DEFAULT_CYCLE_BARS = [30, 45, 60, 90, 120, 144, 180, 270, 360];
  // Calendar-day cycles, counted in real time from the anchor's timestamp
  // independently of the chart timeframe.
  var DEFAULT_CYCLE_DAYS = [30, 45, 60, 90, 120, 144, 180, 270, 360];

  var FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  var DAY_MS = 24 * 60 * 60 * 1000;

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  /** Round to a fixed number of significant digits so outputs are stable across platforms. */
  function roundSig(value, digits) {
    if (!isNum(value) || value === 0) return value;
    var d = digits || 10;
    return Number(value.toPrecision(d));
  }

  // ---------------------------------------------------------------------
  // Square of Nine
  // ---------------------------------------------------------------------

  /**
   * The power of ten that brings a price into [100, 1000), used when a
   * price is normalised before the square-root arithmetic. Square of Nine
   * steps are a fixed distance in √price, so the raw step on 90,000 is 0.2%
   * and on 0.0003 is enormous; normalising keeps the wheel's spacing
   * comparable across assets. The factor is always reported with the levels.
   */
  function normalisationFactor(price) {
    if (!isNum(price) || price <= 0) return 1;
    var exp = Math.floor(Math.log10(price)) - 2;
    return Math.pow(10, -exp);
  }

  /** Price at `degrees` around the wheel from `base`: (√base + deg/180)². */
  function sq9PriceAt(base, degrees) {
    if (!isNum(base) || base <= 0 || !isNum(degrees)) return null;
    var root = Math.sqrt(base) + degrees / 180;
    if (root <= 0) return null;
    return root * root;
  }

  /** Position of a price on the wheel, 0–360°, with 1 at 0°. */
  function sq9Degree(price) {
    if (!isNum(price) || price <= 0) return null;
    var deg = ((Math.sqrt(price) - 1) * 180) % 360;
    if (deg < 0) deg += 360;
    return roundSig(deg, 10);
  }

  /**
   * Levels above and below `price` at every `step` degrees, `count` each way.
   * `normalise` divides the price into [100, 1000) first and scales the
   * levels back, so the result is in the caller's units either way.
   */
  function squareOfNine(price, opts) {
    var o = opts || {};
    var step = isNum(o.step) && o.step > 0 ? o.step : 45;
    var count = isNum(o.count) && o.count > 0 ? Math.min(Math.floor(o.count), 64) : 8;
    var normalise = o.normalise !== false;
    if (!isNum(price) || price <= 0) return { price: price, factor: 1, step: step, levels: [] };
    var factor = normalise ? normalisationFactor(price) : 1;
    var base = price * factor;
    var levels = [];
    for (var k = 1; k <= count; k += 1) {
      var up = sq9PriceAt(base, k * step);
      var down = sq9PriceAt(base, -k * step);
      if (up != null) levels.push({ price: roundSig(up / factor, 10), degrees: k * step, direction: "resistance", cardinal: (k * step) % 90 === 0 });
      if (down != null) levels.push({ price: roundSig(down / factor, 10), degrees: -k * step, direction: "support", cardinal: (k * step) % 90 === 0 });
    }
    levels.sort(function (a, b) { return a.price - b.price; });
    return { price: price, factor: factor, normalisedPrice: roundSig(base, 10), degree: sq9Degree(base), step: step, levels: levels };
  }

  // ---------------------------------------------------------------------
  // Swings (confirmed pivots — never repaint)
  // ---------------------------------------------------------------------

  /**
   * Pivot highs/lows with `left` bars before and `right` bars after. A pivot
   * at index i is only knowable once bar i + right has closed, recorded as
   * `confirmedIndex`. Any consumer evaluating bar t must only use pivots with
   * confirmedIndex <= t — that is the whole repaint / look-ahead rule.
   */
  function findPivots(candles, opts) {
    var o = opts || {};
    var left = isNum(o.left) ? Math.max(1, Math.floor(o.left)) : 5;
    var right = isNum(o.right) ? Math.max(1, Math.floor(o.right)) : 5;
    var pivots = [];
    var n = candles ? candles.length : 0;
    for (var i = left; i < n - right; i += 1) {
      var isHigh = true;
      var isLow = true;
      for (var j = i - left; j <= i + right; j += 1) {
        if (j === i) continue;
        // Ties break toward the earlier bar so equal highs yield one pivot.
        if (j < i ? candles[j].high >= candles[i].high : candles[j].high > candles[i].high) isHigh = false;
        if (j < i ? candles[j].low <= candles[i].low : candles[j].low < candles[i].low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) pivots.push({ index: i, type: "high", price: candles[i].high, time: candles[i].openTime, confirmedIndex: i + right });
      if (isLow) pivots.push({ index: i, type: "low", price: candles[i].low, time: candles[i].openTime, confirmedIndex: i + right });
    }
    return pivots;
  }

  /** Pivots knowable at the close of bar `t`. */
  function pivotsKnownAt(pivots, t) {
    return pivots.filter(function (p) { return p.confirmedIndex <= t; });
  }

  /**
   * The automatic anchor: the most extreme confirmed pivot inside the last
   * `lookback` bars as of bar `t` — the highest high and lowest low — and of
   * those two, the more recent one (the swing the current leg started from).
   */
  function autoAnchor(candles, pivots, opts) {
    var o = opts || {};
    var t = isNum(o.at) ? o.at : candles.length - 1;
    var lookback = isNum(o.lookback) ? o.lookback : 150;
    var from = t - lookback;
    var known = pivotsKnownAt(pivots, t).filter(function (p) { return p.index >= from; });
    var hi = null;
    var lo = null;
    known.forEach(function (p) {
      if (p.type === "high" && (!hi || p.price > hi.price)) hi = p;
      if (p.type === "low" && (!lo || p.price < lo.price)) lo = p;
    });
    if (o.side === "high") return hi;
    if (o.side === "low") return lo;
    if (!hi) return lo;
    if (!lo) return hi;
    return hi.index > lo.index ? hi : lo;
  }

  // ---------------------------------------------------------------------
  // Price-to-time scale
  // ---------------------------------------------------------------------

  function atr(candles, length, endIndex) {
    var len = length || 14;
    var end = isNum(endIndex) ? endIndex : candles.length - 1;
    var start = Math.max(1, end - len + 1);
    var sum = 0;
    var count = 0;
    for (var i = start; i <= end; i += 1) {
      var c = candles[i];
      var prev = candles[i - 1].close;
      sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
      count += 1;
    }
    return count ? sum / count : null;
  }

  /**
   * Price units per bar for the 1x1. Modes:
   *   atr    — mean true range over `length` bars ending at `at` (default)
   *   range  — (highest high − lowest low) / bars, over `length` bars
   *   manual — `value` as given
   * The result depends only on closed candles up to `at`, never on the view.
   */
  function priceTimeScale(candles, opts) {
    var o = opts || {};
    var mode = o.mode || "atr";
    var at = isNum(o.at) ? o.at : candles.length - 1;
    if (mode === "manual") {
      return isNum(o.value) && o.value > 0 ? { mode: "manual", value: o.value } : null;
    }
    var length = isNum(o.length) ? Math.max(2, Math.floor(o.length)) : (mode === "range" ? 100 : 14);
    if (at < 1) return null;
    if (mode === "range") {
      var from = Math.max(0, at - length + 1);
      var hi = -Infinity;
      var lo = Infinity;
      for (var i = from; i <= at; i += 1) {
        if (candles[i].high > hi) hi = candles[i].high;
        if (candles[i].low < lo) lo = candles[i].low;
      }
      var bars = at - from + 1;
      return hi > lo ? { mode: "range", length: bars, value: roundSig((hi - lo) / bars, 10) } : null;
    }
    var v = atr(candles, length, at);
    return v > 0 ? { mode: "atr", length: length, value: roundSig(v, 10) } : null;
  }

  // ---------------------------------------------------------------------
  // Fan, box, square, Square of 144
  // ---------------------------------------------------------------------

  /** Fan line value at bar index `i`. Direction +1 fans up from a low, −1 down from a high. */
  function fanPriceAt(line, i) {
    return line.anchorPrice + line.direction * line.slope * (i - line.anchorIndex);
  }

  function gannFan(anchor, scale) {
    if (!anchor || !isNum(scale) || scale <= 0) return [];
    var direction = anchor.type === "high" ? -1 : 1;
    return FAN_ANGLES.map(function (a) {
      return {
        name: a.name,
        ratio: a.ratio,
        slope: roundSig(a.ratio * scale, 10),
        direction: direction,
        anchorIndex: anchor.index,
        anchorPrice: anchor.price,
      };
    });
  }

  /** Every fan line evaluated at bar `i`, positive prices only. */
  function fanLevelsAt(lines, i) {
    return lines
      .map(function (l) { return { name: l.name, price: roundSig(fanPriceAt(l, i), 10) }; })
      .filter(function (l) { return l.price > 0; });
  }

  /**
   * Gann Box between two anchors: price levels at Gann fractions of the
   * price range, and time marks at the same fractions of the bar span,
   * repeated forward `extend` box-widths past the second anchor.
   */
  function gannBox(a, b, opts) {
    if (!a || !b || a.index === b.index) return null;
    var first = a.index < b.index ? a : b;
    var second = a.index < b.index ? b : a;
    var extend = (opts && isNum(opts.extend)) ? opts.extend : 1;
    var hi = Math.max(first.price, second.price);
    var lo = Math.min(first.price, second.price);
    var span = second.index - first.index;
    var prices = GANN_FRACTIONS.map(function (f) { return { fraction: roundSig(f, 6), price: roundSig(lo + (hi - lo) * f, 10) }; });
    var times = [];
    for (var r = 0; r <= extend; r += 1) {
      GANN_FRACTIONS.forEach(function (f) {
        if (r > 0 && f === 0) return;
        times.push({ fraction: roundSig(r + f, 6), index: Math.round(first.index + span * (r + f)) });
      });
    }
    return { startIndex: first.index, endIndex: second.index, high: hi, low: lo, prices: prices, times: times };
  }

  /**
   * Squaring price with time: the bar count at which the time elapsed from
   * the anchor equals the price range measured in 1x1 units, and its
   * quarter multiples. `range` defaults to the anchor-to-opposite-extreme move.
   */
  function gannSquare(anchor, range, scale) {
    if (!anchor || !isNum(range) || range <= 0 || !isNum(scale) || scale <= 0) return null;
    var side = range / scale;
    var marks = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(function (m) {
      return { multiple: m, index: Math.round(anchor.index + side * m) };
    });
    return { anchorIndex: anchor.index, range: roundSig(range, 10), squareBars: roundSig(side, 8), marks: marks };
  }

  /**
   * Square of 144: a 144 × 144 grid whose time side is 144 bars and whose
   * price side is 144 × `unit` (default: the 1x1 scale). Divisions at the
   * eighths and thirds of 144 give both price levels and time marks.
   */
  function squareOf144(anchor, unit) {
    if (!anchor || !isNum(unit) || unit <= 0) return null;
    var direction = anchor.type === "high" ? -1 : 1;
    var prices = [];
    var times = [];
    SQ144_DIVISIONS.forEach(function (d) {
      var p = anchor.price + direction * d * unit;
      if (p > 0) prices.push({ division: d, price: roundSig(p, 10) });
      times.push({ division: d, index: anchor.index + d });
    });
    return { anchorIndex: anchor.index, unit: roundSig(unit, 10), direction: direction, prices: prices, times: times };
  }

  // ---------------------------------------------------------------------
  // Time cycles
  // ---------------------------------------------------------------------

  /**
   * Cycle windows from an anchor, in both bar counts and calendar days.
   * `barMs` converts between the two; `tolerance` widens each window to
   * ±tolerance bars, because a cycle date is a zone, not an instant.
   */
  function timeCycles(anchor, opts) {
    var o = opts || {};
    if (!anchor || !isNum(o.barMs) || o.barMs <= 0) return [];
    var tol = isNum(o.tolerance) ? o.tolerance : 2;
    var bars = o.bars || DEFAULT_CYCLE_BARS;
    var days = o.days || DEFAULT_CYCLE_DAYS;
    var out = [];
    bars.forEach(function (n) {
      out.push({
        kind: "bars",
        length: n,
        label: n + " bars",
        index: anchor.index + n,
        time: anchor.time + n * o.barMs,
        fromIndex: anchor.index + n - tol,
        toIndex: anchor.index + n + tol,
      });
    });
    days.forEach(function (d) {
      var barsAway = (d * DAY_MS) / o.barMs;
      // Only meaningful where a day is at least one bar; on 1W a 30-day cycle is ~4 bars.
      var idx = anchor.index + Math.round(barsAway);
      out.push({
        kind: "days",
        length: d,
        label: d + " days",
        index: idx,
        time: anchor.time + d * DAY_MS,
        fromIndex: idx - tol,
        toIndex: idx + tol,
      });
    });
    out.sort(function (a, b) { return a.time - b.time || a.index - b.index; });
    return out;
  }

  // ---------------------------------------------------------------------
  // Supporting technicals (pure)
  // ---------------------------------------------------------------------

  function fibonacciLevels(a, b) {
    if (!a || !b) return [];
    var first = a.index <= b.index ? a : b;
    var second = a.index <= b.index ? b : a;
    var move = second.price - first.price;
    return FIB_RATIOS.map(function (r) {
      // Retracement from the second anchor back toward the first.
      return { ratio: r, price: roundSig(second.price - move * r, 10) };
    });
  }

  /**
   * Volume profile over candles[from..to]: each bar's volume spread evenly
   * across the bins its high–low range covers. Returns bins, point of
   * control and the 70% value area.
   */
  function volumeProfile(candles, opts) {
    var o = opts || {};
    var binsCount = isNum(o.bins) ? Math.max(5, Math.floor(o.bins)) : 40;
    var to = isNum(o.to) ? o.to : candles.length - 1;
    var from = isNum(o.from) ? Math.max(0, o.from) : Math.max(0, to - 199);
    if (to < from) return null;
    var hi = -Infinity;
    var lo = Infinity;
    for (var i = from; i <= to; i += 1) {
      if (candles[i].high > hi) hi = candles[i].high;
      if (candles[i].low < lo) lo = candles[i].low;
    }
    if (!(hi > lo)) return null;
    var width = (hi - lo) / binsCount;
    var bins = [];
    for (var b = 0; b < binsCount; b += 1) bins.push({ low: lo + b * width, high: lo + (b + 1) * width, volume: 0 });
    var total = 0;
    for (var k = from; k <= to; k += 1) {
      var c = candles[k];
      var lowBin = Math.min(binsCount - 1, Math.floor((c.low - lo) / width));
      var highBin = Math.min(binsCount - 1, Math.floor((c.high - lo) / width));
      var share = (c.volume || 0) / (highBin - lowBin + 1);
      for (var x = lowBin; x <= highBin; x += 1) bins[x].volume += share;
      total += c.volume || 0;
    }
    var poc = 0;
    for (var p = 1; p < binsCount; p += 1) if (bins[p].volume > bins[poc].volume) poc = p;
    // Value area: grow outward from the POC, taking the heavier neighbour, to 70%.
    var inArea = bins[poc].volume;
    var vaLow = poc;
    var vaHigh = poc;
    while (total > 0 && inArea < total * 0.7 && (vaLow > 0 || vaHigh < binsCount - 1)) {
      var below = vaLow > 0 ? bins[vaLow - 1].volume : -1;
      var above = vaHigh < binsCount - 1 ? bins[vaHigh + 1].volume : -1;
      if (above >= below) { vaHigh += 1; inArea += above; } else { vaLow -= 1; inArea += below; }
    }
    return {
      from: from,
      to: to,
      bins: bins.map(function (bin) { return { low: roundSig(bin.low, 10), high: roundSig(bin.high, 10), volume: roundSig(bin.volume, 10) }; }),
      poc: roundSig((bins[poc].low + bins[poc].high) / 2, 10),
      valueAreaLow: roundSig(bins[vaLow].low, 10),
      valueAreaHigh: roundSig(bins[vaHigh].high, 10),
    };
  }

  // ---------------------------------------------------------------------
  // Confluence
  // ---------------------------------------------------------------------

  /**
   * Groups price levels from different sources that sit within `tolerance`
   * price units of each other. A cluster's `sources` lists DISTINCT methods
   * — five Square of Nine levels in one zone are one source, not five — so
   * `sourceCount` counts independent agreement. It is a count, not a
   * probability.
   */
  function priceConfluence(levels, tolerance) {
    var tol = isNum(tolerance) && tolerance > 0 ? tolerance : 0;
    var sorted = (levels || []).filter(function (l) { return l && isNum(l.price); }).slice().sort(function (a, b) {
      return a.price - b.price || String(a.source).localeCompare(String(b.source)) || String(a.label).localeCompare(String(b.label));
    });
    var clusters = [];
    var current = null;
    sorted.forEach(function (l) {
      if (current && l.price - current.members[0].price <= tol) {
        current.members.push(l);
      } else {
        current = { members: [l] };
        clusters.push(current);
      }
    });
    return clusters.map(function (c) {
      var sum = 0;
      var sources = [];
      c.members.forEach(function (m) {
        sum += m.price;
        if (sources.indexOf(m.source) === -1) sources.push(m.source);
      });
      sources.sort();
      return {
        price: roundSig(sum / c.members.length, 10),
        low: c.members[0].price,
        high: c.members[c.members.length - 1].price,
        sources: sources,
        sourceCount: sources.length,
        members: c.members.map(function (m) { return { source: m.source, label: m.label, price: m.price }; }),
      };
    });
  }

  /** Same idea for time: cycle windows from different sources landing within `tolerance` bars. */
  function timeConfluence(windows, tolerance) {
    var tol = isNum(tolerance) ? tolerance : 2;
    var sorted = (windows || []).filter(function (w) { return w && isNum(w.index); }).slice().sort(function (a, b) {
      return a.index - b.index || String(a.source).localeCompare(String(b.source)) || String(a.label).localeCompare(String(b.label));
    });
    var clusters = [];
    var current = null;
    sorted.forEach(function (w) {
      if (current && w.index - current.members[0].index <= tol) current.members.push(w);
      else { current = { members: [w] }; clusters.push(current); }
    });
    return clusters.map(function (c) {
      var sources = [];
      c.members.forEach(function (m) { if (sources.indexOf(m.source) === -1) sources.push(m.source); });
      sources.sort();
      var idx = c.members.map(function (m) { return m.index; });
      return {
        fromIndex: Math.min.apply(null, idx),
        toIndex: Math.max.apply(null, idx),
        time: c.members[0].time,
        sources: sources,
        sourceCount: sources.length,
        members: c.members.map(function (m) { return { source: m.source, label: m.label, index: m.index, time: m.time }; }),
      };
    });
  }

  var api = {
    FAN_ANGLES: FAN_ANGLES,
    GANN_FRACTIONS: GANN_FRACTIONS,
    SQ144_DIVISIONS: SQ144_DIVISIONS,
    DEFAULT_CYCLE_BARS: DEFAULT_CYCLE_BARS,
    DEFAULT_CYCLE_DAYS: DEFAULT_CYCLE_DAYS,
    FIB_RATIOS: FIB_RATIOS,
    roundSig: roundSig,
    normalisationFactor: normalisationFactor,
    sq9PriceAt: sq9PriceAt,
    sq9Degree: sq9Degree,
    squareOfNine: squareOfNine,
    findPivots: findPivots,
    pivotsKnownAt: pivotsKnownAt,
    autoAnchor: autoAnchor,
    atr: atr,
    priceTimeScale: priceTimeScale,
    fanPriceAt: fanPriceAt,
    gannFan: gannFan,
    fanLevelsAt: fanLevelsAt,
    gannBox: gannBox,
    gannSquare: gannSquare,
    squareOf144: squareOf144,
    timeCycles: timeCycles,
    fibonacciLevels: fibonacciLevels,
    volumeProfile: volumeProfile,
    priceConfluence: priceConfluence,
    timeConfluence: timeConfluence,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.GannMath = api;
})(typeof window !== "undefined" ? window : null);
