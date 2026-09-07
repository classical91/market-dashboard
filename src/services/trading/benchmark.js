"use strict";

// The buy-and-hold benchmark a backtest is read against.
//
// A strategy that returned +18% has told you almost nothing until you know
// what the symbol itself did over the same window. Most of the runs in this
// Lab are on crypto majors over multi-month windows, where simply holding is a
// strong and entirely passive competitor — so the equity chart draws both, and
// the panel reports both. A strategy that underperforms the asset it trades is
// a real result, and hiding it behind a green number is the specific
// misreading this module exists to prevent.
//
// Three properties make the comparison honest, and each is enforced here
// rather than assumed:
//
//   Same data. The curve is built from the SAME candle array the replay
//   consumed, starting at the SAME warmup barrier. It cannot be computed from
//   a second fetch, a different interval, or the unwarmed head of the series,
//   because it is handed the array the replay used.
//
//   Same capital and same friction. Entry is priced through the same slippage
//   and taker-fee assumptions the PaperTradingService charged the strategy
//   (see paper-trader.js `slippageAdjustedPrice`, `executionFee`,
//   `fundingCost`), from the same starting balance. A frictionless benchmark
//   beside a fee-charged strategy is not a comparison, it is a handicap.
//
//   Same measurement. Drawdown for BOTH lines is measured by the one
//   `maxDrawdownPct` below, off each side's mark-to-market equity curve. The
//   closed-trade drawdown in metrics.js answers a different question and has
//   no benchmark equivalent at all — a buy-and-hold position never closes.
//
// What this deliberately does NOT do is charge an exit. The position is held
// to the last bar and marked to market there, exactly as the replay treats a
// strategy position still open at the end: neither side pays for an exit it
// never took.

const { round } = require("./round");

// Long-only, and stated rather than parameterised: "buy and hold" means one
// thing. A short benchmark would be a different question with a different name.
const BENCHMARK_DIRECTION = "LONG";
const MS_PER_FUNDING_PERIOD = 8 * 60 * 60 * 1000;

// Number(null) and Number("") are both 0, so a bare Number.isFinite() check
// reads a missing equity point as a fall to zero — and one null in a curve
// would be reported as a 100% drawdown. Absent is absent.
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Candle timestamps are epoch milliseconds off the exchange (see
// signal-screener.js), not ISO strings, so Date.parse() would return NaN for
// every real bar. `new Date(value)` accepts both, matching paper-trader.js —
// but an unreadable timestamp yields null here rather than falling back to
// now, because "now" would charge funding for the wall-clock age of the data.
function msFrom(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Peak-to-trough drawdown of an equity curve, as a positive percentage.
 *
 * Curve-based on purpose, and shared by both lines in the panel. The
 * closed-trade drawdown in metrics.js walks realised P&L trade by trade, which
 * is the right measure for expectancy work and the wrong one here: it cannot
 * see an open position's paper loss, so it would report 0% for a buy-and-hold
 * curve that halved on the way. Two numbers computed different ways, printed
 * side by side under one heading, is not a comparison.
 *
 * Peaks below or at zero are skipped rather than divided into: a wiped-out
 * account has no meaningful percentage left to fall.
 */
function maxDrawdownPct(curve, valueOf = (point) => point.equity) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of curve || []) {
    const value = finite(valueOf(point));
    if (value === null) continue;
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.max(worst, ((peak - value) / peak) * 100);
  }
  return round(worst);
}

/**
 * A single unavailable-benchmark answer, in the shape callers already handle.
 *
 * Returning this rather than throwing is deliberate: a benchmark that cannot
 * be computed must not fail a backtest whose own numbers are fine. The panel
 * draws the strategy line alone and says why the second line is missing, which
 * is honest; a silent flat line at the starting balance would read as "holding
 * went nowhere" and would be a fabrication.
 */
function unavailable(reason) {
  return {
    available: false,
    reason,
    curve: [],
    startingBalance: null,
    entryPrice: null,
    exitPrice: null,
    units: 0,
    costs: null,
    netPnlUsd: 0,
    returnPct: 0,
    maxDrawdownPct: 0,
  };
}

/**
 * Buy-and-hold equity for the window a backtest actually replayed.
 *
 * @param {object[]} bars       The candle array the replay consumed.
 * @param {number}   warmup     The replay's warmup barrier — the benchmark
 *                              enters on bars[warmup], the first bar the
 *                              strategy could itself have traded.
 * @param {number}   startingBalance  The replay account's starting capital.
 * @param {object}   costs      { takerFeeRate, slippageRate, fundingRate8h },
 *                              i.e. run-summary.js `costSummary(config)` —
 *                              the very rates the strategy was charged.
 *
 * The returned curve has exactly one point per replayed bar, at the same
 * `closeTime` the strategy's own equity curve uses, so the two zip index for
 * index with no interpolation and no date matching.
 */
function buildBuyAndHold({ bars, warmup = 0, startingBalance, costs = {} } = {}) {
  if (!Array.isArray(bars) || !bars.length) return unavailable("no candles were replayed");

  const start = Math.max(0, Math.trunc(Number(warmup) || 0));
  if (start >= bars.length) return unavailable("every candle was consumed by warmup");

  const capital = finite(startingBalance);
  if (capital === null || capital <= 0) return unavailable("the run has no starting balance to invest");

  const entryBar = bars[start];
  const entryClose = finite(entryBar && entryBar.close);
  if (entryClose === null || entryClose <= 0) {
    return unavailable("the first replayed candle has no usable close price");
  }

  const takerFeeRate = Math.max(0, finite(costs.takerFeeRate) || 0);
  const slippageRate = Math.max(0, finite(costs.slippageRate) || 0);
  const fundingRate8h = finite(costs.fundingRate8h) || 0;

  // Buying, so slippage moves the fill against us — the same direction and the
  // same rate paper-trader.js applies to a LONG entry.
  const entryPrice = round(entryClose * (1 + slippageRate), 10);

  // The whole starting balance is committed, fee included: notional + fee =
  // capital exactly. Sizing the notional at the full balance and then charging
  // the fee on top would spend more than the account has, and would hand the
  // benchmark a slightly larger position than the capital it was given. The
  // fee is rounded to cents like every other figure in the Lab, and the
  // notional is then whatever is left — deriving both from the unrounded
  // division instead would leave the two a fraction of a cent apart.
  const entryFee = round((capital / (1 + takerFeeRate)) * takerFeeRate);
  const notional = capital - entryFee;
  const units = notional / entryPrice;

  const entryAt = entryBar.closeTime;
  const entryMs = msFrom(entryAt);

  // Funding is charged over elapsed time exactly as paper-trader.js does, and
  // subtracted from P&L for a LONG. Every named cost scenario sets it to zero
  // and no funding feed is wired up, so this is normally a no-op — but a
  // deployment running its own BACKTEST_FUNDING_RATE_8H must charge the
  // benchmark the same rate it charges the strategy, or the comparison tilts.
  function fundingCostAt(at) {
    if (!fundingRate8h) return 0;
    const nowMs = msFrom(at);
    if (entryMs === null || nowMs === null) return 0;
    const periods = Math.max(0, nowMs - entryMs) / MS_PER_FUNDING_PERIOD;
    const cost = Math.abs(entryPrice * units) * fundingRate8h * periods;
    return round(BENCHMARK_DIRECTION === "LONG" ? cost : -cost);
  }

  const curve = [];
  let lastClose = entryClose;
  for (let i = start; i < bars.length; i += 1) {
    const bar = bars[i];
    const close = finite(bar && bar.close);
    // A malformed candle mid-series holds the last known mark rather than
    // dropping a point: a gap in this curve would misalign it against the
    // strategy's, and the two are read by index.
    if (close !== null && close > 0) lastClose = close;
    const funding = fundingCostAt(bar && bar.closeTime);
    curve.push({
      at: bar && bar.closeTime,
      close: lastClose,
      equity: round(units * lastClose - entryFee - funding),
    });
  }

  const endEquity = curve[curve.length - 1].equity;
  const netPnl = endEquity - capital;

  return {
    available: true,
    reason: null,
    // Long-only and priced at the close of the first replayed bar — the same
    // instant and the same price basis a strategy entry fills at.
    method: "buy-and-hold",
    direction: BENCHMARK_DIRECTION,
    startingBalance: round(capital),
    entryAt,
    entryPrice: round(entryPrice, 10),
    exitPrice: round(lastClose, 10),
    units,
    // Echoed rather than assumed: the panel says which friction priced this
    // line, and a reader can check it is the same set the strategy paid.
    costs: { takerFeeRate, slippageRate, fundingRate8h },
    entryFee,
    curve,
    netPnlUsd: round(netPnl),
    returnPct: round((netPnl / capital) * 100),
    maxDrawdownPct: maxDrawdownPct(curve),
  };
}

/**
 * The strategy's own side of the panel, measured the way the benchmark is.
 *
 * Every figure here is mark-to-market off the replay's equity curve, so the
 * two columns of the panel answer the same question. That is NOT the same as
 * the closed-trade figures in metrics.js, and the difference is real whenever
 * a position is still open at the end — which is why `openAtEnd` is passed in
 * and reported, so the panel can say so rather than leaving two net P&L
 * numbers on one page silently disagreeing.
 *
 * Trade-count facts (total trades, win rate, profit factor) are read from the
 * stats the replay already produced rather than recomputed. There is only one
 * definition of a win in this codebase and this is not the place to invent a
 * second.
 */
function summarizeStrategyPerformance({ equityCurve, startingBalance, stats = {}, openAtEnd = 0 } = {}) {
  const curve = Array.isArray(equityCurve) ? equityCurve : [];
  const capital = finite(startingBalance);
  const endEquity = curve.length ? finite(curve[curve.length - 1].equity) : capital;
  const netPnl = capital === null || endEquity === null ? 0 : endEquity - capital;
  const riskMetrics = stats.riskMetrics || {};

  return {
    startingBalance: capital === null ? null : round(capital),
    endEquity: endEquity === null ? null : round(endEquity),
    netPnlUsd: round(netPnl),
    returnPct: capital ? round((netPnl / capital) * 100) : 0,
    maxDrawdownPct: maxDrawdownPct(curve),
    // Closed trades only — an open position has not won or lost yet.
    totalTrades: Number(stats.totalTrades) || 0,
    winRate: Number(stats.winRate) || 0,
    // null means "wins, no losses" all the way from metrics.js. It is NOT
    // infinity dressed down, and the panel prints it as ∞ only when there are
    // trades to justify it.
    profitFactor: riskMetrics.profitFactor === undefined ? null : riskMetrics.profitFactor,
    openAtEnd: Number(openAtEnd) || 0,
  };
}

/**
 * The finished panel payload: two comparable columns and one aligned series.
 *
 * The series is emitted here, once, rather than left to the browser to zip.
 * Alignment is the property the whole panel rests on — a benchmark point drawn
 * against the wrong bar is a chart that lies quietly — and it is guaranteed by
 * construction here (both sides walk bars[warmup..] in step) where a test can
 * hold it, instead of by two independent loops in two languages.
 */
function buildPerformancePanel({
  equityCurve,
  bars,
  warmup = 0,
  startingBalance,
  stats = {},
  openAtEnd = 0,
  costs = {},
} = {}) {
  const strategy = summarizeStrategyPerformance({ equityCurve, startingBalance, stats, openAtEnd });
  const benchmark = buildBuyAndHold({ bars, warmup, startingBalance, costs });
  const curve = Array.isArray(equityCurve) ? equityCurve : [];

  // Zipped by index, which is sound only because both curves are one point per
  // replayed bar from the same barrier. If a future change ever breaks that,
  // the mismatched tail is dropped rather than paired against the wrong bar,
  // and `alignedPoints` below says how much survived.
  const length = benchmark.available ? Math.min(curve.length, benchmark.curve.length) : curve.length;
  const series = [];
  for (let i = 0; i < length; i += 1) {
    const point = curve[i];
    const mark = benchmark.available ? benchmark.curve[i] : null;
    series.push({
      at: point.at,
      strategy: finite(point.equity),
      benchmark: mark ? finite(mark.equity) : null,
    });
  }

  return {
    startingBalance: strategy.startingBalance,
    strategy,
    benchmark,
    series,
    alignedPoints: series.length,
    // A benchmark shorter or longer than the replay is a bug, not a display
    // quirk. Surfaced so the panel can warn instead of drawing a truncated
    // second line as though it were the whole window.
    aligned: !benchmark.available || benchmark.curve.length === curve.length,
  };
}

module.exports = {
  buildBuyAndHold,
  buildPerformancePanel,
  summarizeStrategyPerformance,
  maxDrawdownPct,
};
