"use strict";

const {
  DEFAULT_TOKENS,
  dropUnclosedCandle,
  ema,
  rsi,
  vwapSeries,
} = require("./signal-screener");

const SUPPORTED_INTERVALS = new Set(["1h", "4h", "1D"]);
const DEFAULT_STRATEGY_OPTIONS = {
  trendEmaLen: 100,
  entryEmaLen: 21,
  rsiLen: 14,
  atrLen: 14,
  atrMultSL: 1.2,
  rr: 2,
  useVwap: true,
  allowLong: true,
  allowShort: true,
  feePct: 0.1,
  maxTrades: 50,
};

function normalizeSymbol(symbol) {
  const raw = String(symbol || "BTCUSDT").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return "BTCUSDT";
  return raw.endsWith("USDT") ? raw : `${raw}USDT`;
}

function numberOption(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function boolOption(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function resolveOptions(options = {}) {
  return {
    trendEmaLen: Math.round(numberOption(options.trendEmaLen, DEFAULT_STRATEGY_OPTIONS.trendEmaLen, 2, 300)),
    entryEmaLen: Math.round(numberOption(options.entryEmaLen, DEFAULT_STRATEGY_OPTIONS.entryEmaLen, 2, 100)),
    rsiLen: Math.round(numberOption(options.rsiLen, DEFAULT_STRATEGY_OPTIONS.rsiLen, 2, 100)),
    atrLen: Math.round(numberOption(options.atrLen, DEFAULT_STRATEGY_OPTIONS.atrLen, 2, 100)),
    atrMultSL: numberOption(options.atrMultSL, DEFAULT_STRATEGY_OPTIONS.atrMultSL, 0.2, 10),
    rr: numberOption(options.rr, DEFAULT_STRATEGY_OPTIONS.rr, 0.5, 10),
    useVwap: boolOption(options.useVwap, DEFAULT_STRATEGY_OPTIONS.useVwap),
    allowLong: boolOption(options.allowLong, DEFAULT_STRATEGY_OPTIONS.allowLong),
    allowShort: boolOption(options.allowShort, DEFAULT_STRATEGY_OPTIONS.allowShort),
    feePct: numberOption(options.feePct, DEFAULT_STRATEGY_OPTIONS.feePct, 0, 2),
    maxTrades: Math.round(numberOption(options.maxTrades, DEFAULT_STRATEGY_OPTIONS.maxTrades, 1, 200)),
  };
}

function atrSeries(candles, length) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= length) return out;

  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }

  let avg = 0;
  for (let i = 1; i <= length; i++) avg += tr[i];
  avg /= length;
  out[length] = avg;

  for (let i = length + 1; i < candles.length; i++) {
    avg = (avg * (length - 1) + tr[i]) / length;
    out[i] = avg;
  }

  return out;
}

function safeRound(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function signalAtIndex({ candles, i, trendEma, entryEma, rsiValues, vwap, atrValues, options }) {
  if (i <= 0) return { signal: "WAIT", reason: "Need a previous candle" };

  const close = candles[i].close;
  const prevClose = candles[i - 1].close;
  const trend = trendEma[i];
  const entry = entryEma[i];
  const prevEntry = entryEma[i - 1];
  const r = rsiValues[i];
  const vw = vwap[i];
  const atr = atrValues[i];

  if ([trend, entry, prevEntry, r, atr].some((value) => value == null) || (options.useVwap && vw == null)) {
    return { signal: "WAIT", reason: "Indicators warming up" };
  }

  const crossedUp = prevClose <= prevEntry && close > entry;
  const crossedDown = prevClose >= prevEntry && close < entry;
  const longChecks = [close > trend, crossedUp, r > 50, !options.useVwap || close > vw];
  const shortChecks = [close < trend, crossedDown, r < 50, !options.useVwap || close < vw];
  const longScore = longChecks.filter(Boolean).length;
  const shortScore = shortChecks.filter(Boolean).length;

  if (options.allowLong && longChecks.every(Boolean)) {
    const stop = close - atr * options.atrMultSL;
    return {
      signal: "LONG",
      side: "LONG",
      score: longScore,
      entry: close,
      stop,
      target: close + (close - stop) * options.rr,
      rsi: r,
      trendEma: trend,
      entryEma: entry,
      vwap: vw,
      atr,
      reason: "Trend EMA + entry EMA crossover + RSI momentum",
    };
  }

  if (options.allowShort && shortChecks.every(Boolean)) {
    const stop = close + atr * options.atrMultSL;
    return {
      signal: "SHORT",
      side: "SHORT",
      score: shortScore,
      entry: close,
      stop,
      target: close - (stop - close) * options.rr,
      rsi: r,
      trendEma: trend,
      entryEma: entry,
      vwap: vw,
      atr,
      reason: "Trend EMA + entry EMA crossunder + RSI momentum",
    };
  }

  const bias = longScore > shortScore ? "LONG WATCH" : shortScore > longScore ? "SHORT WATCH" : "FLAT";
  return {
    signal: bias,
    score: Math.max(longScore, shortScore),
    rsi: r,
    trendEma: trend,
    entryEma: entry,
    vwap: vw,
    atr,
    reason: `${Math.max(longScore, shortScore)}/4 checks aligned`,
  };
}

function closePosition(position, candle, index, options) {
  if (!position) return null;

  const isLong = position.side === "LONG";
  const stopHit = isLong ? candle.low <= position.stop : candle.high >= position.stop;
  const targetHit = isLong ? candle.high >= position.target : candle.low <= position.target;

  // If both levels print inside the same candle, assume the stop hit first.
  // That is conservative and avoids overstating backtest quality from OHLC data.
  const exitReason = stopHit ? "STOP" : targetHit ? "TARGET" : null;
  if (!exitReason) return null;

  const exit = exitReason === "STOP" ? position.stop : position.target;
  const grossPct = isLong
    ? ((exit - position.entry) / position.entry) * 100
    : ((position.entry - exit) / position.entry) * 100;
  const netPct = grossPct - options.feePct * 2;

  return {
    side: position.side,
    entry: safeRound(position.entry, 6),
    exit: safeRound(exit, 6),
    stop: safeRound(position.stop, 6),
    target: safeRound(position.target, 6),
    grossPct: safeRound(grossPct, 2),
    netPct: safeRound(netPct, 2),
    exitReason,
    openedAt: new Date(position.openTime).toISOString(),
    closedAt: new Date(candle.openTime).toISOString(),
    barsHeld: index - position.index,
  };
}

function summarizeTrades(trades) {
  const total = trades.length;
  const wins = trades.filter((trade) => trade.netPct > 0);
  const losses = trades.filter((trade) => trade.netPct <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.netPct, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPct, 0));

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100);
  }

  return {
    trades: total,
    wins: wins.length,
    losses: losses.length,
    winRate: total ? safeRound((wins.length / total) * 100, 1) : 0,
    netPct: safeRound((equity - 1) * 100, 2),
    profitFactor: grossLoss ? safeRound(grossWin / grossLoss, 2) : wins.length ? null : 0,
    maxDrawdown: safeRound(maxDrawdown, 2),
    avgNetPct: total ? safeRound(trades.reduce((sum, trade) => sum + trade.netPct, 0) / total, 2) : 0,
  };
}

function backtestStrategy(candles, interval, rawOptions = {}) {
  const options = resolveOptions(rawOptions);
  const cleanCandles = dropUnclosedCandle(candles || []);
  const minCandles = Math.max(options.trendEmaLen, options.entryEmaLen, options.rsiLen, options.atrLen) + 5;

  if (cleanCandles.length < minCandles) {
    return {
      error: `Need at least ${minCandles} closed candles; only ${cleanCandles.length} available`,
      options,
      summary: summarizeTrades([]),
      trades: [],
      latestSignal: { signal: "WAIT", reason: "Not enough candle history" },
    };
  }

  const closes = cleanCandles.map((candle) => candle.close);
  const trendEma = ema(closes, options.trendEmaLen);
  const entryEma = ema(closes, options.entryEmaLen);
  const rsiValues = rsi(closes, options.rsiLen);
  const atrValues = atrSeries(cleanCandles, options.atrLen);
  const vwap = vwapSeries(cleanCandles, interval === "1D" ? "month" : "day");
  const trades = [];
  let position = null;

  for (let i = 1; i < cleanCandles.length; i++) {
    if (position) {
      const closed = closePosition(position, cleanCandles[i], i, options);
      if (closed) {
        trades.push(closed);
        position = null;
        if (trades.length >= options.maxTrades) break;
        continue;
      }
    }

    const signal = signalAtIndex({ candles: cleanCandles, i, trendEma, entryEma, rsiValues, vwap, atrValues, options });
    if (!position && (signal.signal === "LONG" || signal.signal === "SHORT")) {
      position = {
        side: signal.signal,
        entry: signal.entry,
        stop: signal.stop,
        target: signal.target,
        index: i,
        openTime: cleanCandles[i].openTime,
      };
    }
  }

  const lastIndex = cleanCandles.length - 1;
  const latestSignal = signalAtIndex({ candles: cleanCandles, i: lastIndex, trendEma, entryEma, rsiValues, vwap, atrValues, options });

  return {
    options,
    summary: summarizeTrades(trades),
    latestSignal: {
      signal: latestSignal.signal,
      score: latestSignal.score ?? null,
      reason: latestSignal.reason,
      price: safeRound(cleanCandles[lastIndex].close, 6),
      entry: safeRound(latestSignal.entry, 6),
      stop: safeRound(latestSignal.stop, 6),
      target: safeRound(latestSignal.target, 6),
      rsi: safeRound(latestSignal.rsi, 1),
      trendEma: safeRound(latestSignal.trendEma, 6),
      entryEma: safeRound(latestSignal.entryEma, 6),
      vwap: safeRound(latestSignal.vwap, 6),
      atr: safeRound(latestSignal.atr, 6),
    },
    openPosition: position
      ? {
          side: position.side,
          entry: safeRound(position.entry, 6),
          stop: safeRound(position.stop, 6),
          target: safeRound(position.target, 6),
          openedAt: new Date(position.openTime).toISOString(),
        }
      : null,
    trades: trades.slice(-10).reverse(),
    candleCount: cleanCandles.length,
  };
}

class StrategyEngineService {
  constructor({ signalScreenerService, tokens, options } = {}) {
    if (!signalScreenerService) throw new Error("StrategyEngineService requires signalScreenerService");
    this._signalScreenerService = signalScreenerService;
    this._tokens = tokens && tokens.length ? tokens.map(normalizeSymbol) : DEFAULT_TOKENS.slice(0, 12);
    this._options = resolveOptions(options);
  }

  async analyze({ symbol, interval, options } = {}) {
    const resolvedInterval = SUPPORTED_INTERVALS.has(interval) ? interval : "4h";
    const resolvedSymbol = normalizeSymbol(symbol);
    const resolvedOptions = resolveOptions({ ...this._options, ...(options || {}) });
    const candles = await this._signalScreenerService.getCandles(resolvedSymbol, resolvedInterval);
    const result = backtestStrategy(candles, resolvedInterval, resolvedOptions);

    return {
      symbol: resolvedSymbol,
      interval: resolvedInterval,
      strategy: "LTF Trend Entry — EMA/VWAP/RSI/ATR",
      updatedAt: new Date().toISOString(),
      ...result,
    };
  }

  async scan({ symbols, interval, options } = {}) {
    const list = (Array.isArray(symbols) && symbols.length ? symbols : this._tokens)
      .map(normalizeSymbol)
      .filter(Boolean)
      .slice(0, 25);
    const results = await Promise.all(
      list.map(async (symbol) => {
        try {
          return await this.analyze({ symbol, interval, options });
        } catch (err) {
          return { symbol, interval: interval || "4h", error: err.message };
        }
      }),
    );

    return {
      interval: SUPPORTED_INTERVALS.has(interval) ? interval : "4h",
      strategy: "LTF Trend Entry — EMA/VWAP/RSI/ATR",
      updatedAt: new Date().toISOString(),
      results,
    };
  }
}

module.exports = {
  StrategyEngineService,
  atrSeries,
  backtestStrategy,
  normalizeSymbol,
  resolveOptions,
};
