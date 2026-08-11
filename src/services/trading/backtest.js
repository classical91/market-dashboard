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
const { getStrategy, DEFAULT_STRATEGY_ID } = require("./strategies");
const { summarizeRun, costSummary } = require("./run-summary");
const { buildExperimentRecord } = require("./experiment-record");

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

// Accept either shape of strategy and return one calling convention.
//
//   * A registry id ("mindset_v1") or a strategy object — the interface in
//     ./strategies, evaluate(candles, index, context) -> signal object.
//   * A bare function — the original { bars, context, options, symbol } ->
//     "LONG" | "SHORT" | null convention, kept because tests and callers use
//     it to inject one-off rules without registering them.
//
// Everything downstream sees the richer signal object, so a legacy function's
// output is widened rather than the new strategies' being narrowed.
function resolveStrategy(strategy) {
  if (typeof strategy === "function") {
    return {
      definition: {
        id: "custom",
        name: "Custom function",
        description: "Inline strategy function supplied by the caller",
        requiredWarmupBars: 0,
      },
      evaluate: ({ bars, context, options, symbol }) => {
        const direction = strategy({ bars, context, options, symbol });
        return {
          signal: direction === "LONG" || direction === "SHORT" ? direction : "FLAT",
          strategy: "custom",
          price: context.close,
          error: null,
          reasons: [],
          indicators: {},
          confidence: null,
          stopHint: null,
          targetHint: null,
        };
      },
    };
  }

  const definition =
    strategy && typeof strategy === "object" && typeof strategy.evaluate === "function"
      ? strategy
      : getStrategy(strategy);

  return {
    definition,
    evaluate: ({ bars, context, options, symbol }) =>
      // `bars` is already truncated at the decided bar, so a strategy that
      // ignored its `index` argument still could not see the future.
      definition.evaluate(bars, bars.length - 1, {
        options,
        symbol,
        trendUp: context.trendUp,
        close: context.close,
        atr: context.atr,
      }),
  };
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
  // `experimentStore` is optional and only ever written to when a caller asks
  // for it: a run is research, and research is recorded on purpose, not as a
  // side effect of pressing a button.
  constructor({ config = getTradingConfig(), signalScreenerService = null, experimentStore = null, logger = console } = {}) {
    this.config = config;
    this.signalScreenerService = signalScreenerService;
    this.experimentStore = experimentStore;
    this._logger = logger;
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
    const resolved = resolveStrategy(strategy);
    // A strategy's own warmup requirement is a floor, not a suggestion:
    // signalling before its slowest input has settled is noise, not history.
    const warmup = Math.max(warmupBars, resolved.definition.requiredWarmupBars || 0);

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
    if (bars.length <= warmup + 1) {
      throw Object.assign(
        new Error(`Not enough candles to backtest: need more than ${warmup + 1}, got ${bars.length}`),
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
    const signals = [];
    let mixedDirectionBars = 0;

    try {
      for (let i = warmup; i < bars.length; i += 1) {
        const history = bars.slice(0, i + 1);
        const bar = bars[i];

        // 1. Replay this bar against open positions BEFORE considering a new
        // entry, so a position opened last bar gets its stop and targets
        // tested on this one.
        const ordering = replayOrder(trader, bar);
        if (ordering.mixed) mixedDirectionBars += 1;
        for (const price of ordering.prices) {
          await trader.updatePositions({ [symbol]: price }, { at: bar.closeTime });
        }

        // 2. Ask the strategy about the bar that just closed.
        const context = contextAtBar(history, opts);
        const signal = resolved.evaluate({ bars: history, context, options: opts, symbol });
        const direction = signal.signal;

        if (direction === "LONG" || direction === "SHORT") {
          signals.push({ at: bar.closeTime, signal: direction, price: signal.price ?? context.close, reasons: signal.reasons || [], indicators: signal.indicators || {}, confidence: signal.confidence ?? null });
          const outcome = this.tryOpen({
            trader,
            symbol,
            direction,
            context,
            interval,
            strategyId: resolved.definition.id,
            signal,
          });
          if (!outcome.opened) {
            skipped.push({
              at: bar.closeTime,
              direction,
              // The strategy's own reasoning first, then the gauntlet's — a
              // refused candidate should say what fired it as well as what
              // stopped it.
              reasons: [...(signal.reasons || []), ...outcome.reasons],
            });
          }
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
        strategy: resolved.definition.id,
        strategyName: resolved.definition.name,
        bars: bars.length,
        warmupBars: warmup,
        from: bars[warmup].closeTime,
        to: bars[bars.length - 1].closeTime,
        options: opts,
        costs: costSummary(this.config),
        stats,
        metrics: buildStrategyMetrics(trader.getHistory(), account.startingBalance),
        trades: trader.getHistory(),
        openAtEnd,
        skipped,
        // Every entry signal the strategy produced, whether or not the
        // gauntlet let it through, with the reasons it fired.
        signals,
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
  tryOpen({ trader, symbol, direction, context, interval, strategyId = DEFAULT_STRATEGY_ID, signal = null }) {
    const signalSource = `backtest:${strategyId}:${interval}`;
    const state = marketState({ ...stateFromContext(context), ...trader.getRiskState() });
    const checklist = runChecklist({ symbol, direction, price: context.close, atr: context.atr }, state, this.config);

    const account = trader.getAccount();
    const edge = assessEdge({
      history: trader.getHistory(),
      startingBalance: account.startingBalance,
      strategy: signalSource,
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
        signalSource,
        // Stop and target HINTS from the strategy are recorded, not applied:
        // sizing and exits stay with planTrade and the paper trader so two
        // strategies' results are compared on the same execution model.
        meta: signal
          ? {
              strategy: strategyId,
              strategyConfidence: signal.confidence ?? null,
              stopHint: signal.stopHint ?? null,
              targetHint: signal.targetHint ?? null,
            }
          : { strategy: strategyId },
        openedAt: context.bar.closeTime,
      });
      return { opened: true, reasons };
    } catch (err) {
      // The position cap is a legitimate outcome, not an error.
      return { opened: false, reasons: [...reasons, err.message] };
    }
  }

  async backtestSymbol({ symbol, interval = "4h", options = {}, strategy, record = false, notes = null } = {}) {
    // Resolve the strategy BEFORE fetching: a typo should come back as a 400
    // immediately, not as whatever the candle source happened to do first.
    // Resolving here also fixes the default: a symbol backtest with no
    // strategy runs mindset_v1, the strategy the live scanner runs, rather
    // than run()'s own trend-breakout placeholder.
    const resolved = typeof strategy === "function" ? strategy : resolveStrategy(strategy).definition;
    const candles = await this.getCandles(symbol, interval);
    const result = await this.run({ symbol, interval, candles, options, strategy: resolved });
    return record ? this.recordExperiment(result, { notes }) : result;
  }

  /**
   * Persist a finished run as an experiment and stamp its id onto the result.
   *
   * A failed write must not fail the backtest — the numbers on screen are
   * still true, they just did not get filed. The result then carries
   * `experimentId: null` plus the reason, which is honest about what happened
   * rather than implying a record exists.
   */
  recordExperiment(result, { notes = null } = {}) {
    if (!this.experimentStore) {
      return { ...result, experimentId: null, experimentError: "No experiment store is configured" };
    }
    try {
      const experiment = this.experimentStore.record(buildExperimentRecord(result, { notes }));
      return { ...result, experimentId: experiment.id };
    } catch (err) {
      this._logger.error?.(`[Backtest] Failed to record experiment: ${err.message}`);
      return { ...result, experimentId: null, experimentError: err.message };
    }
  }

  // Run several strategies over the SAME candles and reduce each result to the
  // handful of numbers that decide whether one is better than another. One
  // fetch, one candle set: a comparison where the strategies saw different
  // data would not be a comparison.
  async compare({ symbol, interval = "4h", strategies = [DEFAULT_STRATEGY_ID], options = {} } = {}) {
    const ids = (Array.isArray(strategies) && strategies.length ? strategies : [DEFAULT_STRATEGY_ID]).map(
      (id) => getStrategy(id).id,
    );
    const candles = await this.getCandles(symbol, interval);

    const rows = [];
    for (const id of ids) {
      const result = await this.run({ symbol, interval, candles, options, strategy: id });
      rows.push(summarizeRun(result));
    }

    return {
      symbol,
      interval,
      ranAt: new Date().toISOString(),
      // Same ordering rule the strategy metrics table uses: expectancy first,
      // then profit factor, then the smaller drawdown.
      results: rows.sort(
        (a, b) =>
          b.expectancyR - a.expectancyR ||
          (b.profitFactor === null ? 999 : b.profitFactor) - (a.profitFactor === null ? 999 : a.profitFactor) ||
          a.maxDrawdownPct - b.maxDrawdownPct,
      ),
    };
  }
}

module.exports = {
  BacktestService,
  summarizeRun,
  resolveStrategy,
  trendBreakoutStrategy,
  contextAtBar,
  stateFromContext,
  MIN_WARMUP_BARS,
};
