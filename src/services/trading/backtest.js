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

const { getTradingConfig } = require("./config");
const { runChecklist, marketState } = require("./checklist");
const { assessEdge } = require("./edge-gate");
const { planTrade, calculatePositionSize } = require("./risk");
const { buildStrategyMetrics } = require("./metrics");
const { PaperTradingService, MemoryStorage } = require("./paper-trader");
const { replayOrder } = require("./replay-order");
// No `atr` import: this module computes ATR as a prefix-consistent SERIES (see
// atrSeries below) rather than calling decision-engine's per-prefix atr() once
// per bar. The two agree bar for bar, and a test asserts exactly that against
// the original — which is where the import still belongs.
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

/**
 * What execution a run ACTUALLY ran on, as opposed to what it was asked for.
 *
 * These come apart, silently, in exactly the case a reader is least equipped to
 * notice: a comparison requested with executionMode=native, where one row is a
 * strategy that publishes no stop or target hints at all. mindset_v1 is that
 * strategy today. Its trades fall back to planTrade's shared levels one by one,
 * the run completes, and the row sits under a header saying "native strategy
 * exits" describing a shared-execution run. Every number in it is correct and
 * the sentence above it is not.
 *
 *   "shared"           the run asked for shared execution and got it
 *   "native"           asked for native, every trade used the strategy's levels
 *   "shared-fallback"  asked for native, NO trade could use them
 *   "mixed"            asked for native, some trades could and some could not
 *   "none"             no trade opened, so there is nothing to characterise
 */
function appliedExecution({ executionMode, nativeTrades = 0, sharedTrades = 0 }) {
  const opened = nativeTrades + sharedTrades;
  if (!opened) return "none";
  if (executionMode !== "native") return "shared";
  if (nativeTrades && sharedTrades) return "mixed";
  return nativeTrades ? "native" : "shared-fallback";
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

// Wilder ATR as a SERIES: `out[i]` is exactly what `atr(bars.slice(0, i + 1),
// length)` returns, to the last bit.
//
// That equality is the only reason this is safe. Wilder smoothing is a
// recurrence over true ranges — each value depends on the one before it and on
// nothing after — so the value at bar i is identical whether it was reached by
// walking forward once across the whole array or by re-walking a prefix that
// ends at i. Recomputing the prefix was O(n) work per bar; this is O(n) once.
// No future bar enters any out[i], which is what makes the optimisation a
// change of cost and not a change of results.
function atrSeries(bars, length = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < length + 1) return out;

  // trs[j] is the true range of bar j + 1, matching atr()'s own indexing.
  const trs = new Array(bars.length - 1);
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].close;
    trs[i - 1] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
  }

  // Seeded with the simple mean of the first `length` true ranges, summed in
  // the same order as atr() sums them so the floating-point result matches.
  let value = 0;
  for (let i = 0; i < length; i += 1) value += trs[i];
  value /= length;
  out[length] = value;

  for (let i = length; i < trs.length; i += 1) {
    value = (value * (length - 1) + trs[i]) / length;
    out[i + 1] = value;
  }
  return out;
}

/**
 * Every indicator series a run needs, computed once over the whole candle set.
 *
 * EMA, MACD and ATR are all recurrences seeded from a fixed-length prefix, so
 * series[i] depends only on bars 0..i. Computing them once forward and reading
 * index i is therefore identical to recomputing them from bars.slice(0, i + 1),
 * which is what this module used to do on every single bar — and what made a
 * 2000-bar run quadratic in the number of bars.
 *
 * The lookahead barrier has NOT moved. It is still "index i may read series
 * index i and no higher", and the regression test that feeds two candle sets
 * with different futures and identical pasts still asserts the same context.
 */
function buildContextSeries(bars, config) {
  const closes = bars.map((b) => b.close);
  const { macdLine, signalLine } = macd(closes, config.macdFast, config.macdSlow, config.macdSignal);
  return {
    closes,
    emaFast: ema(closes, config.trendFast),
    emaSlow: ema(closes, config.trendSlow),
    macdLine,
    signalLine,
    atr: atrSeries(bars, 14),
  };
}

/**
 * Market context as of the close of `bars[index]`, computed from that bar and
 * everything before it. Nothing later is in scope — this function is the
 * lookahead barrier.
 *
 * `series` is the precomputed output of buildContextSeries over the SAME bars
 * array; omit it and one is built for the bars given, which is what a caller
 * holding only a prefix wants.
 */
function contextAtBar(bars, config, { index = bars.length - 1, series = null } = {}) {
  const s = series || buildContextSeries(bars, config);
  const len = index + 1;
  const close = s.closes[index];

  const atrValue = s.atr[index];
  // ATR relative to its own recent average, which is what the checklist's
  // volatility rules are expressed in.
  const atrHistory = [];
  for (let i = Math.max(15, len - 20); i < len; i += 1) {
    const value = s.atr[i];
    if (value != null) atrHistory.push(value);
  }
  const atrRatio = atrValue && atrHistory.length ? atrValue / mean(atrHistory) : 1;

  // Summed over the window directly rather than differenced out of a running
  // total: a prefix-sum difference is the same number in exact arithmetic and
  // not always the same float, and this feeds threshold comparisons.
  let volumeSum = 0;
  let volumeCount = 0;
  for (let i = Math.max(0, len - 20); i < len; i += 1) {
    volumeSum += bars[i].volume;
    volumeCount += 1;
  }
  const volumeAvg = volumeCount ? volumeSum / volumeCount : 0;
  const volumeRatio = volumeAvg > 0 ? bars[index].volume / volumeAvg : 1;

  const macdValue = s.macdLine[index];
  const macdSignalValue = s.signalLine[index];
  const macdBullish =
    macdValue != null && macdSignalValue != null ? macdValue > macdSignalValue : null;

  const fast = s.emaFast[index];
  const slow = s.emaSlow[index];

  return {
    bar: bars[index],
    close,
    atr: atrValue,
    atrRatio,
    volumeRatio,
    macdBullish,
    emaFast: fast,
    emaSlow: slow,
    // The trend of THE TIMEFRAME BEING TESTED, and named as such.
    //
    // This used to be called `trendUp`, and downstream that name did real
    // damage: smc_v1 read it as higher-timeframe context and paid a confidence
    // bonus for it, and the checklist scored it as "HTF: Daily bias" for up to
    // 30 of the 100 points that decide SKIP / QUARTER / HALF / FULL. It is
    // neither. It is an EMA cross on the same candles the strategy is already
    // looking at, and calling it higher-timeframe confirmation is a strategy
    // being paid for agreeing with itself.
    timeframeTrendUp: fast != null && slow != null ? fast > slow : null,
    // Genuine higher-timeframe context. A candle backtest has one timeframe of
    // data and therefore does not have this, so it is null and the things that
    // depend on it fall back explicitly rather than being fed a substitute. A
    // caller that really does have a daily read sets it.
    htfTrendUp: null,
  };
}

// Default strategy: trade in the direction of the moving-average trend when
// price closes beyond the prior `breakoutLookback` bars' extreme. Deliberately
// plain — the interesting machinery is the gauntlet every candidate then runs,
// not this rule. Pass your own `strategy` to replace it.
function trendBreakoutStrategy({ bars, context, options }) {
  const lookback = options.breakoutLookback;
  // Same-timeframe trend, explicitly — this rule has never had, and does not
  // claim, a higher-timeframe view.
  const trendUp = context.timeframeTrendUp;
  if (bars.length < lookback + 2 || trendUp === null || trendUp === undefined) return null;

  // The window excludes the current bar: breaking a range you are part of is
  // not a breakout.
  const prior = bars.slice(-(lookback + 1), -1);
  const priorHigh = Math.max(...prior.map((b) => b.high));
  const priorLow = Math.min(...prior.map((b) => b.low));

  if (trendUp && context.close > priorHigh) return "LONG";
  if (!trendUp && context.close < priorLow) return "SHORT";
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
      evaluate: ({ bars, index, context, options, symbol }) => {
        // The legacy convention takes bars ALREADY truncated at the decided
        // bar, so this one is sliced for it. Registry strategies take the full
        // array plus an index and do their own slicing.
        const direction = strategy({ bars: bars.slice(0, index + 1), context, options, symbol });
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
    evaluate: ({ bars, index, context, options, symbol }) =>
      definition.evaluate(bars, index, {
        options,
        symbol,
        // Two separate facts under two separate names. `htfTrendUp` is null in
        // a candle backtest because there is no higher-timeframe feed here;
        // handing a strategy the tested timeframe's own trend under that name
        // is how smc_v1 came to award itself a higher-timeframe confidence
        // bonus for reading the chart it was already reading.
        htfTrendUp: context.htfTrendUp,
        timeframeTrendUp: context.timeframeTrendUp,
        close: context.close,
        atr: context.atr,
      }),
  };
}

/**
 * The market state the checklist scores.
 *
 * `regime` is the tested timeframe's own trend, which is what it has always
 * been and what the regime gate is written against — a 4h strategy refusing 4h
 * counter-trend entries is a coherent rule.
 *
 * `dailyBias` is NOT. It is the checklist's higher-timeframe block, worth 30 of
 * 100 points and scored under the label "HTF: Daily bias", and it used to be
 * filled in from the same EMA cross as `regime` — the tested timeframe wearing
 * a daily hat. On a 4h backtest that meant every with-trend candidate collected
 * the full higher-timeframe credit for information it already had, which is
 * enough on its own to move a setup from SKIP (under 50) to TAKE_QUARTER, or
 * from HALF to FULL.
 *
 * A candle backtest has one timeframe of data, so the honest value is NEUTRAL
 * unless a caller supplies a real `htfTrendUp`. NEUTRAL scores +15 rather than
 * +30 or +0: the checklist already has a defined "no opinion" branch, and using
 * it is the difference between "we don't know the daily trend" and a fabricated
 * answer. Supplying genuine higher-timeframe data restores the full-credit
 * path, which is the case the 30 points were designed for.
 */
function stateFromContext(context, marketContext = null) {
  const mc = marketContext || {};
  // A caller-supplied higher-timeframe read wins over the context's own (which
  // is null for a candle backtest, by design).
  const htf = mc.htfTrendUp !== undefined ? mc.htfTrendUp : context.htfTrendUp;
  // Only fields the caller ACTUALLY SUPPLIED are passed through. Anything
  // omitted stays unset, and the checklist scores it as unmeasured rather than
  // as a favourable observation.
  const supplied = {};
  for (const key of ["usdtDominanceSignal", "btcDominanceRising", "bearMarket", "fundingRate"]) {
    if (mc[key] !== undefined) supplied[key] = mc[key];
  }
  return marketState({
    regime:
      context.timeframeTrendUp === null ? "RANGE" : context.timeframeTrendUp ? "TREND_UP" : "TREND_DOWN",
    dailyBias: htf === null || htf === undefined ? "NEUTRAL" : htf ? "BULLISH" : "BEARISH",
    ...supplied,
    macdBullish: context.macdBullish,
    atrRatio: context.atrRatio,
    volumeRatio: context.volumeRatio,
    // No macro, funding or calendar feed exists for a historical bar, so
    // those are left UNSET and the checklist scores them as unmeasured. That
    // costs a candidate the macro block's 20 points and the funding block's 5,
    // which is the honest outcome: absent evidence is not evidence.
    //
    // It used to cost a LONG nothing at all. The old defaults — dominance
    // "NEUTRAL", btcDominanceRising false, bearMarket false, fundingRate 0 —
    // read as favourable observations for a long and unfavourable ones for a
    // short, so a candle backtest handed every long +25 and every short +5 for
    // data neither of them had, and put the two 20 points apart. A backtest
    // that systematically prefers one direction because of what it does NOT
    // know cannot be used to judge a strategy.
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
    // Market context the CALLER has and the candles do not: a higher-timeframe
    // trend read, macro dominance, bear-market state, funding. Omitted fields
    // stay unmeasured and score nothing, which is the honest default for a
    // plain candle replay.
    //
    // This is not a knob for making a backtest trade more. It is the only way
    // a run can be given evidence it genuinely has — a daily feed, a funding
    // history — instead of the checklist inventing it. Whatever is supplied is
    // recorded on the result, so a run that scored with macro context is never
    // mistaken for one that did not.
    marketContext = null,
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

    // A throwaway in-memory ledger. A backtest must never touch the live
    // books, and it must not inherit their history either — the edge gate has
    // to see only the trades this run produced.
    //
    // In memory rather than in a temp directory, and that is a storage choice
    // only: this is still the production PaperTradingService, running the same
    // fills, the same scale-outs and the same accounting the live books run.
    // The ledger is read and rewritten several times per bar, so on disk a
    // 2000-bar run spent most of its time in readFileSync and rename.
    //
    // The clock is set per bar below. Every accounting call also passes its own
    // `at`; the clock is the backstop that keeps a call site nobody remembered
    // from rolling this historical book over onto today's date.
    const trader = new PaperTradingService({
      book: "backtest",
      config: this.config,
      storage: new MemoryStorage(),
      clock: bars[0].closeTime,
    });

    // Indicators for the whole run, computed once. See buildContextSeries:
    // each series is a forward recurrence, so reading index i is identical to
    // recomputing that indicator from bars 0..i, which is what this loop used
    // to do on every bar.
    const series = buildContextSeries(bars, opts);

    const equityCurve = [];
    const skipped = [];
    const signals = [];
    let mixedDirectionBars = 0;
    // Trades that asked for native execution and could not get it, because the
    // strategy published no usable levels. Counted so the result can say so
    // rather than presenting a shared-execution run as a native one.
    let nativeFallbacks = 0;
    // Opened trades by the execution actually applied to them, which is what
    // `executionApplied` below is derived from. The requested mode and the
    // applied one are different facts and a reader needs both.
    let nativeTrades = 0;
    let sharedTrades = 0;

    for (let i = warmup; i < bars.length; i += 1) {
      const bar = bars[i];
      // Simulated now, for the whole of this bar's processing.
      trader.setClock(bar.closeTime);

      // 1. Replay this bar against open positions BEFORE considering a new
      // entry, so a position opened last bar gets its stop and targets
      // tested on this one.
      const ordering = replayOrder(trader, bar);
      if (ordering.mixed) mixedDirectionBars += 1;
      for (const price of ordering.prices) {
        await trader.updatePositions({ [symbol]: price }, { at: bar.closeTime });
      }

      // 2. Ask the strategy about the bar that just closed. `bars` is the full
      // array and `i` is the barrier: a registry strategy slices to `index`
      // itself, and the no-lookahead regression tests hold it to that.
      const context = contextAtBar(bars, opts, { index: i, series });
      const signal = resolved.evaluate({ bars, index: i, context, options: opts, symbol });
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
          at: bar.closeTime,
          marketContext,
        });
        if (outcome.opened) {
          if (outcome.appliedMode === "native") nativeTrades += 1;
          else sharedTrades += 1;
          if (executionMode === "native" && outcome.appliedMode !== "native") nativeFallbacks += 1;
        } else {
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

      const account = trader.getAccount({ at: bar.closeTime });
      const open = trader.getOpenPositions();
      const unrealized = open.reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0);
      equityCurve.push({
        at: bar.closeTime,
        close: bar.close,
        balance: account.balance,
        equity: Math.round((account.balance + unrealized) * 100) / 100,
        openPositions: open.length,
      });
    }

    // Any position still open at the end is marked at the final close but
    // left open — force-closing it would invent an exit the strategy never
    // signalled, and counting it as a closed trade would pollute expectancy.
    const finalAt = bars[bars.length - 1].closeTime;
    const openAtEnd = trader.getOpenPositions();
    const stats = await trader.getStats({ at: finalAt });
    const account = trader.getAccount({ at: finalAt });
    const executionApplied = appliedExecution({ executionMode, nativeTrades, sharedTrades });

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
      // What was ASKED FOR.
      executionMode,
      // What was actually APPLIED, which is not the same question — see
      // appliedExecution(). A run requested as native whose strategy publishes
      // no levels is a shared run, and the row has to say so.
      executionApplied,
      nativeTrades,
      sharedTrades,
      nativeFallbacks,
      // Which context fields the caller actually supplied, so a run scored with
      // a real daily or funding feed is never confused with a candles-only one.
      // Empty means candles only, which is the default.
      marketContextFields: Object.keys(marketContext || {}).sort(),
      caveats: [
        // Surfaced rather than hidden: with long and short positions open on
        // the same symbol at once, one intra-bar ordering cannot be
        // pessimistic for both sides.
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
    // The replayed instant this candidate is being evaluated at. It decides
    // which day's and which week's loss buckets the kill switches below read,
    // so a historical candidate is tested against historical risk state.
    at = null,
    // Caller-supplied market context — see run(). Null means "candles only".
    marketContext = null,
  }) {
    const signalSource = `backtest:${strategyId}:${interval}`;
    const state = marketState({
      ...stateFromContext(context, marketContext),
      ...trader.getRiskState({ at }),
    });
    const checklist = runChecklist(
      { symbol, direction, price: context.close, atr: context.atr, allowCounterTrend },
      state,
      this.config,
    );

    const account = trader.getAccount({ at });
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
        openedAt: at ?? context.bar.closeTime,
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
    // See run(). Omitted means candles only.
    marketContext = null,
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
    const result = await this.run({
      symbol,
      interval,
      candles,
      options,
      strategy: resolved,
      executionMode,
      marketContext,
    });
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
    // Applied identically to every strategy in the comparison — a row scored
    // with macro context beside one scored without it would not be a
    // comparison.
    marketContext = null,
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
        result = await this.run({
          symbol,
          interval,
          candles,
          options,
          strategy: id,
          executionMode,
          marketContext,
        });
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
      marketContextFields: Object.keys(marketContext || {}).sort(),
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
  appliedExecution,
  summarizeRun,
  resolveStrategy,
  trendBreakoutStrategy,
  contextAtBar,
  buildContextSeries,
  atrSeries,
  stateFromContext,
  MIN_WARMUP_BARS,
};
