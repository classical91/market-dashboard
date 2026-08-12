"use strict";

// donchian_breakout_v1 — the deliberately dumb baseline.
//
// Every other strategy in this registry is trying to be clever. This one is
// not, and that is its job: it exists so that "is mindset_v1 any good?" has a
// denominator. A strategy that cannot beat an N-bar high with an ATR stop is
// not earning the complexity it costs, and until this file existed there was
// nothing in the lab that could make that statement.
//
// The rules are the whole strategy:
//
//   1. Channel. The highest high and lowest low of the `channelLength` bars
//      BEFORE the bar being decided. The decided bar is excluded on purpose —
//      including it makes the level partly a function of the break itself, and
//      every bar then trivially breaks its own channel.
//   2. Break. The decided bar CLOSES beyond that level. A wick through is not
//      a break; it is the level being tested and holding.
//   3. Freshness. The previous bar must NOT have already closed beyond the
//      same level. Without this the strategy re-signals on every bar of a
//      trend, which says nothing new and makes the refusal log useless for
//      telling "no setup" apart from "same setup, still true".
//   4. Trend filter (optional, on by default). Longs only above the
//      `trendLength` SMA, shorts only below. This is the one concession to
//      cleverness, and it can be switched off with `useTrendFilter: false` to
//      measure exactly what it is worth.
//
// There is deliberately no volume filter, no momentum confirmation and no
// regime gate. Each one would be another parameter to fit, and the value of a
// baseline is inversely proportional to how much it has been tuned.

const { atr } = require("../../decision-engine");

const DONCHIAN_BREAKOUT_V1_DEFAULTS = {
  channelLength: 20,
  atrLen: 14,
  // Stop distance below/above entry, in ATR. 2.0 is wide enough that ordinary
  // noise does not take the trade out before the breakout has a chance.
  stopAtr: 2,
  // Reward multiple of the stop distance. Trend systems live on their right
  // tail, so this is deliberately generous rather than a scalp.
  rewardR: 3,
  trendLength: 100,
  useTrendFilter: true,
};

// The channel needs `channelLength` bars before the decided one, the trend SMA
// needs `trendLength`, and ATR needs its own history. The trend filter is the
// binding constraint at default settings.
const REQUIRED_WARMUP_BARS =
  Math.max(
    DONCHIAN_BREAKOUT_V1_DEFAULTS.trendLength,
    DONCHIAN_BREAKOUT_V1_DEFAULTS.channelLength,
    DONCHIAN_BREAKOUT_V1_DEFAULTS.atrLen,
  ) + 2;

function flat(reasons, indicators = {}, error = null, price = null) {
  return {
    signal: "FLAT",
    strategy: "donchian_breakout_v1",
    price,
    error,
    reasons,
    indicators,
    confidence: null,
    stopHint: null,
    targetHint: null,
  };
}

// Highest high / lowest low over bars [from, to] inclusive.
function channelOver(bars, from, to) {
  let high = -Infinity;
  let low = Infinity;
  for (let i = from; i <= to; i += 1) {
    if (bars[i].high > high) high = bars[i].high;
    if (bars[i].low < low) low = bars[i].low;
  }
  return { high, low };
}

function sma(bars, length, endIndex) {
  if (endIndex < length - 1) return null;
  let sum = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i += 1) sum += bars[i].close;
  return sum / length;
}

const donchianBreakoutV1 = {
  id: "donchian_breakout_v1",
  name: "Donchian Breakout v1",
  version: "1.0.0",
  // Backtest only. It has never run forward on a live candle, and `backtest`
  // is not a scanner-eligible status, so the registry will refuse to start it
  // in the live scanner even if it is configured there.
  status: "backtest",
  supportsBacktest: true,
  supportsLiveScanner: false,
  description:
    "An N-bar Donchian channel break with an ATR stop and a fixed reward multiple, optionally filtered by a long SMA. Intentionally unoptimised: the baseline every other strategy should have to beat. Backtest only.",
  requiredWarmupBars: REQUIRED_WARMUP_BARS,

  evaluate(candles, index, context = {}) {
    const options = { ...DONCHIAN_BREAKOUT_V1_DEFAULTS, ...(context.options || {}) };
    // The lookahead barrier: nothing past the decided bar is visible.
    const bars = candles.slice(0, index + 1);

    if (bars.length < REQUIRED_WARMUP_BARS) {
      return flat(
        [],
        {},
        `Need at least ${REQUIRED_WARMUP_BARS} closed candles, have ${bars.length}`,
        bars.length ? bars[bars.length - 1].close : null,
      );
    }

    const last = bars.length - 1;
    const bar = bars[last];
    const price = bar.close;
    const atrValue = atr(bars, options.atrLen);

    if (!(atrValue > 0) || !Number.isFinite(atrValue)) {
      return flat([], {}, "ATR not warmed up yet", price);
    }

    // Channel from the bars before this one. `prior` is the same window shifted
    // back a bar, which is what makes the freshness check meaningful.
    const channel = channelOver(bars, last - options.channelLength, last - 1);
    const prior = channelOver(bars, last - options.channelLength - 1, last - 2);
    const trendSma = options.useTrendFilter ? sma(bars, options.trendLength, last) : null;

    const indicators = {
      channelHigh: channel.high,
      channelLow: channel.low,
      channelLength: options.channelLength,
      atr: atrValue,
      trendSma,
      trendFilter: options.useTrendFilter,
      brokeOut: null,
      fresh: null,
    };

    const reasons = [
      `Channel over the prior ${options.channelLength} bars: ${channel.low.toFixed(2)}–${channel.high.toFixed(2)}`,
    ];

    const brokeUp = price > channel.high;
    const brokeDown = price < channel.low;

    if (!brokeUp && !brokeDown) {
      indicators.brokeOut = false;
      reasons.push(`Close ${price.toFixed(2)} is inside the channel — no break`);
      return flat(reasons, indicators, null, price);
    }

    const direction = brokeUp ? "LONG" : "SHORT";
    indicators.brokeOut = true;
    reasons.push(
      brokeUp
        ? `Close ${price.toFixed(2)} above channel high ${channel.high.toFixed(2)}`
        : `Close ${price.toFixed(2)} below channel low ${channel.low.toFixed(2)}`,
    );

    // Was the previous bar already beyond its own channel in this direction?
    // If so this is a trend continuing, not a break happening.
    const previousClose = bars[last - 1].close;
    const fresh = brokeUp ? !(previousClose > prior.high) : !(previousClose < prior.low);
    indicators.fresh = fresh;

    if (!fresh) {
      reasons.push("Previous bar had already broken out — continuation, not a fresh break");
      return flat(reasons, indicators, null, price);
    }
    reasons.push("First close beyond the channel — fresh break");

    if (options.useTrendFilter) {
      if (trendSma == null) {
        return flat(reasons, indicators, "Trend SMA not warmed up yet", price);
      }
      const trendAgrees = direction === "LONG" ? price > trendSma : price < trendSma;
      reasons.push(
        `Price ${price.toFixed(2)} vs SMA${options.trendLength} ${trendSma.toFixed(2)} — trend ${trendAgrees ? "agrees" : "disagrees"}`,
      );
      if (!trendAgrees) {
        reasons.push("Counter-trend break refused by the trend filter");
        return flat(reasons, indicators, null, price);
      }
    }

    const risk = options.stopAtr * atrValue;
    const stopHint = direction === "LONG" ? price - risk : price + risk;
    const targetHint =
      direction === "LONG" ? price + options.rewardR * risk : price - options.rewardR * risk;

    return {
      signal: direction,
      strategy: "donchian_breakout_v1",
      price,
      error: null,
      reasons,
      indicators,
      // No self-score. A baseline that ranked its own setups would be tuning
      // itself, which is the one thing this strategy must not do.
      confidence: null,
      stopHint,
      targetHint,
    };
  },
};

module.exports = { donchianBreakoutV1, DONCHIAN_BREAKOUT_V1_DEFAULTS, REQUIRED_WARMUP_BARS };
