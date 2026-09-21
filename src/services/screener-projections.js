"use strict";

// Two views of one screener row.
//
// The Directional Bias and Local Extremes pages are projections, not engines:
// every number here was already computed by SignalScreenerService (direction)
// and local-extreme-engine.js (location), which stay the single sources of
// truth. This module only reshapes a scan row for one page or the other and
// translates the wire vocabulary at the presentation boundary.
//
// Direction and location are deliberately never folded together. A BULLISH
// bias and a CONFIRMED local top are both legitimate readings of the same
// candle set, and a reader must be able to see both at once.

const { assessFreshness } = require("./data-freshness");

// The screener speaks LONG / SHORT / FLAT on the wire — the signal bot's
// state transitions, the trade bridge and the Telegram alerts all depend on
// those values, so they are untouched. The dashboards read them as a bias.
const BIAS_LABELS = Object.freeze({ LONG: "BULLISH", SHORT: "BEARISH", FLAT: "NEUTRAL" });

function biasLabel(signal) {
  return BIAS_LABELS[signal] || "NEUTRAL";
}

function flag(value, whenTrue, whenFalse) {
  if (value == null) return null;
  return value ? whenTrue : whenFalse;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Both pages read the same screener row, so they share one clock: the candle
 * it closed on and the moment it was computed. Freshness rules themselves are
 * not re-invented here — data-freshness.js owns the tolerances.
 */
function rowFreshness({ row, interval, label, now }) {
  return assessFreshness({
    interval,
    sources: [{
      key: "screener",
      label,
      candleCloseTime: row ? row.candleCloseTime : null,
      computedAt: row ? row.computedAt : null,
      error: !row || Boolean(row.error),
    }],
  }, now);
}

/**
 * Directional bias: where trend and momentum are leaning, and how much of the
 * evidence agrees. The score is the screener's own confluence count, passed
 * through untouched — it measures agreement, not desirability, so a bearish
 * 83 is exactly as confident as a bullish 83.
 */
function toDirectionalBias(row, interval, now = Date.now()) {
  const freshness = rowFreshness({ row, interval, label: "Directional bias", now });
  if (!row || row.error) {
    return {
      symbol: row ? row.symbol : null,
      interval,
      price: null,
      bias: null,
      // The wire value rides along even on an error row so a caller that
      // switches on signal never has to special-case the failure shape.
      signal: null,
      score: null,
      trendRegime: null,
      rsi: null,
      adx: null,
      emaStructure: null,
      ema200: null,
      vwap: null,
      macd: null,
      volume: null,
      checks: { bullish: null, bearish: null },
      candleCloseTime: null,
      computedAt: null,
      freshness,
      error: (row && row.error) || "Directional bias unavailable",
    };
  }
  const indicators = row.indicators || {};
  return {
    symbol: row.symbol,
    interval,
    price: numberOrNull(row.price),
    bias: biasLabel(row.signal),
    // Kept for compatibility with anything already reading the screener's
    // vocabulary; the Directional Bias UI renders `bias` and never this.
    signal: row.signal || null,
    score: numberOrNull(row.score),
    trendRegime: row.trendRegime || null,
    rsi: numberOrNull(row.rsi),
    adx: numberOrNull(row.adx),
    emaStructure: flag(indicators.ema20AboveEma50, "BULLISH", "BEARISH"),
    ema200: flag(indicators.priceAboveEma200, "ABOVE", "BELOW"),
    vwap: flag(indicators.aboveVwap, "ABOVE", "BELOW"),
    macd: flag(indicators.macdBullish, "BULLISH", "BEARISH"),
    volume: flag(indicators.volumeAboveAverage, "CONFIRMED", "LIGHT"),
    checks: {
      bullish: numberOrNull(indicators.bullishChecks),
      bearish: numberOrNull(indicators.bearishChecks),
    },
    candleCloseTime: row.candleCloseTime ?? null,
    computedAt: row.computedAt ?? null,
    freshness,
  };
}

const EMPTY_METRICS = Object.freeze({ rsi: null, zScore: null, volumeRatio: null, sweptLevel: null });

function sideView(side) {
  if (!side) {
    return { score: null, state: "NONE", tier: null, confirmed: false, reasons: [], components: {}, metrics: { ...EMPTY_METRICS } };
  }
  return {
    score: numberOrNull(side.score),
    state: side.state || "NONE",
    tier: side.tier || null,
    confirmed: Boolean(side.confirmed),
    // The engine's own words for what it saw, in its own order of weight.
    reasons: Array.isArray(side.reasons) ? side.reasons.map((reason) => reason.label) : [],
    components: side.components ? { ...side.components } : {},
    metrics: side.metrics ? { ...side.metrics } : { ...EMPTY_METRICS },
  };
}

/**
 * Local extremes: whether price is stretched toward a local top or bottom.
 *
 * Both sides travel in full. The dominant side is reported, never substituted
 * for the other one — "Bottom 45 / Top 75" is the reading, and collapsing it
 * to "TOP 75" would throw away the half that says the other side is also
 * building. Nothing here is translated into BUY / SELL / LONG / SHORT: a
 * confirmed extreme is a location, not an entry.
 */
function toLocalExtremes(row, interval, now = Date.now()) {
  const freshness = rowFreshness({ row, interval, label: "Local extremes", now });
  const extreme = row && !row.error ? row.extreme : null;
  if (!row || row.error || !extreme || extreme.error) {
    return {
      symbol: row ? row.symbol : null,
      interval,
      price: null,
      dominant: null,
      state: null,
      bottomScore: null,
      topScore: null,
      setupType: null,
      trend: null,
      reasons: [],
      metrics: { ...EMPTY_METRICS },
      components: {},
      bottom: sideView(null),
      top: sideView(null),
      candleCloseTime: null,
      computedAt: null,
      freshness,
      error: (extreme && extreme.error) || (row && row.error) || "Local extremes unavailable",
    };
  }
  const dominantSide = extreme.dominant ? extreme[extreme.dominant] : null;
  const bottom = sideView(extreme.bottom);
  const top = sideView(extreme.top);
  const context = extreme.context || {};
  return {
    symbol: row.symbol,
    interval,
    price: numberOrNull(row.price),
    dominant: extreme.dominant || null,
    state: extreme.state || "NONE",
    // Independent on purpose — see the comment above.
    bottomScore: bottom.score,
    topScore: top.score,
    // The engine's own label ("reversal top", "trend-pullback bottom"), not a
    // re-derived one.
    setupType: context.setupType || null,
    trend: context.trend || null,
    priceAboveEma200: context.priceAboveEma200 ?? null,
    mainReason: extreme.mainReason || null,
    reasons: dominantSide ? sideView(dominantSide).reasons : [],
    metrics: dominantSide ? sideView(dominantSide).metrics : { ...EMPTY_METRICS },
    components: dominantSide ? sideView(dominantSide).components : {},
    bottom,
    top,
    candleCloseTime: row.candleCloseTime ?? null,
    computedAt: row.computedAt ?? null,
    freshness,
  };
}

module.exports = {
  BIAS_LABELS,
  biasLabel,
  toDirectionalBias,
  toLocalExtremes,
};
