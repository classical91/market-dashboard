"use strict";

// Faithful candle-engine conversion of the supplied Pine v4 strategy. The
// original title says 15m, but the rules are timeframe-agnostic; this research
// registration is intentionally scoped to BTC 4h and 1W by its UI metadata.

const { ema, rsi, adxSeries } = require("../../signal-screener");
const { atr } = require("../../decision-engine");
const { checkPositiveInt, checkPositiveNumber } = require("./option-checks");

const ID = "bb_mean_reversion_v4";
const DEFAULTS = Object.freeze({
  trendLen: 96,
  slopeLen: 5,
  bbLen: 20,
  bbMult: 2,
  volLen: 20,
  volMult: 1.5,
  atrLen: 14,
  atrStopMult: 1,
  maxBarsInTrade: 16,
  allowShorts: true,
  useSession: false,
  sessionHours: "0800-2000",
  adxLen: 14,
  adxThreshold: 25,
  cooldownBars: 10,
  // The Pine default was 60 minutes for a 15m chart. "auto" preserves the
  // intended higher-timeframe relationship for the requested 4h and 1W runs:
  // 4h -> 1D and 1W -> 1M. The resolved value is reported in every signal.
  htfTimeframe: "auto",
  htfEmaLen: 50,
  useExhaustion: true,
  rsiLen: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  wickRatioMin: 0.3,
});

const OPTION_SCHEMA = Object.freeze([
  { key: "trendLen", label: "Local trend EMA", type: "int", min: 20, max: 300, step: 1 },
  { key: "slopeLen", label: "EMA slope lookback", type: "int", min: 2, max: 20, step: 1 },
  { key: "bbLen", label: "Bollinger length", type: "int", min: 10, max: 50, step: 1 },
  { key: "bbMult", label: "Bollinger deviation", type: "number", min: 1, max: 3, step: 0.1 },
  { key: "volLen", label: "Volume MA", type: "int", min: 5, max: 50, step: 1 },
  { key: "volMult", label: "Volume spike multiplier", type: "number", min: 1, max: 3, step: 0.1 },
  { key: "atrLen", label: "ATR length", type: "int", min: 5, max: 30, step: 1 },
  { key: "atrStopMult", label: "ATR stop multiplier", type: "number", min: 0.3, max: 3, step: 0.1 },
  { key: "maxBarsInTrade", label: "Maximum bars in trade", type: "int", min: 4, max: 96, step: 1 },
  { key: "allowShorts", label: "Allow shorts", type: "boolean" },
  { key: "useSession", label: "Restrict to UTC session", type: "boolean" },
  { key: "sessionHours", label: "UTC session", type: "text", pattern: "^[0-2][0-9][0-5][0-9]-[0-2][0-9][0-5][0-9]$" },
  { key: "adxLen", label: "ADX length", type: "int", min: 5, max: 30, step: 1 },
  { key: "adxThreshold", label: "Maximum ADX", type: "number", min: 10, max: 40, step: 0.5 },
  { key: "cooldownBars", label: "Stop cooldown bars", type: "int", min: 0, max: 50, step: 1 },
  { key: "htfTimeframe", label: "Higher timeframe", type: "select", values: ["auto", "1D", "1W", "1M"] },
  { key: "htfEmaLen", label: "HTF EMA length", type: "int", min: 10, max: 200, step: 1 },
  { key: "useExhaustion", label: "Use exhaustion filter", type: "boolean" },
  { key: "rsiLen", label: "RSI length", type: "int", min: 5, max: 30, step: 1 },
  { key: "rsiOversold", label: "RSI oversold", type: "number", min: 10, max: 40, step: 0.5 },
  { key: "rsiOverbought", label: "RSI overbought", type: "number", min: 60, max: 90, step: 0.5 },
  { key: "wickRatioMin", label: "Minimum rejection wick", type: "number", min: 0.1, max: 0.7, step: 0.05 },
]);

function flat(reasons, indicators = {}, error = null, price = null) {
  return { signal: "FLAT", strategy: ID, price, error, reasons, indicators, confidence: null, stopHint: null, targetHint: null };
}

function sma(values, length) {
  if (values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i += 1) sum += values[i];
  return sum / length;
}

function stddev(values, length, mean) {
  if (values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i += 1) sum += (values[i] - mean) ** 2;
  return Math.sqrt(sum / length);
}

function resolveHtf(interval, requested) {
  if (requested && requested !== "auto") return requested;
  return interval === "1W" ? "1M" : "1D";
}

function periodKey(openTime, timeframe) {
  const d = new Date(openTime);
  if (timeframe === "1M") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  if (timeframe === "1W") {
    const shifted = openTime + 3 * 86400000; // Unix epoch Thursday -> Monday boundary.
    return `w-${Math.floor(shifted / (7 * 86400000))}`;
  }
  return `d-${Math.floor(openTime / 86400000)}`;
}

function aggregateClosedHtf(bars, timeframe) {
  const groups = [];
  for (const bar of bars) {
    // Assign a source candle by its closing instant. This matters for weekly
    // candles crossing a month boundary: using the open would incorrectly
    // make a February close become January's monthly close.
    const pointTime = Math.max(bar.openTime, Number(bar.closeTime) - 1);
    const key = periodKey(pointTime, timeframe);
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      const d = new Date(pointTime);
      let end;
      if (timeframe === "1M") end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      else if (timeframe === "1W") {
        const week = Math.floor((pointTime + 3 * 86400000) / (7 * 86400000));
        end = (week + 1) * 7 * 86400000 - 3 * 86400000;
      } else end = (Math.floor(pointTime / 86400000) + 1) * 86400000;
      groups.push({ key, close: bar.close, closeTime: bar.closeTime, end });
    } else {
      last.close = bar.close;
      last.closeTime = bar.closeTime;
    }
  }
  // Include the current group only on its exact closing candle; otherwise it
  // remains hidden. This is request.security(..., lookahead_off) semantics.
  const last = groups[groups.length - 1];
  const completed = last && last.closeTime >= last.end - 1;
  return groups.slice(0, completed ? groups.length : -1).map((g) => g.close);
}

function sessionAllows(bar, text) {
  const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(text));
  if (!match) return false;
  const minute = new Date(bar.openTime).getUTCHours() * 60 + new Date(bar.openTime).getUTCMinutes();
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

function indicatorsAt(candles, index, options, interval) {
  const bars = candles.slice(0, index + 1);
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const trend = ema(closes, options.trendLen);
  const trendEma = trend[index];
  const slopeBase = trend[index - options.slopeLen];
  const bbMid = sma(closes, options.bbLen);
  const deviation = bbMid == null ? null : stddev(closes, options.bbLen, bbMid);
  const volumeMa = sma(volumes, options.volLen);
  const atrValue = atr(bars, options.atrLen);
  const adx = adxSeries(bars, options.adxLen)[index];
  const rsiValue = rsi(closes, options.rsiLen)[index];
  const htf = resolveHtf(interval, options.htfTimeframe);
  const htfCloses = aggregateClosedHtf(bars, htf);
  const htfValues = ema(htfCloses, options.htfEmaLen);
  const htfEma = htfValues.length ? htfValues[htfValues.length - 1] : null;
  const htfClose = htfCloses.length ? htfCloses[htfCloses.length - 1] : null;
  return {
    trendEma, slopeBase, bbMid,
    bbUpper: deviation == null ? null : bbMid + options.bbMult * deviation,
    bbLower: deviation == null ? null : bbMid - options.bbMult * deviation,
    volumeMa, atr: atrValue, adx, rsi: rsiValue, htf, htfClose, htfEma,
  };
}

function warmupFor(options = {}) {
  const o = { ...DEFAULTS, ...options };
  return Math.max(100, o.trendLen + o.slopeLen, o.bbLen, o.volLen, o.atrLen * 3, o.adxLen * 3, o.rsiLen + 1);
}

function validateOptions(options = {}) {
  const ints = [
    ["trendLen", 20, 300], ["slopeLen", 2, 20], ["bbLen", 10, 50], ["volLen", 5, 50],
    ["atrLen", 5, 30], ["maxBarsInTrade", 4, 96], ["adxLen", 5, 30], ["cooldownBars", 0, 50],
    ["htfEmaLen", 10, 200], ["rsiLen", 5, 30],
  ];
  for (const [key, min, max] of ints) {
    const problem = checkPositiveInt(options, key, { min, max });
    if (problem) return problem;
  }
  const numbers = [
    ["bbMult", 1, 3], ["volMult", 1, 3], ["atrStopMult", 0.3, 3], ["adxThreshold", 10, 40],
    ["rsiOversold", 10, 40], ["rsiOverbought", 60, 90], ["wickRatioMin", 0.1, 0.7],
  ];
  for (const [key, min, max] of numbers) {
    const problem = checkPositiveNumber(options, key, { min, max, exclusiveMin: false });
    if (problem) return problem;
  }
  for (const key of ["allowShorts", "useSession", "useExhaustion"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") return `${key} must be true or false`;
  }
  if (options.sessionHours !== undefined && !/^\d{4}-\d{4}$/.test(String(options.sessionHours))) {
    return "sessionHours must use HHMM-HHMM";
  }
  if (options.htfTimeframe !== undefined && !["auto", "1D", "1W", "1M"].includes(options.htfTimeframe)) {
    return 'htfTimeframe must be "auto", "1D", "1W" or "1M"';
  }
  return null;
}

const bbMeanReversionV4 = {
  id: ID,
  name: "BB Mean-Reversion + Trend + Volume v4",
  version: "4.0.0",
  status: "backtest",
  supportsBacktest: true,
  supportsLiveScanner: false,
  supportsLiveResearch: false,
  tradesCounterTrend: true,
  singlePositionPerSymbol: true,
  supportedIntervals: ["4h", "1W"],
  optionSchema: OPTION_SCHEMA,
  defaultOptions: DEFAULTS,
  requiredWarmupBars: warmupFor(),
  warmupFor,
  validateOptions,
  shortDescription: "Bollinger pullback entries filtered by trend, volume, ADX, RSI exhaustion and rejection wicks.",
  description: "The supplied Pine v4 Bollinger mean-reversion strategy converted for BTC 4h and 1W candle replay, including HTF trend agreement, ATR stops, moving mid-band targets, time stops and post-stop cooldowns. Backtest only.",
  describeRules() {
    return {
      purpose: "Trend-aligned Bollinger mean reversion after exhaustion",
      looksFor: "Band contact, volume spike, low ADX, local and higher-timeframe trend agreement, and optional RSI/wick exhaustion",
      stop: `${DEFAULTS.atrStopMult} ATR from average entry, recalculated each bar`,
      target: "Current Bollinger mid-band",
      timeStop: `${DEFAULTS.maxBarsInTrade} bars`,
      costs: "Selected Backtest Lab fee and slippage scenario",
    };
  },

  evaluate(candles, index, context = {}) {
    const options = { ...DEFAULTS, ...(context.options || {}) };
    const bars = candles.slice(0, index + 1);
    const bar = bars[bars.length - 1];
    const price = bar ? bar.close : null;
    if (!bar || bars.length < warmupFor(options)) return flat([], {}, `Need at least ${warmupFor(options)} closed candles`, price);

    const v = indicatorsAt(candles, index, options, context.interval || "4h");
    if ([v.trendEma, v.slopeBase, v.bbMid, v.volumeMa, v.atr, v.adx, v.rsi, v.htfClose, v.htfEma].some((x) => !Number.isFinite(x))) {
      return flat([], v, "Indicators or higher-timeframe EMA are not warmed up", price);
    }

    const range = bar.high - bar.low;
    const lowerWickRatio = range > 0 ? (bar.close - bar.low) / range : 0;
    const upperWickRatio = range > 0 ? (bar.high - bar.close) / range : 0;
    const localUp = price > v.trendEma && v.trendEma > v.slopeBase;
    const localDown = price < v.trendEma && v.trendEma < v.slopeBase;
    const htfUp = v.htfClose > v.htfEma;
    const htfDown = v.htfClose < v.htfEma;
    const volumeSpike = bar.volume > v.volumeMa * options.volMult;
    const ranging = v.adx < options.adxThreshold;
    const inSession = !options.useSession || sessionAllows(bar, options.sessionHours);
    const exhaustionLong = !options.useExhaustion || (v.rsi < options.rsiOversold && lowerWickRatio > options.wickRatioMin && bar.close > bar.open);
    const exhaustionShort = !options.useExhaustion || (v.rsi > options.rsiOverbought && upperWickRatio > options.wickRatioMin && bar.close < bar.open);
    const runtime = context.strategyRuntime || {};
    const lastStop = runtime.lastStopBarByDirection || {};
    const longCooldown = Number.isInteger(lastStop.LONG) && index - lastStop.LONG < options.cooldownBars;
    const shortCooldown = Number.isInteger(lastStop.SHORT) && index - lastStop.SHORT < options.cooldownBars;
    const indicators = { ...v, lowerWickRatio, upperWickRatio, volumeSpike, ranging, inSession, localUp, localDown, htfUp, htfDown, longCooldown, shortCooldown };

    const long = localUp && htfUp && price <= v.bbLower && volumeSpike && inSession && ranging && !longCooldown && exhaustionLong;
    const short = options.allowShorts && localDown && htfDown && price >= v.bbUpper && volumeSpike && inSession && ranging && !shortCooldown && exhaustionShort;
    if (!long && !short) return flat(["Entry filters not fully aligned"], indicators, null, price);
    const signal = long ? "LONG" : "SHORT";
    return {
      signal, strategy: ID, price, error: null,
      reasons: [`${signal} filters aligned on BTC ${context.interval || "4h"}`, `HTF ${v.htf} close ${v.htfClose.toFixed(2)} vs EMA${options.htfEmaLen} ${v.htfEma.toFixed(2)}`],
      indicators, confidence: null,
      stopHint: signal === "LONG" ? price - v.atr * options.atrStopMult : price + v.atr * options.atrStopMult,
      targetHint: v.bbMid,
    };
  },

  // Called by native replay at each candle close. These are the Pine orders:
  // ATR stop and BB midpoint are refreshed, then the time stop closes at market.
  managePosition(candles, index, position, context = {}) {
    const options = { ...DEFAULTS, ...(context.options || {}) };
    const v = indicatorsAt(candles, index, options, context.interval || "4h");
    const entryIndex = Number(position.meta && position.meta.entryBarIndex);
    const barsHeld = Number.isInteger(entryIndex) ? index - entryIndex + 1 : 1;
    return {
      stopLoss: position.direction === "LONG"
        ? position.requestedEntryPrice - v.atr * options.atrStopMult
        : position.requestedEntryPrice + v.atr * options.atrStopMult,
      target: v.bbMid,
      closeAtMarket: barsHeld >= options.maxBarsInTrade,
      closeReason: "TIME_STOP",
      barsHeld,
    };
  },
};

module.exports = { bbMeanReversionV4, BB_MEAN_REVERSION_V4_DEFAULTS: DEFAULTS, indicatorsAt, aggregateClosedHtf };
