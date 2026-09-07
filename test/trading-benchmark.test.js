"use strict";

// The buy-and-hold benchmark and the performance panel it feeds.
//
// The panel's entire claim is that its two lines are comparable, so these
// tests are mostly about sameness: same bars, same window, same capital, same
// friction, same drawdown definition. A benchmark computed a little
// differently from the strategy beside it is worse than no benchmark at all,
// because it looks like evidence.

const test = require("node:test");
const assert = require("node:assert");

const {
  buildBuyAndHold,
  buildPerformancePanel,
  summarizeStrategyPerformance,
  maxDrawdownPct,
} = require("../src/services/trading/benchmark");

const FREE = { takerFeeRate: 0, slippageRate: 0, fundingRate8h: 0 };
const BASELINE = { takerFeeRate: 0.0006, slippageRate: 0.0002, fundingRate8h: 0 };

// Bars 4h apart so closeTime is monotonic and funding periods are countable.
function candles(closes, startMs = 0) {
  return closes.map((close, i) => ({
    openTime: startMs + i * 14400000,
    closeTime: startMs + (i + 1) * 14400000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

/* ── Drawdown ───────────────────────────────────────────────────────────── */

test("max drawdown is the deepest peak-to-trough fall, not the last one", () => {
  // Peak 200 → trough 100 is 50%; the later 150 → 120 is only 20%. The worst
  // one is the one that would have ended the account.
  const curve = [100, 200, 100, 150, 120].map((equity) => ({ equity }));
  assert.strictEqual(maxDrawdownPct(curve), 50);
});

test("a curve that only rises has no drawdown", () => {
  assert.strictEqual(maxDrawdownPct([100, 110, 120].map((equity) => ({ equity }))), 0);
});

test("drawdown of an empty or single-point curve is zero rather than NaN", () => {
  assert.strictEqual(maxDrawdownPct([]), 0);
  assert.strictEqual(maxDrawdownPct(null), 0);
  assert.strictEqual(maxDrawdownPct([{ equity: 100 }]), 0);
});

test("non-finite equity points are skipped, not treated as a fall to zero", () => {
  // A malformed point must not manufacture a 100% drawdown out of nothing.
  const curve = [{ equity: 100 }, { equity: null }, { equity: "oops" }, { equity: 90 }];
  assert.strictEqual(maxDrawdownPct(curve), 10);
});

test("a peak at or below zero yields no percentage rather than an infinite one", () => {
  // There is no meaningful percentage left to fall from a wiped-out account,
  // and dividing by the peak anyway would report Infinity or a negative.
  const worst = maxDrawdownPct([{ equity: -50 }, { equity: -200 }]);
  assert.ok(Number.isFinite(worst), `expected a finite drawdown, got ${worst}`);
  assert.strictEqual(worst, 0);
});

/* ── Buy and hold ───────────────────────────────────────────────────────── */

test("a frictionless hold returns exactly the symbol's move", () => {
  // 100 → 150 is +50%, and with no fees the account tracks it one for one.
  const result = buildBuyAndHold({
    bars: candles([100, 120, 150]),
    warmup: 0,
    startingBalance: 10000,
    costs: FREE,
  });

  assert.strictEqual(result.available, true);
  assert.strictEqual(result.returnPct, 50);
  assert.strictEqual(result.netPnlUsd, 5000);
  assert.strictEqual(result.curve[0].equity, 10000);
  assert.strictEqual(result.curve[result.curve.length - 1].equity, 15000);
});

test("the benchmark enters at the warmup barrier, not at the head of the series", () => {
  // The strategy could not trade the warmup bars, so neither may the thing it
  // is being compared against. Entry is bars[warmup]'s close of 200; the run
  // ends at 220, which is +10% — NOT the +120% the unwarmed series shows.
  const result = buildBuyAndHold({
    bars: candles([100, 150, 200, 210, 220]),
    warmup: 2,
    startingBalance: 1000,
    costs: FREE,
  });

  assert.strictEqual(result.entryPrice, 200);
  assert.strictEqual(result.returnPct, 10);
  assert.strictEqual(result.curve.length, 3);
});

test("entry pays the same slippage and taker fee the strategy pays", () => {
  const capital = 10000;
  const result = buildBuyAndHold({
    bars: candles([100, 100]),
    warmup: 0,
    startingBalance: capital,
    costs: BASELINE,
  });

  // Buying, so slippage moves the fill up — the same direction paper-trader.js
  // applies to a LONG entry.
  assert.strictEqual(result.entryPrice, 100 * (1 + BASELINE.slippageRate));
  // Notional plus fee spends the capital exactly: sizing at the full balance
  // and charging the fee on top would buy more than the account can afford.
  assert.ok(
    Math.abs(result.units * result.entryPrice + result.entryFee - capital) < 1e-6,
    "notional + entry fee should equal the starting capital",
  );
  // Flat price, so the whole loss is friction — and it is a loss, not a wash.
  assert.ok(result.netPnlUsd < 0, `expected a friction loss, got ${result.netPnlUsd}`);
  assert.ok(result.netPnlUsd > -50, `friction of ${result.netPnlUsd} is far larger than the rates imply`);
});

test("no exit is charged: the position is marked to market like an open one", () => {
  // The replay leaves a strategy position open at the end rather than
  // inventing an exit for it. Charging the benchmark an exit fee the strategy
  // never paid would hand the strategy a free advantage on every run.
  const withFees = buildBuyAndHold({
    bars: candles([100, 200]),
    warmup: 0,
    startingBalance: 10000,
    costs: BASELINE,
  });
  const gross = withFees.units * 200;
  assert.ok(
    Math.abs(withFees.curve[1].equity - (gross - withFees.entryFee)) < 0.01,
    "the final mark should carry the entry fee only",
  );
});

test("funding is charged over elapsed time when a deployment configures it", () => {
  // Three 4h bars from entry is 12h, or 1.5 funding periods. The rate is
  // deliberately large so the effect is unmistakable.
  const funded = buildBuyAndHold({
    bars: candles([100, 100, 100, 100]),
    warmup: 0,
    startingBalance: 10000,
    costs: { takerFeeRate: 0, slippageRate: 0, fundingRate8h: 0.01 },
  });

  assert.strictEqual(funded.curve[0].equity, 10000, "no funding has accrued at entry");
  // 10000 notional × 1% × 1.5 periods = 150, paid by the long.
  assert.ok(Math.abs(funded.curve[3].equity - (10000 - 150)) < 0.01, `got ${funded.curve[3].equity}`);
});

test("drawdown on the benchmark is the asset's own drawdown", () => {
  // 100 → 200 → 50: the hold lost 75% from its peak, and a chart that did not
  // say so would make any strategy look reckless by comparison.
  const result = buildBuyAndHold({
    bars: candles([100, 200, 50, 120]),
    warmup: 0,
    startingBalance: 1000,
    costs: FREE,
  });
  assert.strictEqual(result.maxDrawdownPct, 75);
});

test("a malformed candle mid-series holds the last mark instead of dropping a point", () => {
  // Dropping the point would shorten the benchmark curve and misalign every
  // later bar against the strategy's.
  const bars = candles([100, 110, 120, 130]);
  bars[2].close = null;
  const result = buildBuyAndHold({ bars, warmup: 0, startingBalance: 1000, costs: FREE });

  assert.strictEqual(result.curve.length, 4);
  assert.strictEqual(result.curve[2].equity, result.curve[1].equity);
  assert.strictEqual(result.curve[3].equity, 1300);
});

/* ── Unavailable benchmarks ─────────────────────────────────────────────── */

test("an uncomputable benchmark says so instead of drawing a flat line", () => {
  // A flat line at the starting balance would read as "holding went nowhere",
  // which is a fabrication rather than a missing measurement.
  const cases = [
    [{ bars: [], warmup: 0, startingBalance: 1000, costs: FREE }, /no candles/i],
    [{ bars: candles([100, 110]), warmup: 5, startingBalance: 1000, costs: FREE }, /warmup/i],
    [{ bars: candles([100, 110]), warmup: 0, startingBalance: 0, costs: FREE }, /starting balance/i],
    [{ bars: candles([0, 110]), warmup: 0, startingBalance: 1000, costs: FREE }, /close price/i],
  ];

  for (const [input, reason] of cases) {
    const result = buildBuyAndHold(input);
    assert.strictEqual(result.available, false, JSON.stringify(input.warmup));
    assert.match(result.reason, reason);
    assert.deepStrictEqual(result.curve, []);
  }

  assert.strictEqual(buildBuyAndHold().available, false);
  assert.strictEqual(buildBuyAndHold({ bars: null }).available, false);
});

test("a negative fee rate cannot be used to hand the benchmark a rebate", () => {
  const result = buildBuyAndHold({
    bars: candles([100, 100]),
    warmup: 0,
    startingBalance: 1000,
    costs: { takerFeeRate: -0.5, slippageRate: -0.5, fundingRate8h: 0 },
  });
  assert.strictEqual(result.costs.takerFeeRate, 0);
  assert.strictEqual(result.costs.slippageRate, 0);
  assert.strictEqual(result.netPnlUsd, 0);
});

/* ── Strategy side ──────────────────────────────────────────────────────── */

test("the strategy column is marked to market, matching how the benchmark is measured", () => {
  const summary = summarizeStrategyPerformance({
    equityCurve: [{ equity: 10000 }, { equity: 12000 }, { equity: 11000 }],
    startingBalance: 10000,
    stats: { totalTrades: 4, winRate: 75, riskMetrics: { profitFactor: 2.5 } },
    openAtEnd: 1,
  });

  assert.strictEqual(summary.netPnlUsd, 1000);
  assert.strictEqual(summary.returnPct, 10);
  // 12000 → 11000 is the deepest fall, measured off the curve exactly as the
  // benchmark's is.
  assert.ok(Math.abs(summary.maxDrawdownPct - 8.33) < 0.01, `got ${summary.maxDrawdownPct}`);
  assert.strictEqual(summary.totalTrades, 4);
  assert.strictEqual(summary.winRate, 75);
  assert.strictEqual(summary.profitFactor, 2.5);
  assert.strictEqual(summary.openAtEnd, 1);
});

test("a null profit factor survives as null rather than becoming zero", () => {
  // metrics.js reports null for "wins, no losses". Collapsing it to 0 would
  // turn the best possible run into the worst-looking number on the panel.
  const summary = summarizeStrategyPerformance({
    equityCurve: [{ equity: 100 }, { equity: 120 }],
    startingBalance: 100,
    stats: { totalTrades: 2, winRate: 100, riskMetrics: { profitFactor: null } },
  });
  assert.strictEqual(summary.profitFactor, null);
});

test("a run that closed no trades reports a flat panel, not NaN", () => {
  const summary = summarizeStrategyPerformance({
    equityCurve: [{ equity: 10000 }, { equity: 10000 }],
    startingBalance: 10000,
    stats: {},
  });
  assert.strictEqual(summary.netPnlUsd, 0);
  assert.strictEqual(summary.returnPct, 0);
  assert.strictEqual(summary.maxDrawdownPct, 0);
  assert.strictEqual(summary.totalTrades, 0);
  assert.strictEqual(summary.profitFactor, null);
});

/* ── Alignment ──────────────────────────────────────────────────────────── */

test("the panel series pairs each strategy point with the benchmark for the SAME bar", () => {
  // This is the property the whole chart rests on. A benchmark drawn one bar
  // out is a chart that lies quietly, and no stat tile would reveal it.
  const bars = candles([10, 20, 30, 40, 50, 60]);
  const warmup = 2;
  const equityCurve = bars.slice(warmup).map((bar, i) => ({ at: bar.closeTime, equity: 1000 + i }));

  const panel = buildPerformancePanel({
    equityCurve,
    bars,
    warmup,
    startingBalance: 1000,
    stats: { totalTrades: 0, winRate: 0, riskMetrics: {} },
    costs: FREE,
  });

  assert.strictEqual(panel.aligned, true);
  assert.strictEqual(panel.series.length, equityCurve.length);
  panel.series.forEach((point, i) => {
    assert.strictEqual(point.at, equityCurve[i].at, `point ${i} is on the wrong bar`);
    assert.strictEqual(point.strategy, equityCurve[i].equity);
    assert.strictEqual(point.benchmark, panel.benchmark.curve[i].equity);
  });
  // ...and the benchmark's own bar timestamps agree with the strategy's.
  panel.benchmark.curve.forEach((point, i) => {
    assert.strictEqual(point.at, bars[warmup + i].closeTime);
  });
});

test("an unavailable benchmark leaves the strategy line whole and every benchmark value null", () => {
  const equityCurve = [1, 2, 3].map((i) => ({ at: `t${i}`, equity: 1000 * i }));
  const panel = buildPerformancePanel({
    equityCurve,
    bars: [],
    warmup: 0,
    startingBalance: 1000,
    stats: {},
    costs: FREE,
  });

  assert.strictEqual(panel.benchmark.available, false);
  assert.strictEqual(panel.series.length, 3);
  assert.ok(panel.series.every((p) => p.benchmark === null));
  // Not "aligned: false" — there is nothing to misalign, and warning about
  // alignment here would send a reader looking for a bug that is not there.
  assert.strictEqual(panel.aligned, true);
});

test("curves of different lengths are reported as misaligned rather than paired off", () => {
  // Should the two loops ever fall out of step, the tail is dropped and the
  // panel says so — it does not pair a strategy point against another bar's
  // benchmark and draw the result as though it were true.
  const bars = candles([10, 20, 30, 40]);
  const panel = buildPerformancePanel({
    equityCurve: [{ at: bars[0].closeTime, equity: 1000 }, { at: bars[1].closeTime, equity: 1100 }],
    bars,
    warmup: 0,
    startingBalance: 1000,
    stats: {},
    costs: FREE,
  });

  assert.strictEqual(panel.aligned, false);
  assert.strictEqual(panel.series.length, 2);
  assert.strictEqual(panel.alignedPoints, 2);
});
