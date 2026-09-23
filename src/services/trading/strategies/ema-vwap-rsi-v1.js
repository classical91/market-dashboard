"use strict";

// ema_vwap_rsi_v1 — the rules that used to run as the Terminal Suite's
// "Strategy Engine" panel, moved into the lab so they are measured with the
// same costs, execution model and statistics as everything else here.
//
// All four checks must agree on the decided bar:
//
//   1. Trend. Close on the right side of the `trendEmaLen` EMA.
//   2. Trigger. Close crosses the `entryEmaLen` EMA on this bar — previous
//      close at or through it, this close beyond it.
//   3. Momentum. RSI above 50 for longs, below 50 for shorts.
//   4. VWAP (optional, on by default). Close on the right side of anchored
//      VWAP. Sub-daily candles anchor to the UTC day, daily and slower candles
//      to the month, matching what the panel did.
//
// Stop is `atrMultSL` ATR from entry and the target is `rr` times that risk.
// Both are published as stopHint/targetHint, so run this under native
// execution to test the strategy as it was written.

const { ema, rsi, vwapSeries } = require("../../signal-screener");
const { atr } = require("../../decision-engine");
const { checkPositiveInt, checkPositiveNumber } = require("./option-checks");

const ID = "ema_vwap_rsi_v1";

const DEFAULTS = Object.freeze({
  trendEmaLen: 100,
  entryEmaLen: 21,
  rsiLen: 14,
  atrLen: 14,
  atrMultSL: 1.2,
  rr: 2,
  useVwap: true,
  allowLong: true,
  allowShort: true,
});

const OPTION_SCHEMA = Object.freeze([
  { key: "trendEmaLen", label: "Trend EMA", type: "int", min: 2, max: 300, step: 1 },
  { key: "entryEmaLen", label: "Entry EMA", type: "int", min: 2, max: 100, step: 1 },
  { key: "rsiLen", label: "RSI length", type: "int", min: 2, max: 100, step: 1 },
  { key: "atrLen", label: "ATR length", type: "int", min: 2, max: 100, step: 1 },
  { key: "atrMultSL", label: "ATR stop multiplier", type: "number", min: 0.2, max: 10, step: 0.1 },
  { key: "rr", label: "Reward/risk", type: "number", min: 0.5, max: 10, step: 0.1 },
  { key: "useVwap", label: "Require VWAP side", type: "boolean" },
  { key: "allowLong", label: "Allow longs", type: "boolean" },
  { key: "allowShort", label: "Allow shorts", type: "boolean" },
]);

function warmupFor(options = {}) {
  const merged = { ...DEFAULTS, ...options };
  return (
    Math.max(
      Number(merged.trendEmaLen) || 0,
      Number(merged.entryEmaLen) || 0,
      (Number(merged.rsiLen) || 0) + 1,
      (Number(merged.atrLen) || 0) + 1,
    ) + 1
  );
}

function validateOptions(options = {}) {
  const ints = [["trendEmaLen", 2, 300], ["entryEmaLen", 2, 100], ["rsiLen", 2, 100], ["atrLen", 2, 100]];
  for (const [key, min, max] of ints) {
    const problem = checkPositiveInt(options, key, { min, max });
    if (problem) return problem;
  }
  const numbers = [["atrMultSL", 0.2, 10], ["rr", 0.5, 10]];
  for (const [key, min, max] of numbers) {
    const problem = checkPositiveNumber(options, key, { min, max, exclusiveMin: false });
    if (problem) return problem;
  }
  for (const key of ["useVwap", "allowLong", "allowShort"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") return `${key} must be true or false`;
  }
  return null;
}

function flat(reasons, indicators = {}, error = null, price = null) {
  return { signal: "FLAT", strategy: ID, price, error, reasons, indicators, confidence: null, stopHint: null, targetHint: null };
}

// Daily or slower candles get a monthly VWAP; a daily anchor on them would
// reset every bar and VWAP would just be the bar's typical price.
function vwapAnchor(bars) {
  const spacings = [];
  for (let i = 1; i < bars.length; i += 1) {
    const gap = bars[i].openTime - bars[i - 1].openTime;
    if (gap > 0) spacings.push(gap);
  }
  if (!spacings.length) return "day";
  spacings.sort((a, b) => a - b);
  return spacings[Math.floor(spacings.length / 2)] >= 86400000 ? "month" : "day";
}

const emaVwapRsiV1 = {
  id: ID,
  name: "EMA/VWAP/RSI v1",
  version: "1.0.0",
  status: "backtest",
  supportsBacktest: true,
  supportsLiveScanner: false,
  supportsLiveResearch: false,
  optionSchema: OPTION_SCHEMA,
  defaultOptions: DEFAULTS,
  requiredWarmupBars: warmupFor(),
  warmupFor,
  validateOptions,
  shortDescription: "Trend EMA filter with an entry-EMA cross, RSI momentum and VWAP side, ATR stop and fixed R target.",
  description:
    "Takes a fresh close across the entry EMA only when price is on the same side of the trend EMA and anchored VWAP and RSI agrees with the direction. ATR stop, fixed reward multiple. Formerly the Terminal Suite Strategy Engine panel. Backtest only.",

  describeRules() {
    return {
      purpose: "Trend-following pullback continuation",
      looksFor: `Close crossing EMA${DEFAULTS.entryEmaLen} in the direction of EMA${DEFAULTS.trendEmaLen}, with RSI and VWAP agreeing`,
      longEntry: `Close above EMA${DEFAULTS.trendEmaLen} and VWAP, crosses up through EMA${DEFAULTS.entryEmaLen}, RSI above 50`,
      shortEntry: `Close below EMA${DEFAULTS.trendEmaLen} and VWAP, crosses down through EMA${DEFAULTS.entryEmaLen}, RSI below 50`,
      trendFilter: `EMA${DEFAULTS.trendEmaLen}`,
      stop: `${DEFAULTS.atrMultSL} ATR from entry`,
      target: `${DEFAULTS.rr}R from entry`,
      positionSizing: "Trading Lab checklist, edge gate and account-local risk limits",
    };
  },

  evaluate(candles, index, context = {}) {
    const options = { ...DEFAULTS, ...(context.options || {}) };
    const needed = warmupFor(context.options || {});
    // The lookahead barrier: every indicator is computed over this slice only.
    const bars = candles.slice(0, index + 1);

    if (bars.length < needed) {
      return flat([], {}, `Need at least ${needed} closed candles, have ${bars.length}`, bars.length ? bars[bars.length - 1].close : null);
    }

    const last = bars.length - 1;
    const closes = bars.map((bar) => bar.close);
    const price = closes[last];
    const prevClose = closes[last - 1];
    const trendSeries = ema(closes, options.trendEmaLen);
    const entrySeries = ema(closes, options.entryEmaLen);
    const trend = trendSeries[last];
    const entry = entrySeries[last];
    const prevEntry = entrySeries[last - 1];
    const rsiValue = rsi(closes, options.rsiLen)[last];
    const atrValue = atr(bars, options.atrLen);
    const anchor = vwapAnchor(bars);
    const vwap = options.useVwap ? vwapSeries(bars, anchor)[last] : null;

    if ([trend, entry, prevEntry, rsiValue, atrValue].some((v) => v == null || !Number.isFinite(v)) || !(atrValue > 0) || (options.useVwap && vwap == null)) {
      return flat([], {}, "Indicators not warmed up yet", price);
    }

    const crossedUp = prevClose <= prevEntry && price > entry;
    const crossedDown = prevClose >= prevEntry && price < entry;
    const longChecks = [price > trend, crossedUp, rsiValue > 50, !options.useVwap || price > vwap];
    const shortChecks = [price < trend, crossedDown, rsiValue < 50, !options.useVwap || price < vwap];
    const longScore = longChecks.filter(Boolean).length;
    const shortScore = shortChecks.filter(Boolean).length;

    const indicators = {
      trendEma: trend,
      entryEma: entry,
      rsi: rsiValue,
      atr: atrValue,
      vwap,
      vwapAnchor: options.useVwap ? anchor : null,
      longChecks: longScore,
      shortChecks: shortScore,
    };

    const reasons = [
      `Close ${price.toFixed(2)} vs EMA${options.trendEmaLen} ${trend.toFixed(2)} — trend ${price > trend ? "up" : "down"}`,
      crossedUp
        ? `Crossed up through EMA${options.entryEmaLen} ${entry.toFixed(2)}`
        : crossedDown
          ? `Crossed down through EMA${options.entryEmaLen} ${entry.toFixed(2)}`
          : `No cross of EMA${options.entryEmaLen} ${entry.toFixed(2)} this bar`,
      `RSI ${rsiValue.toFixed(1)}`,
    ];
    if (options.useVwap) reasons.push(`VWAP (${anchor}) ${vwap.toFixed(2)} — close ${price > vwap ? "above" : "below"}`);

    let direction = null;
    if (options.allowLong && longScore === 4) direction = "LONG";
    else if (options.allowShort && shortScore === 4) direction = "SHORT";

    if (!direction) {
      reasons.push(`${Math.max(longScore, shortScore)}/4 checks aligned — no entry`);
      return flat(reasons, indicators, null, price);
    }
    reasons.push(`All 4 checks aligned — ${direction.toLowerCase()} entry`);

    const risk = atrValue * options.atrMultSL;
    const stopHint = direction === "LONG" ? price - risk : price + risk;
    const targetHint = direction === "LONG" ? price + risk * options.rr : price - risk * options.rr;

    return {
      signal: direction,
      strategy: ID,
      price,
      error: null,
      reasons,
      indicators,
      confidence: null,
      stopHint,
      targetHint,
    };
  },
};

module.exports = { emaVwapRsiV1, EMA_VWAP_RSI_V1_DEFAULTS: DEFAULTS };
