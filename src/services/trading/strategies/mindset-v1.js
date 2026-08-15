"use strict";

// mindset_v1 as a Trading Lab strategy.
//
// This is an adapter, not a reimplementation: the signal logic is the exact
// `evaluateMindsetV1` the live scanner runs, imported from the shared rules
// module both depend on. If the two ever disagree, the backtest stops being
// evidence about the live scanner, which is the whole reason this file is
// thin — and since the scanner now resolves its evaluator through this
// registry entry, they cannot disagree at all.

const { evaluateMindsetV1, MINDSET_V1_DEFAULTS } = require("./mindset-v1-rules");

// The slowest input is the 50-period EMA; the ATR ratio needs 14 + 20 bars of
// history on top of that before it means anything.
const REQUIRED_WARMUP_BARS = Math.max(
  MINDSET_V1_DEFAULTS.slowLen,
  MINDSET_V1_DEFAULTS.atrLen + MINDSET_V1_DEFAULTS.atrAvgLen,
  MINDSET_V1_DEFAULTS.volLen,
);

const mindsetV1 = {
  id: "mindset_v1",
  name: "Mindset v1",
  // Bump this whenever the rules change. Experiments record it, so an old
  // result stays attributable to the rules that actually produced it.
  version: "1.0.0",
  description:
    "EMA20/EMA50 trend direction with an RSI band filter that refuses to chase a stretched move. The strategy the live scanner runs.",
  // Running against live market data with paper execution — exactly what the
  // live scanner does today. That makes it scanner eligible; it says nothing
  // about real money, and realMoneyEligible stays false.
  status: "forward-paper",
  supportsBacktest: true,
  supportsLiveScanner: true,
  supportsLiveResearch: true,
  requiredWarmupBars: REQUIRED_WARMUP_BARS,

  describeRules() {
    return {
      purpose: "Trend-following momentum with a stretch filter",
      looksFor: `EMA${MINDSET_V1_DEFAULTS.fastLen}/EMA${MINDSET_V1_DEFAULTS.slowLen} trend agreement with RSI inside the permitted entry band`,
      longEntry: "Fast EMA above slow EMA while RSI is not overextended",
      shortEntry: "Fast EMA below slow EMA while RSI is not overextended",
      trendFilter: `EMA${MINDSET_V1_DEFAULTS.fastLen} versus EMA${MINDSET_V1_DEFAULTS.slowLen}`,
      stop: "Shared Trading Lab ATR stop (this strategy publishes no structural stop)",
      target: "Shared Trading Lab R-multiple targets",
      positionSizing: "Trading Lab checklist, edge gate and account-local risk limits",
    };
  },

  evaluate(candles, index, context = {}) {
    // The lookahead barrier: the strategy sees the decided bar and everything
    // before it, never a bar the live scanner would not have had.
    const bars = candles.slice(0, index + 1);
    const result = evaluateMindsetV1(bars, context.options || {});
    const price = bars.length ? bars[bars.length - 1].close : null;

    return {
      signal: result.signal,
      strategy: "mindset_v1",
      price,
      error: result.error || null,
      reasons: result.reasons || [],
      indicators: result.indicators || {},
      // mindset_v1 deliberately produces no score of its own — the 0-100
      // confidence comes from the Trading Lab checklist downstream. Saying
      // null is more honest than inventing a number here.
      confidence: null,
      stopHint: null,
      targetHint: null,
    };
  },
};

module.exports = { mindsetV1, REQUIRED_WARMUP_BARS };
