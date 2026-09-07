"use strict";

// The performance panel as the backtester actually produces it.
//
// The unit tests in trading-benchmark.test.js hold the arithmetic. These hold
// the WIRING: that the benchmark is built from the same candles the replay
// consumed, from the same barrier, with the same capital and the same fee
// rates the run was charged — and that nothing about the strategy being
// replayed leaks into the line it is being compared against.

const test = require("node:test");
const assert = require("node:assert");

const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");
const { listStrategies, getStrategy } = require("../src/services/trading/strategies");
const { SCENARIOS } = require("../src/services/trading/cost-scenarios");
const { buildBuyAndHold } = require("../src/services/trading/benchmark");

const config = makeTradingConfig();

function makeService(overrides) {
  return new BacktestService({ config: overrides ? makeTradingConfig(overrides) : config });
}

// A rising, ranging series with real intrabar range: enough movement for ATR
// to be non-zero and for several strategies to find something, and a clear
// buy-and-hold return to check the benchmark against.
function marketCandles(count = 400) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 0.35 + Math.sin(i / 9) * 6 + Math.sin(i / 37) * 14;
    bars.push({
      openTime: i * 14400000,
      closeTime: (i + 1) * 14400000,
      open: close - 0.3,
      high: close + 1.4,
      low: close - 1.4,
      close,
      volume: 1000 + (i % 11) * 90,
    });
  }
  return bars;
}

const CANDLES = marketCandles();

function run(service, options = {}) {
  return service.run({
    symbol: "BTCUSDT",
    interval: "4h",
    candles: CANDLES,
    ...options,
  });
}

/* ── Shape and wiring ───────────────────────────────────────────────────── */

test("a run carries a performance panel with both sides filled in", async () => {
  const result = await run(makeService(), { strategy: "mindset_v1" });
  const panel = result.performance;

  assert.ok(panel, "the run should carry a performance panel");
  assert.strictEqual(panel.benchmark.available, true);
  assert.strictEqual(panel.aligned, true);
  assert.strictEqual(panel.startingBalance, result.stats.startingBalance);

  for (const key of ["netPnlUsd", "returnPct", "maxDrawdownPct", "totalTrades", "winRate", "profitFactor"]) {
    assert.ok(key in panel.strategy, `the panel is missing ${key}`);
  }
  assert.strictEqual(panel.strategy.totalTrades, result.stats.totalTrades);
  assert.strictEqual(panel.strategy.winRate, result.stats.winRate);
  assert.strictEqual(panel.strategy.profitFactor, result.stats.riskMetrics.profitFactor);
  assert.strictEqual(panel.strategy.openAtEnd, result.openAtEnd.length);
});

test("every panel point sits on the same bar as the equity curve point beside it", async () => {
  // The property the chart rests on: a benchmark drawn one bar out is a chart
  // that lies quietly, and no stat tile would reveal it.
  const result = await run(makeService(), { strategy: "mindset_v1" });
  const panel = result.performance;

  assert.strictEqual(panel.series.length, result.equityCurve.length);
  assert.strictEqual(panel.benchmark.curve.length, result.equityCurve.length);
  panel.series.forEach((point, i) => {
    assert.strictEqual(point.at, result.equityCurve[i].at, `series point ${i} is on the wrong bar`);
    assert.strictEqual(point.strategy, result.equityCurve[i].equity);
    assert.strictEqual(point.benchmark, panel.benchmark.curve[i].equity);
  });
});

test("the benchmark starts at the warmup barrier, on the bar the strategy could first trade", async () => {
  const result = await run(makeService(), { strategy: "mindset_v1" });
  assert.strictEqual(result.performance.benchmark.entryAt, CANDLES[result.warmupBars].closeTime);
  assert.strictEqual(result.performance.series[0].at, result.from);
  assert.strictEqual(
    result.performance.series[result.performance.series.length - 1].at,
    result.to,
  );
});

test("the benchmark is priced with the very fee rates the run reports", async () => {
  const service = makeService();
  const result = await run(service, { strategy: "mindset_v1", costScenario: "stress" });

  assert.deepStrictEqual(result.performance.benchmark.costs, {
    takerFeeRate: SCENARIOS.stress.takerFeeRate,
    slippageRate: SCENARIOS.stress.slippageRate,
    fundingRate8h: SCENARIOS.stress.fundingRate8h,
  });
  assert.strictEqual(result.performance.benchmark.costs.takerFeeRate, result.costs.takerFeeRate);
  assert.strictEqual(result.performance.benchmark.costs.slippageRate, result.costs.slippageRate);

  // ...and a cheaper scenario really does leave the hold with more money,
  // rather than the rates merely being echoed on the payload.
  const cheap = await run(service, { strategy: "mindset_v1", costScenario: "frictionless" });
  assert.ok(
    cheap.performance.benchmark.netPnlUsd > result.performance.benchmark.netPnlUsd,
    "a frictionless hold should beat a stressed one",
  );
});

test("the benchmark matches an independently computed hold over the same window", async () => {
  // Recomputed from the outside, from the run's own reported inputs. If the
  // wiring ever starts handing the benchmark a different candle array, a
  // different barrier or a different balance, these stop agreeing.
  const result = await run(makeService(), { strategy: "mindset_v1", costScenario: "baseline" });
  const expected = buildBuyAndHold({
    bars: CANDLES,
    warmup: result.warmupBars,
    startingBalance: result.stats.startingBalance,
    costs: result.costs,
  });

  assert.strictEqual(result.performance.benchmark.returnPct, expected.returnPct);
  assert.strictEqual(result.performance.benchmark.netPnlUsd, expected.netPnlUsd);
  assert.strictEqual(result.performance.benchmark.maxDrawdownPct, expected.maxDrawdownPct);
});

/* ── Isolation: nothing strategy-specific may reach the benchmark ───────── */

test("every strategy over the same candles is compared against the SAME hold", async () => {
  // The comparison is only a comparison if the thing being compared against is
  // identical. A benchmark that shifted with the strategy — different warmup,
  // different execution mode, different options — would quietly rank the
  // strategies by their own baselines.
  const service = makeService();
  const ids = listStrategies({ supportsBacktest: true }).map((s) => s.id);
  assert.ok(ids.length > 1, "this test needs more than one backtestable strategy");

  const benchmarks = [];
  for (const id of ids) {
    const result = await run(service, { strategy: id });
    benchmarks.push({ id, benchmark: result.performance.benchmark, warmup: result.warmupBars });
  }

  const first = benchmarks[0];
  for (const row of benchmarks.slice(1)) {
    // Strategies declare different warmup requirements, so a longer-warmup
    // strategy legitimately gets a shorter window. What must never differ is
    // the PRICE the hold is entered at for a given barrier.
    if (row.warmup !== first.warmup) continue;
    assert.strictEqual(row.benchmark.entryPrice, first.benchmark.entryPrice, `${row.id} entered the hold elsewhere`);
    assert.strictEqual(row.benchmark.returnPct, first.benchmark.returnPct, `${row.id} got a different hold`);
    assert.strictEqual(row.benchmark.maxDrawdownPct, first.benchmark.maxDrawdownPct, `${row.id} got a different hold`);
  }
});

test("execution mode changes the strategy's numbers and not the hold's", async () => {
  const service = makeService();
  const shared = await run(service, { strategy: "bb_mean_reversion_v4", executionMode: "shared" });
  const native = await run(service, { strategy: "bb_mean_reversion_v4", executionMode: "native" });

  assert.deepStrictEqual(shared.performance.benchmark.curve, native.performance.benchmark.curve);
  assert.strictEqual(shared.performance.benchmark.returnPct, native.performance.benchmark.returnPct);
});

test("strategy options move the benchmark only by moving the window both lines share", async () => {
  // The tempting assertion here — "options must never change the benchmark" —
  // is wrong, and the distinction matters.
  //
  // Several strategy options feed warmupFor(), so changing one moves the bar
  // the strategy can first trade on. The benchmark HAS to move with it: two
  // lines covering different windows are not a comparison, and a hold that
  // kept entering at the old barrier would be measuring a longer run than the
  // strategy beside it. What must never happen is the benchmark being priced
  // by anything OTHER than that shared window — so this pins the window
  // equality, and pins bit-for-bit invariance for any option that leaves
  // warmup alone.
  const service = makeService();
  const parameterised = listStrategies({ supportsBacktest: true })
    .map((summary) => getStrategy(summary.id))
    .find((definition) => (definition.optionSchema || []).some((f) => f.type === "int" || f.type === "number"));
  assert.ok(parameterised, "this test needs a strategy with a numeric option to vary");

  const base = await run(service, { strategy: parameterised.id });
  let checkedUnmoved = 0;

  // A different-but-legal value for one option. Some fields sit at their own
  // ceiling by default, so a blind +1 would be rejected by the strategy's
  // validator rather than testing anything.
  function nudge(field) {
    const value = Number(parameterised.defaultOptions[field.key]);
    const step = field.type === "int" ? 1 : Number(field.step) || 0.1;
    const up = value + step;
    if (field.max == null || up <= Number(field.max)) return up;
    const down = value - step;
    if (field.min == null || down >= Number(field.min)) return down;
    return null;
  }

  for (const field of parameterised.optionSchema) {
    if (field.type !== "int" && field.type !== "number") continue;
    const alternative = nudge(field);
    if (alternative === null) continue;
    const bumped = await run(service, {
      strategy: parameterised.id,
      options: { [field.key]: alternative },
    });

    // Whatever the option did to warmup, the hold covers exactly the window
    // the strategy was measured over — same first bar, same last bar, same
    // number of points.
    assert.strictEqual(bumped.performance.benchmark.entryAt, CANDLES[bumped.warmupBars].closeTime, field.key);
    assert.strictEqual(bumped.performance.series[0].at, bumped.from, field.key);
    assert.strictEqual(bumped.performance.benchmark.curve.length, bumped.equityCurve.length, field.key);
    assert.strictEqual(bumped.performance.aligned, true, field.key);

    // ...and an option that did NOT move the barrier leaves the hold bit for
    // bit identical, so a parameter sweep cannot drift its own baseline.
    if (bumped.warmupBars === base.warmupBars) {
      checkedUnmoved += 1;
      assert.deepStrictEqual(
        bumped.performance.benchmark.curve,
        base.performance.benchmark.curve,
        `${field.key} moved the hold without moving the window`,
      );
    }
  }

  assert.ok(checkedUnmoved > 0, "no option left warmup alone, so invariance went untested");
});

/* ── Regression: existing strategies and the existing payload ───────────── */

test("every backtestable strategy still runs and produces an aligned panel", async () => {
  const service = makeService();
  for (const summary of listStrategies({ supportsBacktest: true })) {
    const result = await run(service, { strategy: summary.id });

    // The pre-existing contract, unchanged.
    assert.strictEqual(result.strategy, summary.id, summary.id);
    assert.ok(Array.isArray(result.trades), summary.id);
    assert.ok(Array.isArray(result.equityCurve), summary.id);
    assert.ok(result.stats && result.metrics && result.regimeMetrics, summary.id);
    assert.ok(Array.isArray(result.caveats), summary.id);

    // ...and the panel beside it.
    const panel = result.performance;
    assert.strictEqual(panel.aligned, true, summary.id);
    assert.strictEqual(panel.series.length, result.equityCurve.length, summary.id);
    assert.ok(Number.isFinite(panel.strategy.maxDrawdownPct), summary.id);
    assert.ok(panel.strategy.maxDrawdownPct >= 0, summary.id);
    assert.ok(Number.isFinite(panel.benchmark.returnPct), summary.id);
  }
});

test("a strategy that never trades gets a flat line, not an absent panel", async () => {
  // "Refused every setup" is a result, and the benchmark beside it is exactly
  // what says how much that refusal cost.
  const result = await run(makeService(), { strategy: () => ({ signal: null }) });

  assert.strictEqual(result.trades.length, 0);
  assert.strictEqual(result.performance.strategy.totalTrades, 0);
  assert.strictEqual(result.performance.strategy.netPnlUsd, 0);
  assert.strictEqual(result.performance.strategy.maxDrawdownPct, 0);
  assert.strictEqual(result.performance.benchmark.available, true);
  assert.ok(result.performance.series.every((p) => p.strategy === result.stats.startingBalance));
});

test("adding the panel did not disturb the summary the comparison table and experiments read", async () => {
  // summarizeRun() is what gets persisted as an experiment record and what the
  // comparison table ranks on. The panel rides alongside the run, never inside
  // that reduction — a few thousand extra points per stored experiment is a
  // different decision from drawing a chart.
  const { summarizeRun } = require("../src/services/trading/run-summary");
  const result = await run(makeService(), { strategy: "mindset_v1" });
  const summary = summarizeRun(result);

  assert.ok(!("performance" in summary), "the panel must not leak into the experiment record");
  assert.ok(!("benchmark" in summary));
  assert.strictEqual(summary.closedTrades, result.stats.riskMetrics.closedTrades);
  assert.strictEqual(summary.maxDrawdownPct, result.stats.riskMetrics.maxDrawdownPct);
});

test("the panel's drawdown and the closed-trade drawdown are both reported and both true", async () => {
  // They answer different questions and are allowed to differ: the panel's is
  // mark-to-market off the equity curve (comparable to the hold), and
  // metrics.js walks realised P&L trade by trade. Both stay on the payload so
  // neither silently replaces the other.
  const result = await run(makeService(), { strategy: "mindset_v1" });
  assert.ok(Number.isFinite(result.stats.riskMetrics.maxDrawdownPct));
  assert.ok(Number.isFinite(result.performance.strategy.maxDrawdownPct));
  assert.ok(
    result.performance.strategy.maxDrawdownPct >= result.stats.riskMetrics.maxDrawdownPct - 1e-9,
    "a mark-to-market drawdown can never be shallower than the closed-trade one it contains",
  );
});
