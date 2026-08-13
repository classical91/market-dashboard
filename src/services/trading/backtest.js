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
const { planTrade, calculatePositionSize } = require("./risk");
const { buildStrategyMetrics } = require("./metrics");
const { PaperTradingService } = require("./paper-trader");
const { replayOrder } = require("./replay-order");
const { atr } = require("../decision-engine");
const { ema, macd } = require("../signal-screener");
const {
  getStrategy,
  DEFAULT_STRATEGY_ID,
  warmupFor: strategyWarmupFor,
  assertValidOptions,
} = require("./strategies");
const { summarizeRun, costSummary } = require("./run-summary");
const { buildExperimentRecord } = require("./experiment-record");
const {
  STRATEGY_ID: BANANAGUN_STRATEGY_ID,
  loadEventDataset,
  replayBananaGunEvents,
} = require("./bananagun-event-replay");

// Bars needed before the first signal can be trusted: the slowest indicator
// here is the MACD's 26-period slow EMA plus its 9-period signal line.
const MIN_WARMUP_BARS = 60;

function last(values) {
  return values.length ? values[values.length - 1] : null;
}

// A comparison payload carries one equity curve per strategy so the UI can
// draw them. At one point per bar that is several thousand points per
// strategy for a chart a few hundred pixels wide, so the curve is thinned to
// at most `maxPoints` before it goes over the wire.
//
// The thinning keeps the FIRST and LAST points exactly, because the endpoints
// are the two the reader actually measures the run by, and steps evenly
// between them. It is a display reduction only: every metric in the row beside
// it was computed from the full curve.
function downsampleCurve(curve, maxPoints = 120) {
  if (!Array.isArray(curve) || curve.length <= maxPoints) return curve || [];
  const step = (curve.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(curve[Math.round(i * step)]);
  }
  return out;
}

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

// ── Execution modes ─────────────────────────────────────────────────────────
//
// A strategy signal carries `stopHint` and `targetHint` — where the strategy
// itself says the trade should be stopped and taken. Which of those the
// backtest actually USES is now a choice, because the two answer different
// questions and only one of them was previously available:
//
//   "shared"  Every strategy's stop and targets come from planTrade(): 1.5×ATR
//             stop, TP1 at 1.5R, TP2 at 2.5R. The strategies differ only in
//             WHERE THEY ENTER, so this compares entry signals on one common
//             execution model. This is the original behaviour and stays the
//             default.
//
//   "native"  The strategy's own stop and target are used. This is the
//             strategy as designed — vwap_reversion_v1 targeting VWAP is a
//             different trade from vwap_reversion_v1 targeting 2.5R, and only
//             this mode tests the former.
//
// Neither is "the correct one". A comparison table under shared execution
// ranks entry quality; the same table under native execution ranks whole
// strategies and is no longer apples-to-apples, because each row is using
// different exit rules. Both are legitimate; conflating them is not, which is
// why the mode is recorded on the result and on every trade.
const EXECUTION_MODES = Object.freeze(["shared", "native"]);

function assertValidExecutionMode(mode) {
  if (!EXECUTION_MODES.includes(mode)) {
    throw Object.assign(
      new Error(`Unknown executionMode "${mode}" (expected one of ${EXECUTION_MODES.join(", ")})`),
      { statusCode: 400, expose: true },
    );
  }
  return mode;
}

// Can this signal's own levels actually be traded?
//
// A hint is only usable if it is a finite number on the correct side of the
// entry: a long stop below the entry, a long target above it. A strategy that
// returns a stop on the wrong side has a bug, and opening the position anyway
// would book an instant fill and call it a result.
function nativeLevels({ direction, entryPrice, signal }) {
  const stop = Number(signal && signal.stopHint);
  const target = Number(signal && signal.targetHint);

  if (!Number.isFinite(stop) || !Number.isFinite(target)) {
    return { ok: false, reason: "strategy published no stop/target hints" };
  }
  const longWay = direction === "LONG";
  if (longWay ? !(stop < entryPrice) : !(stop > entryPrice)) {
    return { ok: false, reason: `stop hint ${stop} is on the wrong side of a ${direction} entry at ${entryPrice}` };
  }
  if (longWay ? !(target > entryPrice) : !(target < entryPrice)) {
    return { ok: false, reason: `target hint ${target} is on the wrong side of a ${direction} entry at ${entryPrice}` };
  }
  return { ok: true, stop, target };
}

// Rank the comparison rows, and be explicit about which rows are ranked at all.
//
// A null profit factor means two completely different things, and the old
// comparator treated them as one by substituting 999 for both:
//
//   * closedTrades > 0, no losses  — genuinely undefeated. Infinity is right.
//   * closedTrades === 0           — the strategy never traded, or had no
//                                    data. There is no profit factor because
//                                    there is no evidence, and sorting that to
//                                    the top put a strategy that did nothing
//                                    above every strategy that actually
//                                    traded.
//
// So rows below `minRankedTrades` closed trades are not ranked at all. They
// are kept, in the result, at the end of the list, flagged `rankable: false`
// with the reason — dropping them would hide a strategy that ran and refused
// everything, which is itself a finding.
function rankRows(rows, minRankedTrades = 1) {
  const decorated = rows.map((row) => {
    const trades = Number(row.closedTrades) || 0;
    const rankable = row.status !== "insufficient-data" && trades >= minRankedTrades;
    return {
      ...row,
      rankable,
      unrankedReason: rankable
        ? null
        : row.status === "insufficient-data"
          ? "insufficient data"
          : `${trades} closed trade(s), needs ${minRankedTrades}`,
    };
  });

  return decorated.sort((a, b) => {
    // Unranked rows always sit below ranked ones, whatever their numbers say.
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    if (!a.rankable && !b.rankable) return 0;

    // Infinity only for a row that actually traded and never lost — which,
    // among rankable rows, is what a null profit factor now means.
    const pf = (row) => (row.profitFactor === null ? Infinity : row.profitFactor);
    return (
      b.expectancyR - a.expectancyR ||
      pf(b) - pf(a) ||
      a.maxDrawdownPct - b.maxDrawdownPct
    );
  });
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
  constructor({ config = getTradingConfig(), signalScreenerService = null, experimentStore = null, dataDir = null, logger = console } = {}) {
    this.config = config;
    this.signalScreenerService = signalScreenerService;
    this.experimentStore = experimentStore;
    this.dataDir = dataDir;
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
    executionMode = "shared",
  }) {
    assertValidExecutionMode(executionMode);
    const resolved = resolveStrategy(strategy);
    if (resolved.definition.supportsBacktest === false) {
      throw Object.assign(
        new Error(`Strategy "${resolved.definition.id}" cannot run on candles; use event replay data instead`),
        { statusCode: 400, expose: true },
      );
    }
    // Caller options are validated BEFORE any bar is replayed, so a bad
    // parameter comes back as a 400 naming the parameter rather than as
    // whatever the arithmetic does with it several hundred bars later.
    assertValidOptions(resolved.definition, options);

    // A strategy's own warmup requirement is a floor, not a suggestion:
    // signalling before its slowest input has settled is noise, not history.
    // The floor is computed from the options this run will actually use —
    // `requiredWarmupBars` is only the answer for a run at defaults, and a
    // strategy handed a longer lookback than that needs the extra bars
    // reserved or it reads off the front of the array.
    const warmup = Math.max(warmupBars, strategyWarmupFor(resolved.definition, options));

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
    // Trades that asked for native execution and could not get it, because the
    // strategy published no usable levels. Counted so the result can say so
    // rather than presenting a shared-execution run as a native one.
    let nativeFallbacks = 0;

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
            allowCounterTrend: resolved.definition.tradesCounterTrend === true,
            executionMode,
          });
          if (outcome.opened && executionMode === "native" && outcome.appliedMode !== "native") {
            nativeFallbacks += 1;
          }
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
        executionMode,
        nativeFallbacks,
        caveats: [
          ...(mixedDirectionBars
            ? [`${mixedDirectionBars} bar(s) had both long and short positions open; intra-bar ordering favoured the longs' stop`]
            : []),
          // The single most misreadable outcome in this whole module: a run
          // labelled "native" that silently used shared levels throughout.
          ...(nativeFallbacks
            ? [
                `${nativeFallbacks} of these trades ran on SHARED execution despite executionMode=native: ` +
                  `${resolved.definition.id} published no usable stop/target for them, so planTrade's levels were used instead`,
              ]
            : []),
        ],
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // One candidate through the full gauntlet, entering at the signalling bar's
  // close. Mirrors TradingLabService.evaluate() but against the backtest's own
  // isolated ledger.
  tryOpen({
    trader,
    symbol,
    direction,
    context,
    interval,
    strategyId = DEFAULT_STRATEGY_ID,
    signal = null,
    // Off unless the strategy definition declares it. A caller cannot turn it
    // on for a strategy that did not ask for it, so the waiver stays a
    // property of the strategy rather than of whoever ran the backtest.
    allowCounterTrend = false,
    // "shared" (default) or "native" — see EXECUTION_MODES above.
    executionMode = "shared",
  }) {
    const signalSource = `backtest:${strategyId}:${interval}`;
    const state = marketState({ ...stateFromContext(context), ...trader.getRiskState() });
    const checklist = runChecklist(
      { symbol, direction, price: context.close, atr: context.atr, allowCounterTrend },
      state,
      this.config,
    );

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

    // Under native execution the strategy's own levels replace planTrade's,
    // and the size is recomputed from the new stop distance so the dollar risk
    // per trade is IDENTICAL to shared mode. That matters: if native trades
    // silently risked more, a mode comparison would be measuring position size
    // rather than exit rules.
    let levels = { stopLoss: trade.stopLoss, tp1: trade.tp1, tp2: trade.tp2, size: trade.size };
    let appliedMode = "shared";

    if (executionMode === "native") {
      const native = nativeLevels({ direction, entryPrice: trade.entryPrice, signal });
      if (native.ok) {
        const size = calculatePositionSize({
          entryPrice: trade.entryPrice,
          stopLoss: native.stop,
          accountSize: this.config.accountSize,
          riskPct: this.config.maxRiskPerTrade,
          sizeMultiplier,
        });
        if (size > 0) {
          // One target, not two. The strategy named a single level, so TP1 and
          // TP2 both sit there and the position closes fully when it is
          // reached — inventing a second, further target the strategy never
          // asked for would be this mode making up the exit it exists to test.
          levels = { stopLoss: native.stop, tp1: native.target, tp2: native.target, size };
          appliedMode = "native";
          reasons.push(`Native execution: stop ${native.stop}, target ${native.target}`);
        } else {
          reasons.push("Native execution: stop distance produced a zero size — fell back to shared levels");
        }
      } else {
        // Recorded, never silent. mindset_v1 publishes no hints at all, so a
        // native run of it is really a shared run, and a caller who is not
        // told that will read the result as something it is not.
        reasons.push(`Native execution unavailable (${native.reason}) — fell back to shared levels`);
      }
    }

    try {
      trader.openPosition({
        symbol,
        direction,
        size: levels.size,
        entryPrice: trade.entryPrice,
        stopLoss: levels.stopLoss,
        tp1: levels.tp1,
        tp2: levels.tp2,
        riskUsd: trade.riskUsd,
        confidenceScore: checklist.confidenceScore,
        signalSource,
        // Under shared execution the strategy's hints are RECORDED, not
        // applied — exits stay with planTrade so strategies are compared on
        // one execution model. Under native execution they are what the
        // position above is actually using. `executionMode` says which, on
        // every trade, so a ledger is never ambiguous about it.
        meta: signal
          ? {
              strategy: strategyId,
              strategyConfidence: signal.confidence ?? null,
              stopHint: signal.stopHint ?? null,
              targetHint: signal.targetHint ?? null,
              executionMode: appliedMode,
            }
          : { strategy: strategyId, executionMode: appliedMode },
        openedAt: context.bar.closeTime,
      });
      return { opened: true, reasons, appliedMode };
    } catch (err) {
      // The position cap is a legitimate outcome, not an error.
      return { opened: false, reasons: [...reasons, err.message] };
    }
  }

  async backtestSymbol({
    symbol,
    interval = "4h",
    options = {},
    strategy,
    record = false,
    notes = null,
    executionMode = "shared",
  } = {}) {
    // Resolve the strategy BEFORE fetching: a typo should come back as a 400
    // immediately, not as whatever the candle source happened to do first.
    // Resolving here also fixes the default: a symbol backtest with no
    // strategy runs mindset_v1, the strategy the live scanner runs, rather
    // than run()'s own trend-breakout placeholder.
    const resolved = typeof strategy === "function" ? strategy : resolveStrategy(strategy).definition;
    // Options are checked here too, for the same reason the strategy is: a bad
    // parameter should come back as a 400 before a candle fetch is spent on
    // it, not after. run() validates again — it is also called directly.
    assertValidExecutionMode(executionMode);
    if (resolved && typeof resolved === "object") assertValidOptions(resolved, options);
    if (resolved && resolved.id === BANANAGUN_STRATEGY_ID) {
      const dataset = loadEventDataset(this.dataDir, BANANAGUN_STRATEGY_ID);
      const result = dataset.status === "available"
        ? replayBananaGunEvents({ events: dataset.events, dataSource: dataset.path })
        : replayBananaGunEvents({ events: [], dataSource: dataset.path });
      return record && result.status === "ok" ? this.recordExperiment(result, { notes }) : result;
    }
    const candles = await this.getCandles(symbol, interval);
    const result = await this.run({ symbol, interval, candles, options, strategy: resolved, executionMode });
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
  async compare({
    symbol,
    interval = "4h",
    strategies = [DEFAULT_STRATEGY_ID],
    options = {},
    executionMode = "shared",
    // Rows below this many closed trades are reported but NOT ranked. The
    // default of 1 only excludes strategies that never traded; a real
    // statistical threshold is a promotion-policy decision and belongs with
    // the rest of that policy, which does not exist yet.
    minRankedTrades = 1,
  } = {}) {
    assertValidExecutionMode(executionMode);
    const ids = (Array.isArray(strategies) && strategies.length ? strategies : [DEFAULT_STRATEGY_ID]).map(
      (id) => getStrategy(id).id,
    );
    // Every strategy's options are validated before the single candle fetch,
    // so one bad parameter fails the comparison immediately rather than N-1
    // runs into it.
    ids.forEach((id) => assertValidOptions(getStrategy(id), options));
    const candleIds = ids.filter((id) => getStrategy(id).supportsBacktest !== false);
    const candles = candleIds.length ? await this.getCandles(symbol, interval) : null;

    const rows = [];
    for (const id of ids) {
      let result;
      if (id === BANANAGUN_STRATEGY_ID) {
        const dataset = loadEventDataset(this.dataDir, BANANAGUN_STRATEGY_ID);
        result = dataset.status === "available"
          ? replayBananaGunEvents({ events: dataset.events, dataSource: dataset.path })
          : replayBananaGunEvents({ events: [], dataSource: dataset.path });
      } else {
        result = await this.run({ symbol, interval, candles, options, strategy: id, executionMode });
      }
      // The curve rides ALONGSIDE the summary, not inside it: summarizeRun is
      // also what gets persisted as an experiment record, and a few thousand
      // equity points per stored experiment is a different decision from
      // drawing a chart. Keeping it out here leaves that record unchanged.
      rows.push({
        ...summarizeRun(result),
        equityCurve: downsampleCurve(result.equityCurve).map((p) => ({ at: p.at, equity: p.equity })),
        startingBalance: result.stats && result.stats.startingBalance != null ? result.stats.startingBalance : null,
      });
    }

    return {
      symbol,
      interval,
      executionMode,
      minRankedTrades,
      ranAt: new Date().toISOString(),
      results: rankRows(rows, minRankedTrades),
    };
  }
}

module.exports = {
  BacktestService,
  downsampleCurve,
  rankRows,
  EXECUTION_MODES,
  summarizeRun,
  resolveStrategy,
  trendBreakoutStrategy,
  contextAtBar,
  stateFromContext,
  MIN_WARMUP_BARS,
};
