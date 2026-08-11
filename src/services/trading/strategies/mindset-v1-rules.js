"use strict";

// The mindset_v1 signal rules.
//
// This file exists so that exactly one copy of these rules is reachable from
// both directions: the live scanner runs them forward on Bitget candles, and
// the strategy registry replays them in the backtester. They used to live in
// live-scanner.js, which meant the registry had to require the scanner — and
// once the scanner needed to consult the registry to check eligibility, that
// became a require cycle. Extracting the rules breaks it, and the scanner and
// registry now both depend on this leaf instead of on each other.
//
// Behaviour is unchanged by the move: this is the same code, and the same
// tests cover it through both entry points.

const { ema, rsi, macd } = require("../../signal-screener");

function sma(values, length, endIndex) {
  if (endIndex < length - 1) return null;
  let sum = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

// Wilder ATR as a series. Seeded with the SMA of the first `length` true
// ranges, so its last value equals decision-engine.js's atr() over the same
// candles — one ATR definition across the codebase, asserted in the tests.
function atrSeries(candles, length = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < length + 1) return out;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  let value = trs.slice(0, length).reduce((sum, tr) => sum + tr, 0) / length;
  out[length] = value; // trs[i] corresponds to candles[i + 1]
  for (let i = length; i < trs.length; i++) {
    value = (value * (length - 1) + trs[i]) / length;
    out[i + 1] = value;
  }
  return out;
}

const MINDSET_V1_DEFAULTS = {
  fastLen: 20,
  slowLen: 50,
  rsiLen: 14,
  atrLen: 14,
  atrAvgLen: 20,
  volLen: 20,
  // RSI must agree with the EMA trend, but not be so stretched that the entry
  // is a chase. The upper/lower guards are what keep a runaway bar from
  // opening a position at the exact moment the move is exhausted.
  rsiLongMin: 50,
  rsiLongMax: 75,
  rsiShortMax: 50,
  rsiShortMin: 25,
};

/**
 * MVP "mindset_v1" strategy: EMA20/EMA50 trend direction with an RSI filter.
 *
 * Deliberately simple — it is the scaffolding the real Mindset-Aligned Trend
 * Entry rules get ported into. It returns the indicator readings alongside the
 * signal so the caller can hand them to the Trading Lab checklist, which is
 * where the 0-100 confidence score and the size multiplier actually come from.
 *
 * Every candle passed in must already be closed; this function does no
 * filtering of its own.
 */
function evaluateMindsetV1(candles, overrides = {}) {
  const options = { ...MINDSET_V1_DEFAULTS, ...overrides };
  const needed = Math.max(options.slowLen, options.rsiLen + 1, options.atrLen + options.atrAvgLen, options.volLen);
  if (!Array.isArray(candles) || candles.length < needed) {
    return {
      signal: "FLAT",
      error: `Need at least ${needed} closed candles, have ${Array.isArray(candles) ? candles.length : 0}`,
      indicators: null,
      reasons: [],
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles.length - 1;

  const fast = ema(closes, options.fastLen)[last];
  const slow = ema(closes, options.slowLen)[last];
  const rsiValue = rsi(closes, options.rsiLen)[last];
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);
  const atrs = atrSeries(candles, options.atrLen);
  const atrValue = atrs[last];

  if ([fast, slow, rsiValue, atrValue].some((v) => v == null || !Number.isFinite(v))) {
    return { signal: "FLAT", error: "Indicators not warmed up yet", indicators: null, reasons: [] };
  }

  // Volatility and volume relative to their own recent averages — the units
  // the checklist's kill switches and scoring expect.
  const recentAtrs = atrs.slice(Math.max(0, last - options.atrAvgLen + 1), last + 1).filter((v) => v != null);
  const atrAvg = recentAtrs.length ? recentAtrs.reduce((s, v) => s + v, 0) / recentAtrs.length : atrValue;
  const volAvg = sma(volumes, options.volLen, last);

  const trend = fast > slow ? "UP" : fast < slow ? "DOWN" : "FLAT";
  const reasons = [
    `EMA${options.fastLen} ${fast.toFixed(2)} vs EMA${options.slowLen} ${slow.toFixed(2)} — trend ${trend}`,
    `RSI${options.rsiLen} ${rsiValue.toFixed(1)}`,
  ];

  let signal = "FLAT";
  if (trend === "UP") {
    if (rsiValue > options.rsiLongMin && rsiValue < options.rsiLongMax) signal = "LONG";
    else reasons.push(`RSI outside long band (${options.rsiLongMin}-${options.rsiLongMax}) — no entry`);
  } else if (trend === "DOWN") {
    if (rsiValue < options.rsiShortMax && rsiValue > options.rsiShortMin) signal = "SHORT";
    else reasons.push(`RSI outside short band (${options.rsiShortMin}-${options.rsiShortMax}) — no entry`);
  } else {
    reasons.push("EMAs equal — no trend");
  }

  return {
    signal,
    strategy: "mindset_v1",
    error: null,
    reasons,
    indicators: {
      ema20: fast,
      ema50: slow,
      rsi: rsiValue,
      atr: atrValue,
      atrRatio: atrAvg > 0 ? atrValue / atrAvg : 1,
      volumeRatio: volAvg > 0 ? volumes[last] / volAvg : 1,
      macdBullish: macdLine[last] != null && signalLine[last] != null ? macdLine[last] > signalLine[last] : null,
      trend,
    },
  };
}

module.exports = { evaluateMindsetV1, MINDSET_V1_DEFAULTS, atrSeries, sma };
