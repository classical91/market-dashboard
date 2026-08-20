"use strict";

// mindset_v1_1 — isolated entry-quality experiments for Mindset v1.
//
// The original mindset_v1 evaluator is deliberately not changed. This
// strategy reuses its indicator definitions and shared Trading Lab execution,
// then changes exactly one entry condition at a time. `variant=baseline` is a
// control: it must remain signal-identical to v1 and is pinned by tests.

const { evaluateMindsetV1, MINDSET_V1_DEFAULTS } = require("./mindset-v1-rules");
const { checkPositiveInt, checkPositiveNumber } = require("./option-checks");

const VARIANTS = Object.freeze([
  "baseline",
  "rsi_trigger",
  "trend_strength",
  "pullback",
  "macd_confirmation",
  "volume_confirmation",
]);

const MINDSET_V1_1_DEFAULTS = Object.freeze({
  ...MINDSET_V1_DEFAULTS,
  variant: "baseline",
  rsiTrigger: 50,
  trendStrengthMin: 0.25,
  pullbackAtrTolerance: 0.25,
  volumeRatioMin: 1,
});

function warmupForOptions(options = {}) {
  const merged = { ...MINDSET_V1_1_DEFAULTS, ...options };
  return Math.max(
    Number(merged.slowLen) || 0,
    (Number(merged.rsiLen) || 0) + 2,
    (Number(merged.atrLen) || 0) + (Number(merged.atrAvgLen) || 0),
    Number(merged.volLen) || 0,
    35, // MACD 26/9 signal seed
  );
}

const REQUIRED_WARMUP_BARS = warmupForOptions();

function validateOptions(options = {}) {
  if (options.variant !== undefined && !VARIANTS.includes(options.variant)) {
    return `variant must be one of ${VARIANTS.join(", ")}`;
  }
  const problem =
    checkPositiveInt(options, "fastLen", { min: 2, max: 500 }) ||
    checkPositiveInt(options, "slowLen", { min: 3, max: 1000 }) ||
    checkPositiveInt(options, "rsiLen", { min: 2, max: 500 }) ||
    checkPositiveInt(options, "atrLen", { min: 2, max: 500 }) ||
    checkPositiveInt(options, "atrAvgLen", { min: 1, max: 1000 }) ||
    checkPositiveInt(options, "volLen", { min: 1, max: 1000 }) ||
    checkPositiveNumber(options, "rsiLongMin", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "rsiLongMax", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "rsiShortMin", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "rsiShortMax", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "rsiTrigger", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "trendStrengthMin", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "pullbackAtrTolerance", { min: 0, max: 100, exclusiveMin: false }) ||
    checkPositiveNumber(options, "volumeRatioMin", { min: 0, max: 100, exclusiveMin: false });
  if (problem) return problem;

  const merged = { ...MINDSET_V1_1_DEFAULTS, ...options };
  if (merged.fastLen >= merged.slowLen) return "fastLen must be less than slowLen";
  if (merged.rsiLongMin >= merged.rsiLongMax) return "rsiLongMin must be less than rsiLongMax";
  if (merged.rsiShortMin >= merged.rsiShortMax) return "rsiShortMin must be less than rsiShortMax";
  return null;
}

function flatFrom(base, variant, reasons) {
  return {
    ...base,
    signal: "FLAT",
    strategy: "mindset_v1_1",
    reasons,
    indicators: { ...(base.indicators || {}), experimentVariant: variant },
  };
}

function evaluateMindsetV11(candles, overrides = {}) {
  const options = { ...MINDSET_V1_1_DEFAULTS, ...overrides };
  const variant = options.variant;
  const base = evaluateMindsetV1(candles, options);
  if (base.error || !base.indicators) {
    return { ...base, strategy: "mindset_v1_1" };
  }

  const indicators = { ...base.indicators, experimentVariant: variant };
  const reasons = [...base.reasons, `Mindset v1.1 ablation: ${variant}`];
  if (variant === "baseline") {
    return { ...base, strategy: "mindset_v1_1", reasons, indicators };
  }

  const last = candles.length - 1;
  const bar = candles[last];
  const trend = indicators.trend;
  const longBand = indicators.rsi > options.rsiLongMin && indicators.rsi < options.rsiLongMax;
  const shortBand = indicators.rsi < options.rsiShortMax && indicators.rsi > options.rsiShortMin;
  let signal = "FLAT";

  if (variant === "rsi_trigger") {
    const prior = evaluateMindsetV1(candles.slice(0, -1), options);
    const previousRsi = prior.indicators && prior.indicators.rsi;
    indicators.previousRsi = previousRsi ?? null;
    indicators.rsiTrigger = options.rsiTrigger;
    if (previousRsi != null && trend === "UP" && longBand && previousRsi <= options.rsiTrigger && indicators.rsi > options.rsiTrigger) {
      signal = "LONG";
    } else if (previousRsi != null && trend === "DOWN" && shortBand && previousRsi >= options.rsiTrigger && indicators.rsi < options.rsiTrigger) {
      signal = "SHORT";
    } else {
      reasons.push(`No fresh RSI cross through ${options.rsiTrigger}`);
    }
  } else if (variant === "trend_strength") {
    const strength = indicators.atr > 0 ? Math.abs(indicators.ema20 - indicators.ema50) / indicators.atr : 0;
    indicators.trendStrengthAtr = strength;
    indicators.trendStrengthMin = options.trendStrengthMin;
    if (strength >= options.trendStrengthMin) signal = base.signal;
    else reasons.push(`EMA spread ${strength.toFixed(3)} ATR below ${options.trendStrengthMin}`);
  } else if (variant === "pullback") {
    const tolerance = options.pullbackAtrTolerance * indicators.atr;
    const restoredLong = trend === "UP" && longBand && bar.low <= indicators.ema20 + tolerance && bar.close > indicators.ema20 && bar.close > bar.open;
    const restoredShort = trend === "DOWN" && shortBand && bar.high >= indicators.ema20 - tolerance && bar.close < indicators.ema20 && bar.close < bar.open;
    indicators.pullbackAtrTolerance = options.pullbackAtrTolerance;
    indicators.pullbackRestored = restoredLong || restoredShort;
    if (restoredLong) signal = "LONG";
    else if (restoredShort) signal = "SHORT";
    else reasons.push("No deterministic EMA20 pullback-and-restore candle");
  } else if (variant === "macd_confirmation") {
    const agrees = base.signal === "LONG" ? indicators.macdBullish === true : base.signal === "SHORT" ? indicators.macdBullish === false : false;
    indicators.macdAgrees = agrees;
    if (agrees) signal = base.signal;
    else reasons.push("MACD direction does not confirm the baseline signal");
  } else if (variant === "volume_confirmation") {
    indicators.volumeRatioMin = options.volumeRatioMin;
    if (indicators.volumeRatio >= options.volumeRatioMin) signal = base.signal;
    else reasons.push(`Volume ratio ${indicators.volumeRatio.toFixed(3)} below ${options.volumeRatioMin}`);
  }

  return signal === "FLAT"
    ? flatFrom({ ...base, indicators }, variant, reasons)
    : { ...base, signal, strategy: "mindset_v1_1", reasons, indicators };
}

const mindsetV11 = {
  id: "mindset_v1_1",
  name: "Mindset v1.1 (Experimental)",
  version: "1.1.0-experimental.1",
  description:
    "Backtest-only Mindset entry-quality ablations. Runs one of baseline, fresh RSI trigger, normalized trend strength, EMA pullback, MACD confirmation, or volume confirmation under shared Trading Lab execution.",
  status: "experimental",
  supportsBacktest: true,
  supportsLiveScanner: false,
  supportsLiveResearch: true,
  requiredWarmupBars: REQUIRED_WARMUP_BARS,
  warmupFor: warmupForOptions,
  validateOptions,

  describeRules() {
    return {
      purpose: "Controlled Mindset v1 entry-quality ablations",
      looksFor: "Exactly one configured entry variation relative to the frozen Mindset v1 benchmark",
      longEntry: "Variant-specific, always constrained by EMA20 > EMA50 and symmetric RSI limits where applicable",
      shortEntry: "Variant-specific, always constrained by EMA20 < EMA50 and symmetric RSI limits where applicable",
      trendFilter: "EMA20/EMA50; trend-strength variant additionally normalizes the spread by ATR",
      stop: "Shared Trading Lab ATR stop; v1.1 publishes no native stop",
      target: "Shared Trading Lab R-multiple targets",
      positionSizing: "Trading Lab checklist, edge gate and isolated account-local risk limits",
    };
  },

  evaluate(candles, index, context = {}) {
    const bars = candles.slice(0, index + 1);
    const result = evaluateMindsetV11(bars, context.options || {});
    return {
      signal: result.signal,
      strategy: "mindset_v1_1",
      price: bars.length ? bars[bars.length - 1].close : null,
      error: result.error || null,
      reasons: result.reasons || [],
      indicators: result.indicators || {},
      confidence: null,
      stopHint: null,
      targetHint: null,
    };
  },
};

module.exports = {
  mindsetV11,
  evaluateMindsetV11,
  MINDSET_V1_1_DEFAULTS,
  MINDSET_V1_1_VARIANTS: VARIANTS,
  REQUIRED_WARMUP_BARS,
};
