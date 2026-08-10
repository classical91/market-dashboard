"use strict";

// Bar-replay backtesting for the Trading Lab.
//
// The whole point of this module is that it does NOT reimplement fills. It
// replays historical candles through the same PaperTradingService that live
// paper trading uses, so a backtest and a forward paper run agree by
// construction: same TP1 scale-out, same breakeven stop move, same gap-aware
// stop fill, same win/loss accounting, same metrics.
//
// Two things make a backtest lie, and both are addressed explicitly:
//
//   Lookahead. Indicators and signals at bar i are computed from bars 0..i
//   only, and an entry fills at bar i's close — never at a price the strategy
//   could not have known when it decided.
//
//   Optimistic intra-bar ordering. A candle only tells us open/high/low/close,
//   not the path between them. When both a stop and a target sit inside one
//   bar's range, assuming the target came first inflates every result. So each
//   bar is replayed as a sequence — open, then the ADVERSE extreme, then the
//   favourable one, then close — which makes the paper trader fire the stop
//   first whenever both were reachable. Results are pessimistic by design.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getTradingConfig } = require("./config");
const { runChecklist, marketState } = require("./checklist");
const { assessEdge } = require("./edge-gate");
const { planTrade } = require("./risk");
const { buildStrategyMetrics } = require("./metrics");
const { PaperTradingService } = require("./paper-trader");
const { replayOrder } = require("./replay-order");
const { atr } = require("../decision-engine");
const { ema, macd } = require("../signal-screener");

// Bars needed before the first signal can be trusted: the slowest indicator
// here is the MACD's 26-period slow EMA plus its 9-period signal line.
const MIN_WARMUP_BARS = 60;

function last(values) {
  return values.length ? values[values.length - 1] : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

// Market context as of the close of `bars[bars.length - 1]`, computed from
// that bar and everything before it. Nothing later is in scope — this function
// is the lookahead barrier.
function contextAtBar(bars, config) {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const close = last(closes);

  const atrValue = atr(bars, 14);
  // ATR relative to its own recent average, which is what the checklist's
  // volatility rules are expressed in.
  const atrHistory = [];
  for (let i = Math.max(15, bars.length - 20); i < bars.length; i += 1) {
    const value = atr(bars.slice(0, i + 1), 14);
    if (value != null) atrHistory.push(value);
  }
  const atrRatio = atrValue && atrHistory.length ? atrValue / mean(atrHistory) : 1;

  const volumeAvg = mean(volumes.slice(-20));
  const volumeRatio = volumeAvg > 0 ? last(volumes) / volumeAvg : 1;

  const { macdLine, signalLine } = macd(closes, config.macdFast, config.macdSlow, config.macdSignal);
  const macdValue = last(macdLine);
  const macdSignalValue = last(signalLine);
  const macdBullish =
    macdValue != null && macdSignalValue != null ? macdValue > macdSignalValue : null;

  const fast = last(ema(closes, config.trendFast));
  const slow = last(ema(closes, config.trendSlow));

  return {
    bar: bars[bars.length - 1],
    close,
    atr: atrValue,
    atrRatio,
    volumeRatio,
    macdBullish,
    emaFast: fast,
    emaSlow: slow,
    trendUp: fast != null && slow != null ? fast > slow : null,
  };
}

// Default strategy: trade in the direction of the moving-average trend when
// price closes beyond the prior `breakoutLookback` bars' extreme. Deliberately
// plain — the interesting machinery is the gauntlet every candidate then runs,
// not this rule. Pass your own `strategy` to replace it.
function trendBreakoutStrategy({ bars, context, options }) {
  const lookback = options.breakoutLookback;
  if (bars.length < lookback + 2 || context.trendUp === null) return null;

  // The window excludes the current bar: breaking a range you are part of is
  // not a breakout.
  const prior = bars.slice(-(lookback + 1), -1);
  const priorHigh = Math.max(...prior.map((b) => b.high));
  const priorLow = Math.min(...prior.map((b) => b.low));

  if (context.trendUp && context.close > priorHigh) return "LONG";
  if (!context.trendUp && context.close < priorLow) return "SHORT";
  return null;
}

// The market state the checklist scores. Regime and bias come from the same
// trend read the strategy uses, so a backtest is internally consistent even
// though it has no live macro feed to draw on.
function stateFromContext(context) {
  return marketState({
    regime: context.trendUp === null ? "RANGE" : context.trendUp ? "TREND_UP" : "TREND_DOWN",
    dailyBias: context.trendUp === null ? "NEUTRAL" : context.trendUp ? "BULLISH" : "BEARISH",
    macdBullish: context.macdBullish,
    atrRatio: context.atrRatio,
    volumeRatio: context.volumeRatio,
    // No macro or calendar feed exists for a historical bar, so these keep
    // their neutral defaults rather than being invented. That costs a
    // candidate the macro block's full credit, which is the honest outcome:
    // absent evidence is not evidence.
  });
}

class BacktestService {
  constructor({ config = getTradingConfig(), signalScreenerService = null } = {}) {
    this.config = config;
    this.signalScreenerService = signalScreenerService;
  }

  async getCandles(symbol, interval) {
    if (!this.signalScreenerService) {
      throw Object.assign(new Error("No candle source configured for backtesting"), {
        statusCode: 503,
        expose: true,
      });
    }
    return this.signalScreenerService.getCandles(symbol, interval);
  }

  // Replay `candles` bar by bar. Returns the trade log, equity curve and the
  // same metrics shape the live books report, so the two are comparable.
  async run({
    symbol,
    interval = "4h",
    candles,
    strategy = trendBreakoutStrategy,
    options = {},
    warmupBars = MIN_WARMUP_BARS,
  }) {
    const opts = {
      breakoutLookback: 20,
      trendFast: 21,
      trendSlow: 55,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      ...options,
    };

    const bars = (candles || []).filter(
      (c) => Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close),
    );
    if (bars.length <= warmupBars + 1) {
      throw Object.assign(
        new Error(`Not enough candles to backtest: need more than ${warmupBars + 1}, got ${bars.length}`),
        { statusCode: 400, expose: true },
      );
    }

    // A throwaway ledger in a temp directory. A backtest must never touch the
    // live books, and it must not inherit their history either — the edge gate
    // has to see only the trades this run produced.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-backtest-"));
    const trader = new PaperTradingService({ dataDir: dir, book: "backtest", config: this.config });

    const equityCurve = [];
    const skipped = [];
    let mixedDirectionBars = 0;

    try {
      for (let i = warmupBars; i < bars.length; i += 1) {
        const history = bars.slice(0, i + 1);
        const bar = bars[i];

        // 1. Replay this bar against open positions BEFORE considering a new
        // entry, so a position opened last bar gets its stop and targets
        // tested on this one.
        const ordering = replayOrder(trader, bar);
        if (ordering.mixed) mixedDirectionBars += 1;
        for (const price of ordering.prices) {
          await trader.updatePositions({ [symbol]: price });
        }

        // 2. Ask the strategy about the bar that just closed.
        const context = contextAtBar(history, opts);
        const direction = strategy({ bars: history, context, options: opts, symbol });

        if (direction === "LONG" || direction === "SHORT") {
          const outcome = this.tryOpen({ trader, symbol, direction, context, interval });
          if (!outcome.opened) skipped.push({ at: bar.closeTime, direction, reasons: outcome.reasons });
        }

        const account = trader.getAccount();
        const unrealized = trader
          .getOpenPositions()
          .reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0);
        equityCurve.push({
          at: bar.closeTime,
          close: bar.close,
          balance: account.balance,
          equity: Math.round((account.balance + unrealized) * 100) / 100,
          openPositions: trader.getOpenPositions().length,
        });
      }

      // Any position still open at the end is marked at the final close but
      // left open — force-closing it would invent an exit the strategy never
      // signalled, and counting it as a closed trade would pollute expectancy.
      const openAtEnd = trader.getOpenPositions();
      const stats = await trader.getStats();
      const account = trader.getAccount();

      return {
        symbol,
        interval,
        bars: bars.length,
        warmupBars,
        from: bars[warmupBars].closeTime,
        to: bars[bars.length - 1].closeTime,
        options: opts,
        stats,
        metrics: buildStrategyMetrics(trader.getHistory(), account.startingBalance),
        trades: trader.getHistory(),
        openAtEnd,
        skipped,
        equityCurve,
        // Surfaced rather than hidden: with long and short positions open on
        // the same symbol at once, one intra-bar ordering cannot be
        // pessimistic for both sides.
        caveats: mixedDirectionBars
          ? [`${mixedDirectionBars} bar(s) had both long and short positions open; intra-bar ordering favoured the longs' stop`]
          : [],
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // One candidate through the full gauntlet, entering at the signalling bar's
  // close. Mirrors TradingLabService.evaluate() but against the backtest's own
  // isolated ledger.
  tryOpen({ trader, symbol, direction, context, interval }) {
    const state = marketState({ ...stateFromContext(context), ...trader.getRiskState() });
    const checklist = runChecklist({ symbol, direction, price: context.close, atr: context.atr }, state, this.config);

    const account = trader.getAccount();
    const edge = assessEdge({
      history: trader.getHistory(),
      startingBalance: account.startingBalance,
      strategy: `backtest:${interval}`,
      symbol,
      score: checklist.confidenceScore,
      config: this.config,
    });

    const sizeMultiplier = checklist.sizeMultiplier * edge.sizeMultiplier;
    const reasons = [...checklist.reasons, ...edge.reasons];
    if (checklist.decision === "SKIP" || edge.decision === "BLOCK" || sizeMultiplier <= 0) {
      return { opened: false, reasons };
    }

    const trade = planTrade({
      symbol,
      direction,
      entryPrice: context.close,
      atr: context.atr,
      sizeMultiplier,
      config: this.config,
    });
    if (!trade.ok) return { opened: false, reasons: [...reasons, trade.reason] };

    try {
      trader.openPosition({
        symbol,
        direction,
        size: trade.size,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        tp1: trade.tp1,
        tp2: trade.tp2,
        riskUsd: trade.riskUsd,
        confidenceScore: checklist.confidenceScore,
        signalSource: `backtest:${interval}`,
      });
      return { opened: true, reasons };
    } catch (err) {
      // The position cap is a legitimate outcome, not an error.
      return { opened: false, reasons: [...reasons, err.message] };
    }
  }

  async backtestSymbol({ symbol, interval = "4h", options = {}, strategy } = {}) {
    const candles = await this.getCandles(symbol, interval);
    return this.run({ symbol, interval, candles, options, strategy });
  }
}

module.exports = {
  BacktestService,
  trendBreakoutStrategy,
  contextAtBar,
  stateFromContext,
  MIN_WARMUP_BARS,
};
