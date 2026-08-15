"use strict";

// vwap_reversion_v1 — the counterweight.
//
// Every other candle strategy in this registry buys strength and sells
// weakness. That means they win and lose together, and a lab full of
// correlated strategies cannot tell you much: the comparison card ends up
// ranking three views of the same trade. This one is here to fail at different
// times, by fading stretched moves back to anchored VWAP.
//
// Mean reversion is the easiest thing in trading to fake a backtest of, so the
// rules are built around the three ways it usually cheats:
//
//   1. Regime gate. Fading a trend is how a reversion equity curve dies, so
//      ADX must be BELOW `maxAdx`. This strategy declines to have an opinion
//      in a trending market rather than taking the other side of one.
//   2. Stretch measured in ATR, not percent. A fixed percentage band is a
//      different trade at different volatilities; `entryAtr` multiples of ATR
//      away from VWAP means the same thing in every regime.
//   3. A stall, not a catch. Price must have stopped extending — this bar's
//      close is back toward VWAP relative to the previous close. Entering
//      while the stretch is still widening is catching a knife, and it is the
//      single biggest source of flattering reversion backtests.
//
// The target is VWAP itself: this is a reversion trade, so the thesis is
// complete when price has reverted. The stop sits beyond the bar's extreme,
// which means risk is often LARGER than reward — so the setup is refused
// outright unless reward/risk clears `minRewardR`. Without that check the
// strategy would happily take a long series of small wins funded by rare large
// losses, which backtests beautifully and is worth nothing.

const { vwapSeries, adxSeries } = require("../../signal-screener");
const { atr } = require("../../decision-engine");
const { checkPositiveInt, checkPositiveNumber } = require("./option-checks");

const VWAP_REVERSION_V1_DEFAULTS = {
  // "auto" picks the anchor from the candle spacing — see resolveAnchor().
  // "day" and "month" force it, which is what the tests use to pin behaviour.
  anchor: "auto",
  // Below this many bars per session, a daily anchor does not leave enough
  // bars to accumulate a meaningful VWAP and "auto" reaches for the monthly
  // one instead.
  minBarsPerSession: 12,
  adxLen: 14,
  atrLen: 14,
  // Above this ADX the market is trending and this strategy stands down.
  maxAdx: 22,
  // How far from VWAP, in ATR, before a move counts as stretched.
  entryAtr: 1.8,
  // Stop this far beyond the bar's extreme, in ATR.
  stopBufferAtr: 0.5,
  // Minimum reward/risk. Below this the geometry is not worth taking.
  minRewardR: 1,
  // VWAP needs a few bars of accumulation after each session reset before it
  // means anything — on the first bar of a session it IS the bar.
  minSessionBars: 5,
};

const REQUIRED_WARMUP_BARS = 60;

function flat(reasons, indicators = {}, error = null, price = null) {
  return {
    signal: "FLAT",
    strategy: "vwap_reversion_v1",
    price,
    error,
    reasons,
    indicators,
    confidence: null,
    stopHint: null,
    targetHint: null,
  };
}

// Mirrors signal-screener's vwapPeriodKey so "how far into the session are we"
// answers the same question the VWAP series was accumulated over. Kept in step
// by a test that asserts a reset lands where this says it does.
function periodKey(openTime, anchor) {
  if (anchor === "month") {
    const d = new Date(openTime);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  return Math.floor(openTime / 86400000);
}

// Pick the VWAP anchor from the candle spacing rather than making the caller
// know to do it.
//
// This is not a nicety. A daily anchor on 4h candles gives SIX bars per
// session, and after the minimum accumulation this strategy requires, almost
// no bar is ever eligible — the strategy sits in the registry looking testable
// while silently never trading. Measured on random walks: 0 signals over five
// 900-bar runs on a daily anchor, 189 on a monthly one. A parameter whose
// wrong value produces silence rather than an error is a parameter that should
// not be hand-set.
function resolveAnchor(bars, options) {
  if (options.anchor === "day" || options.anchor === "month") return options.anchor;

  // Median spacing, so one gap in the data does not decide this.
  const spacings = [];
  for (let i = 1; i < bars.length; i += 1) {
    const gap = bars[i].openTime - bars[i - 1].openTime;
    if (gap > 0) spacings.push(gap);
  }
  if (!spacings.length) return "day";
  spacings.sort((a, b) => a - b);
  const step = spacings[Math.floor(spacings.length / 2)];

  return 86400000 / step >= options.minBarsPerSession ? "day" : "month";
}

function barsSinceAnchor(bars, anchor) {
  const last = bars.length - 1;
  const key = periodKey(bars[last].openTime, anchor);
  let count = 1;
  for (let i = last - 1; i >= 0; i -= 1) {
    if (periodKey(bars[i].openTime, anchor) !== key) break;
    count += 1;
  }
  return count;
}

// Warmup under the options actually supplied. ADX needs roughly twice its
// period to settle, and the session-bar minimum is a floor of its own.
function warmupForOptions(options = {}) {
  const merged = { ...VWAP_REVERSION_V1_DEFAULTS, ...options };
  return Math.max(
    REQUIRED_WARMUP_BARS,
    (Number(merged.adxLen) || 0) * 3,
    (Number(merged.atrLen) || 0) + 1,
    Number(merged.minSessionBars) || 0,
  );
}

function validateOptions(options = {}) {
  if (options.anchor !== undefined && !["auto", "day", "month"].includes(options.anchor)) {
    return 'anchor must be "auto", "day" or "month"';
  }
  return (
    checkPositiveInt(options, "adxLen", { min: 2, max: 500 }) ||
    checkPositiveInt(options, "atrLen", { min: 2, max: 500 }) ||
    checkPositiveInt(options, "minSessionBars", { min: 1, max: 5000 }) ||
    checkPositiveInt(options, "minBarsPerSession", { min: 1, max: 5000 }) ||
    checkPositiveNumber(options, "maxAdx", { min: 0, max: 100 }) ||
    checkPositiveNumber(options, "entryAtr", { min: 0, max: 100 }) ||
    checkPositiveNumber(options, "stopBufferAtr", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "minRewardR", { min: 0, max: 100, exclusiveMin: false })
  );
}

const vwapReversionV1 = {
  id: "vwap_reversion_v1",
  name: "VWAP Reversion v1",
  version: "1.0.0",
  // Backtest only, like every strategy that has not yet met a live candle.
  status: "backtest",
  supportsBacktest: true,
  supportsLiveScanner: false,
  supportsLiveResearch: true,
  // A reversion strategy is counter-trend by definition, and the Trading Lab
  // checklist's regime gate is a trend-following house rule that refuses
  // counter-trend entries outright. Without this declaration every signal this
  // strategy produces is skipped before it can become evidence — it would sit
  // in the registry looking testable while being structurally unable to trade.
  // The waiver covers ONLY the directional regime check; kill switches,
  // position limits and the 0-100 score all still apply, and the missing
  // trend-alignment points are simply not earned.
  tradesCounterTrend: true,
  description:
    "Fades moves stretched more than N×ATR from anchored VWAP back to VWAP, only in a low-ADX range regime, and only once the stretch has stopped extending. Refuses setups whose reward/risk does not clear a floor. Backtest only.",
  requiredWarmupBars: REQUIRED_WARMUP_BARS,
  warmupFor: warmupForOptions,
  validateOptions,

  describeRules() {
    return {
      purpose: "Range-regime mean reversion",
      looksFor: `Price at least ${VWAP_REVERSION_V1_DEFAULTS.entryAtr} ATR from anchored VWAP, below ADX ${VWAP_REVERSION_V1_DEFAULTS.maxAdx}, after the stretch stalls`,
      longEntry: "Downside stretch below VWAP that has stopped extending",
      shortEntry: "Upside stretch above VWAP that has stopped extending",
      trendFilter: `Range only: ADX must remain below ${VWAP_REVERSION_V1_DEFAULTS.maxAdx}`,
      stop: `${VWAP_REVERSION_V1_DEFAULTS.stopBufferAtr} ATR beyond the signal bar extreme`,
      target: "Anchored VWAP",
      positionSizing: "Trading Lab checklist, edge gate and account-local risk limits; counter-trend declaration waives only the directional regime gate",
    };
  },

  evaluate(candles, index, context = {}) {
    const options = { ...VWAP_REVERSION_V1_DEFAULTS, ...(context.options || {}) };
    const needed = warmupForOptions(context.options || {});
    // The lookahead barrier. VWAP and ADX are both computed over this slice
    // only, so neither can see a bar the live scanner would not have had.
    const bars = candles.slice(0, index + 1);

    if (bars.length < needed) {
      return flat(
        [],
        {},
        `Need at least ${needed} closed candles, have ${bars.length}`,
        bars.length ? bars[bars.length - 1].close : null,
      );
    }

    const last = bars.length - 1;
    const bar = bars[last];
    const price = bar.close;

    const anchor = resolveAnchor(bars, options);
    const vwap = vwapSeries(bars, anchor)[last];
    const adx = adxSeries(bars, options.adxLen)[last];
    const atrValue = atr(bars, options.atrLen);

    if (![vwap, adx, atrValue].every((v) => v != null && Number.isFinite(v)) || !(atrValue > 0)) {
      return flat([], {}, "Indicators not warmed up yet", price);
    }

    const sessionBars = barsSinceAnchor(bars, anchor);
    const distance = price - vwap;
    const stretch = distance / atrValue;

    const indicators = {
      vwap,
      adx,
      atr: atrValue,
      stretchAtr: stretch,
      anchor,
      sessionBars,
      regime: adx < options.maxAdx ? "RANGE" : "TREND",
      stalled: null,
    };

    const reasons = [
      `VWAP ${vwap.toFixed(2)} vs close ${price.toFixed(2)} — stretched ${stretch.toFixed(2)}× ATR`,
    ];

    if (sessionBars < options.minSessionBars) {
      reasons.push(
        `Only ${sessionBars} bar(s) since the VWAP anchor reset (need ${options.minSessionBars}) — VWAP is not meaningful yet`,
      );
      return flat(reasons, indicators, null, price);
    }

    reasons.push(`ADX ${adx.toFixed(1)} — ${indicators.regime.toLowerCase()} regime`);
    if (adx >= options.maxAdx) {
      reasons.push(`Trending market (ADX ≥ ${options.maxAdx}) — reversion stands down rather than fading a trend`);
      return flat(reasons, indicators, null, price);
    }

    if (Math.abs(stretch) < options.entryAtr) {
      reasons.push(`Stretch under ${options.entryAtr}× ATR — price is near fair value, nothing to fade`);
      return flat(reasons, indicators, null, price);
    }

    // Stretched above VWAP is a short back to it, and vice versa.
    const direction = stretch > 0 ? "SHORT" : "LONG";

    // The stall check: the move must have stopped extending. For a short, this
    // bar closed below the previous one; for a long, above it.
    const previousClose = bars[last - 1].close;
    const stalled = direction === "SHORT" ? price < previousClose : price > previousClose;
    indicators.stalled = stalled;

    if (!stalled) {
      reasons.push(
        `Stretch is still extending (close ${price.toFixed(2)} vs previous ${previousClose.toFixed(2)}) — waiting rather than catching it`,
      );
      return flat(reasons, indicators, null, price);
    }
    reasons.push("Stretch has stopped extending — entry");

    // Stop beyond the extreme this bar reached, so being right about the level
    // but early about the bar does not stop the trade out.
    const buffer = options.stopBufferAtr * atrValue;
    const stopHint = direction === "SHORT" ? bar.high + buffer : bar.low - buffer;
    // Target is the reversion itself: VWAP, nothing beyond it.
    const targetHint = vwap;

    const risk = Math.abs(price - stopHint);
    const reward = Math.abs(targetHint - price);
    const rewardR = risk > 0 ? reward / risk : 0;
    indicators.rewardR = rewardR;

    if (!(rewardR >= options.minRewardR)) {
      reasons.push(
        `Reward/risk ${rewardR.toFixed(2)} is under the ${options.minRewardR} floor — right idea, wrong geometry`,
      );
      return flat(reasons, indicators, null, price);
    }
    reasons.push(`Reward/risk ${rewardR.toFixed(2)} clears the ${options.minRewardR} floor`);

    // Ranks this strategy's own setups against each other only — a quieter
    // market and a bigger stretch are what make a fade work. Not authoritative;
    // the Trading Lab checklist is what sizes the trade.
    let confidence = 50;
    if (adx < options.maxAdx * 0.7) confidence += 10;
    if (Math.abs(stretch) >= options.entryAtr * 1.5) confidence += 10;
    if (rewardR >= options.minRewardR * 1.5) confidence += 10;

    return {
      signal: direction,
      strategy: "vwap_reversion_v1",
      price,
      error: null,
      reasons,
      indicators,
      confidence,
      stopHint,
      targetHint,
    };
  },
};

module.exports = { vwapReversionV1, VWAP_REVERSION_V1_DEFAULTS, REQUIRED_WARMUP_BARS };
