"use strict";

// Builds one Gann analysis from CLOSED candles and a normalised settings
// object. Pure: the same candles and settings always give the same output,
// so results can be cached by (symbol, timeframe, last closed candle,
// settings) and reproduced later. No fetching, no clock reads.
//
// Every level and window here is geometry, not a forecast. The output says
// where Gann's arithmetic puts a level and how many independent methods
// agree on it; it never says price will go there.

const G = require("../../../public/assets/js/gann-math");
const { rsi, macd } = require("../signal-screener");

const TIMEFRAMES = ["15m", "1h", "4h", "1D", "1W"];
const TIMEFRAME_LABELS = { "15m": "15m", "1h": "1H", "4h": "4H", "1D": "1D", "1W": "1W" };
const BAR_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
};

const DEFAULT_SETTINGS = Object.freeze({
  pivotLeft: 5,
  pivotRight: 5,
  lookback: 150,
  anchorMode: "auto",
  anchorSide: "auto",
  anchorTime: null,
  scaleMode: "atr",
  scaleLength: 14,
  scaleValue: null,
  sq9Step: 45,
  sq9Count: 8,
  sq9Normalise: true,
  cycleTolerance: 2,
  confluenceAtr: 0.25,
  levelRangeAtr: 8,
  horizonBars: 120,
});

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (value == null || value === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Settings from untrusted input, clamped to sane ranges. The normalised
 * object is the cache key, so two requests that mean the same thing share
 * one entry.
 */
function normaliseSettings(input = {}) {
  const d = DEFAULT_SETTINGS;
  const anchorMode = input.anchorMode === "manual" ? "manual" : "auto";
  const anchorSide = ["low", "high"].includes(input.anchorSide) ? input.anchorSide : "auto";
  const scaleMode = ["atr", "range", "manual"].includes(input.scaleMode) ? input.scaleMode : d.scaleMode;
  const anchorTime = anchorMode === "manual" ? clampNum(input.anchorTime, 0, 8.64e15, null) : null;
  const scaleValue = scaleMode === "manual" ? clampNum(input.scaleValue, 1e-12, 1e12, null) : null;
  return {
    pivotLeft: clampInt(input.pivotLeft, 2, 20, d.pivotLeft),
    pivotRight: clampInt(input.pivotRight, 2, 20, d.pivotRight),
    lookback: clampInt(input.lookback, 30, 480, d.lookback),
    anchorMode,
    anchorSide,
    anchorTime,
    scaleMode: scaleMode === "manual" && scaleValue == null ? "atr" : scaleMode,
    scaleLength: clampInt(input.scaleLength, 2, 200, scaleMode === "range" ? 100 : d.scaleLength),
    scaleValue,
    sq9Step: [15, 22.5, 30, 45, 60, 90, 120, 180].includes(Number(input.sq9Step)) ? Number(input.sq9Step) : d.sq9Step,
    sq9Count: clampInt(input.sq9Count, 2, 24, d.sq9Count),
    sq9Normalise: input.sq9Normalise === false || input.sq9Normalise === "false" ? false : true,
    cycleTolerance: clampInt(input.cycleTolerance, 0, 10, d.cycleTolerance),
    confluenceAtr: clampNum(input.confluenceAtr, 0.05, 2, d.confluenceAtr),
    levelRangeAtr: clampNum(input.levelRangeAtr, 2, 30, d.levelRangeAtr),
    horizonBars: clampInt(input.horizonBars, 10, 400, d.horizonBars),
  };
}

function settingsKey(settings) {
  return Object.keys(settings).sort().map((k) => `${k}=${settings[k]}`).join("&");
}

function round(value) {
  return Number.isFinite(value) ? G.roundSig(value, 10) : null;
}

function anchoredVwap(candles, fromIndex, toIndex) {
  let pv = 0;
  let v = 0;
  for (let i = Math.max(0, fromIndex); i <= toIndex; i += 1) {
    const c = candles[i];
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    v += c.volume;
  }
  return v > 0 ? pv / v : null;
}

/**
 * Trend structure from the last two confirmed swing highs and lows.
 * Higher highs and higher lows is UPTREND, lower of both DOWNTREND,
 * anything else RANGE. Unknown without two of each.
 */
function structureOf(pivots) {
  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");
  if (highs.length < 2 || lows.length < 2) return { state: "UNKNOWN", lastHigh: highs[highs.length - 1] || null, lastLow: lows[lows.length - 1] || null };
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  let state = "RANGE";
  if (h2.price > h1.price && l2.price > l1.price) state = "UPTREND";
  else if (h2.price < h1.price && l2.price < l1.price) state = "DOWNTREND";
  return { state, lastHigh: h2, lastLow: l2, higherHigh: h2.price > h1.price, higherLow: l2.price > l1.price };
}

function resolveAnchor(candles, pivots, settings, at) {
  if (settings.anchorMode === "manual" && settings.anchorTime != null) {
    const index = candles.findIndex((c) => c.openTime === settings.anchorTime);
    if (index !== -1 && index <= at) {
      const c = candles[index];
      let type = settings.anchorSide;
      if (type === "auto") {
        // Whichever extreme of that bar sits further from the latest close.
        const last = candles[at].close;
        type = Math.abs(c.high - last) > Math.abs(c.low - last) ? "high" : "low";
      }
      return { index, type, price: type === "high" ? c.high : c.low, time: c.openTime, confirmedIndex: index, source: "manual" };
    }
    // A manual anchor outside the loaded window falls back to auto, reported below.
  }
  const side = settings.anchorSide === "auto" ? undefined : settings.anchorSide;
  const a = G.autoAnchor(candles, pivots, { at, lookback: settings.lookback, side });
  return a ? { ...a, source: "auto" } : null;
}

function counterAnchorOf(candles, pivots, anchor, settings, at) {
  const wanted = anchor.type === "high" ? "low" : "high";
  const from = at - settings.lookback;
  let best = null;
  for (const p of G.pivotsKnownAt(pivots, at)) {
    if (p.type !== wanted || p.index < from || p.index === anchor.index) continue;
    if (!best || (wanted === "high" ? p.price > best.price : p.price < best.price)) best = p;
  }
  return best;
}

/**
 * The full analysis as of the last candle in `candles` (all closed).
 */
function buildAnalysis(candles, { timeframe, settings: rawSettings } = {}) {
  const settings = normaliseSettings(rawSettings);
  const barMs = BAR_MS[timeframe];
  if (!barMs) throw new Error(`Unsupported timeframe "${timeframe}"`);
  const warnings = [];
  const minBars = Math.max(60, settings.pivotLeft + settings.pivotRight + 20);
  if (!Array.isArray(candles) || candles.length < minBars) {
    return { ok: false, reason: `Not enough closed candles (${candles ? candles.length : 0}; need ${minBars})`, settings };
  }

  const last = candles.length - 1;
  const lastCandle = candles[last];
  const pivots = G.findPivots(candles, { left: settings.pivotLeft, right: settings.pivotRight });
  const known = G.pivotsKnownAt(pivots, last);
  const anchor = resolveAnchor(candles, pivots, settings, last);
  if (settings.anchorMode === "manual" && (!anchor || anchor.source !== "manual")) {
    warnings.push("Manual anchor is outside the loaded candles; using the automatic anchor instead.");
  }
  if (!anchor) return { ok: false, reason: "No confirmed swing in the lookback window to anchor on", settings };

  const atr14 = G.atr(candles, 14, last);
  const scale = G.priceTimeScale(candles, {
    mode: settings.scaleMode,
    length: settings.scaleLength,
    value: settings.scaleValue,
    at: last,
  });
  if (!scale) return { ok: false, reason: "Could not derive a price-to-time scale from these candles", settings };

  const counter = counterAnchorOf(candles, pivots, anchor, settings, last);
  const fan = G.gannFan(anchor, scale.value);
  const fanNow = G.fanLevelsAt(fan, last);
  const sq9Price = G.squareOfNine(lastCandle.close, { step: settings.sq9Step, count: settings.sq9Count, normalise: settings.sq9Normalise });
  const sq9Anchor = G.squareOfNine(anchor.price, { step: settings.sq9Step, count: settings.sq9Count * 2, normalise: settings.sq9Normalise });
  const box = counter ? G.gannBox(anchor, counter, { extend: 2 }) : null;
  const range = counter ? Math.abs(anchor.price - counter.price) : null;
  const square = range ? G.gannSquare(anchor, range, scale.value) : null;
  const sq144 = G.squareOf144(anchor, scale.value);
  const fib = counter ? G.fibonacciLevels(counter.index < anchor.index ? counter : anchor, counter.index < anchor.index ? anchor : counter) : [];
  const profile = G.volumeProfile(candles, { to: last, from: Math.max(0, last - 199), bins: 40 });

  const closes = candles.map((c) => c.close);
  const rsiSeries = rsi(closes, 14);
  const macdSeries = macd(closes, 12, 26, 9);
  const vwap = anchoredVwap(candles, anchor.index, last);
  const macdLine = macdSeries.macdLine[last];
  const macdSignal = macdSeries.signalLine[last];
  let volAvg = 0;
  for (let i = Math.max(0, last - 19); i <= last; i += 1) volAvg += candles[i].volume;
  volAvg /= Math.min(20, last + 1);

  // ---- price confluence ---------------------------------------------------
  const band = settings.levelRangeAtr * atr14;
  const lo = lastCandle.close - band;
  const hi = lastCandle.close + band;
  const inBand = (p) => Number.isFinite(p) && p >= lo && p <= hi;
  const levelInputs = [];
  sq9Price.levels.forEach((l) => levelInputs.push({ source: "Square of Nine", label: `SQ9 ${l.degrees > 0 ? "+" : ""}${l.degrees}° from price`, price: l.price }));
  sq9Anchor.levels.forEach((l) => levelInputs.push({ source: "Square of Nine", label: `SQ9 ${l.degrees > 0 ? "+" : ""}${l.degrees}° from anchor`, price: l.price }));
  fanNow.forEach((l) => levelInputs.push({ source: "Gann Fan", label: `Fan ${l.name}`, price: l.price }));
  if (box) box.prices.forEach((l) => levelInputs.push({ source: "Gann Box", label: `Box ${(l.fraction * 100).toFixed(1)}%`, price: l.price }));
  if (sq144) sq144.prices.forEach((l) => levelInputs.push({ source: "Square of 144", label: `SQ144 ${l.division}`, price: l.price }));
  fib.forEach((l) => levelInputs.push({ source: "Fibonacci", label: `Fib ${(l.ratio * 100).toFixed(1)}%`, price: l.price }));
  if (vwap != null) levelInputs.push({ source: "VWAP", label: "Anchored VWAP", price: round(vwap) });
  if (profile) {
    levelInputs.push({ source: "Volume Profile", label: "POC", price: profile.poc });
    levelInputs.push({ source: "Volume Profile", label: "Value area high", price: profile.valueAreaHigh });
    levelInputs.push({ source: "Volume Profile", label: "Value area low", price: profile.valueAreaLow });
  }
  const tolerance = settings.confluenceAtr * atr14;
  const clusters = G.priceConfluence(levelInputs.filter((l) => inBand(l.price)), tolerance)
    .map((c) => ({
      ...c,
      side: c.price >= lastCandle.close ? "resistance" : "support",
      distancePct: round(((c.price - lastCandle.close) / lastCandle.close) * 100),
      distanceAtr: round((c.price - lastCandle.close) / atr14),
    }));
  const supports = clusters.filter((c) => c.side === "support").sort((a, b) => b.price - a.price);
  const resistances = clusters.filter((c) => c.side === "resistance").sort((a, b) => a.price - b.price);

  // ---- time confluence ----------------------------------------------------
  const horizon = last + settings.horizonBars;
  const future = (idx) => idx > last && idx <= horizon;
  const timeAt = (idx) => lastCandle.openTime + (idx - last) * barMs;
  const windows = [];
  const addCycles = (a, tag) => {
    G.timeCycles(a, { barMs, tolerance: settings.cycleTolerance }).forEach((w) => {
      if (!future(w.index)) return;
      windows.push({
        source: w.kind === "bars" ? `Bar cycles (${tag})` : `Calendar cycles (${tag})`,
        label: `${w.label} from ${tag}`,
        index: w.index,
        time: w.kind === "days" ? w.time : timeAt(w.index),
      });
    });
  };
  addCycles(anchor, "anchor");
  if (counter) addCycles(counter, "counter-swing");
  if (box) box.times.forEach((t) => { if (future(t.index)) windows.push({ source: "Gann Box", label: `Box time ${t.fraction}`, index: t.index, time: timeAt(t.index) }); });
  if (square) square.marks.forEach((m) => { if (future(m.index)) windows.push({ source: "Gann Square", label: `Squared ×${m.multiple}`, index: m.index, time: timeAt(m.index) }); });
  if (sq144) sq144.times.forEach((t) => { if (future(t.index)) windows.push({ source: "Square of 144", label: `SQ144 ${t.division} bars`, index: t.index, time: timeAt(t.index) }); });
  const calendar = G.timeConfluence(windows, settings.cycleTolerance)
    .map((c) => ({ ...c, barsAway: c.fromIndex - last, fromTime: timeAt(c.fromIndex), toTime: timeAt(c.toIndex) }));

  // ---- position relative to the fan ---------------------------------------
  const oneByOne = fanNow.find((l) => l.name === "1x1");
  const sortedFan = fanNow.slice().sort((a, b) => a.price - b.price);
  let fanBelow = null;
  let fanAbove = null;
  sortedFan.forEach((l) => {
    if (l.price <= lastCandle.close) fanBelow = l;
    else if (!fanAbove) fanAbove = l;
  });

  return {
    ok: true,
    timeframe,
    timeframeLabel: TIMEFRAME_LABELS[timeframe],
    barMs,
    settings,
    warnings,
    lastClosed: { index: last, openTime: lastCandle.openTime, closeTime: lastCandle.closeTime, close: lastCandle.close },
    atr14: round(atr14),
    scale,
    anchor,
    counterAnchor: counter,
    pivots: known.slice(-40),
    structure: structureOf(known),
    fan,
    fanNow,
    fanPosition: {
      oneByOne: oneByOne ? oneByOne.price : null,
      aboveOneByOne: oneByOne ? (anchor.type === "low" ? lastCandle.close > oneByOne.price : lastCandle.close < oneByOne.price) : null,
      between: [fanBelow ? fanBelow.name : null, fanAbove ? fanAbove.name : null],
    },
    squareOfNine: { fromPrice: sq9Price, fromAnchor: sq9Anchor },
    box,
    square,
    squareOf144: sq144,
    fibonacci: fib,
    volumeProfile: profile,
    indicators: {
      rsi14: round(rsiSeries[last]),
      macd: macdLine == null ? null : { line: round(macdLine), signal: round(macdSignal), histogram: round(macdSignal == null ? null : macdLine - macdSignal) },
      anchoredVwap: round(vwap),
      vwapDistancePct: vwap ? round(((lastCandle.close - vwap) / vwap) * 100) : null,
      volumeRatio: volAvg > 0 ? round(lastCandle.volume / volAvg) : null,
    },
    confluence: {
      tolerance: round(tolerance),
      supports: supports.slice(0, 8),
      resistances: resistances.slice(0, 8),
      matrix: clusters,
    },
    calendar,
  };
}

module.exports = {
  TIMEFRAMES,
  TIMEFRAME_LABELS,
  BAR_MS,
  DEFAULT_SETTINGS,
  normaliseSettings,
  settingsKey,
  structureOf,
  anchoredVwap,
  buildAnalysis,
};
