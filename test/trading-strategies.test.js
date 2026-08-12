"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  STRATEGIES,
  DEFAULT_STRATEGY_ID,
  listStrategies,
  getStrategy,
  hasStrategy,
} = require("../src/services/trading/strategies");
const { smcV1 } = require("../src/services/trading/strategies/smc-v1");
const { mindsetV1 } = require("../src/services/trading/strategies/mindset-v1");
const { evaluateMindsetV1 } = require("../src/services/trading/live-scanner");
const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");

const config = makeTradingConfig();

function bar(i, { open, high, low, close, volume = 1000 }) {
  return { openTime: i * 900000, closeTime: (i + 1) * 900000 - 1, open, high, low, close, volume };
}

// A rising series with a wave in it, so confirmed swing highs and lows exist
// and the EMA trend reads up.
function wavyUptrend(count, { from = 0 } = {}) {
  const bars = [];
  for (let i = from; i < from + count; i += 1) {
    const close = 100 + i * 0.3 + Math.sin(i / 3) * 1.5;
    bars.push(bar(i, { open: close - 0.1, high: close + 0.5, low: close - 0.5, close }));
  }
  return bars;
}

/* ── Registry ─────────────────────────────────────────────── */

test("the registry loads every Trading Lab strategy", () => {
  const ids = listStrategies().map((s) => s.id);
  assert.deepEqual(ids.sort(), ["mindset_v1", "shadow_bananagun_v1", "smc_v1"]);
  assert.equal(DEFAULT_STRATEGY_ID, "mindset_v1");

  for (const strategy of STRATEGIES) {
    assert.equal(typeof strategy.id, "string");
    assert.equal(typeof strategy.name, "string");
    assert.ok(strategy.description.length > 0);
    assert.ok(strategy.requiredWarmupBars >= 0);
    if (strategy.supportsBacktest) {
      assert.equal(typeof strategy.evaluate, "function");
    }
  }
});

test("an unknown strategy is rejected with a 400, never silently defaulted", () => {
  assert.equal(hasStrategy("smc_v1"), true);
  assert.equal(hasStrategy("does_not_exist"), false);
  assert.throws(
    () => getStrategy("does_not_exist"),
    (err) => err.statusCode === 400 && /Unknown strategy "does_not_exist"/.test(err.message),
  );
  // Omitted is not the same as unknown: omitted takes the default.
  assert.equal(getStrategy(undefined).id, DEFAULT_STRATEGY_ID);
  assert.equal(getStrategy("").id, DEFAULT_STRATEGY_ID);
});

/* ── mindset_v1 ───────────────────────────────────────────── */

test("mindset_v1 the strategy is the same function the live scanner runs", () => {
  const bars = wavyUptrend(120);
  const direct = evaluateMindsetV1(bars);
  const viaStrategy = mindsetV1.evaluate(bars, bars.length - 1, {});

  assert.equal(viaStrategy.signal, direct.signal);
  assert.deepEqual(viaStrategy.reasons, direct.reasons);
  assert.deepEqual(viaStrategy.indicators, direct.indicators);
  assert.equal(viaStrategy.price, bars[bars.length - 1].close);
});

test("mindset_v1 reads only up to the decided bar", () => {
  const bars = wavyUptrend(200);
  const atBar120 = mindsetV1.evaluate(bars, 119, {});
  const truncated = mindsetV1.evaluate(bars.slice(0, 120), 119, {});
  assert.deepEqual(atBar120, truncated);
});

/* ── smc_v1 ───────────────────────────────────────────────── */

test("smc_v1 returns FLAT on insufficient candles, and says how many it needs", () => {
  const result = smcV1.evaluate(wavyUptrend(40), 39, {});
  assert.equal(result.signal, "FLAT");
  assert.match(result.error, /Need at least 120 closed candles, have 40/);
  assert.equal(result.strategy, "smc_v1");
});

test("smc_v1 returns FLAT with a reason when structure is unclear", () => {
  // A dead-flat series: no swings, no break, no displacement.
  const bars = [];
  for (let i = 0; i < 200; i += 1) bars.push(bar(i, { open: 100, high: 100.2, low: 99.8, close: 100 }));

  const result = smcV1.evaluate(bars, bars.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.error, null);
  assert.ok(result.reasons.length > 0, "a FLAT must still explain itself");
  assert.ok(result.indicators.trend);
});

// The full setup smc_v1 is looking for, built bar by bar: an uptrend, a
// confirmed swing high, a displacement candle that closes above it and leaves
// a fair value gap, then a pullback into that gap.
function bullishSmcSetup() {
  const bars = wavyUptrend(118);
  const peak = 100 + 117 * 0.3 + Math.sin(117 / 3) * 1.5 + 3;

  // 118: the swing high, with lower highs on both sides.
  bars.push(bar(118, { open: peak - 2, high: peak, low: peak - 2.5, close: peak - 0.5 }));
  // 119-120: the pullback that confirms it.
  bars.push(bar(119, { open: peak - 0.5, high: peak - 1, low: peak - 3, close: peak - 2.5 }));
  bars.push(bar(120, { open: peak - 2.5, high: peak - 1.5, low: peak - 3.5, close: peak - 2 }));
  // 121: displacement — a big candle closing well above the swing high.
  bars.push(bar(121, { open: peak - 2, high: peak + 5, low: peak - 2.2, close: peak + 4.5, volume: 4000 }));
  // 122: gaps away, leaving the imbalance between 120's high and 122's low.
  bars.push(bar(122, { open: peak + 4.5, high: peak + 6, low: peak + 1, close: peak + 5.5 }));
  // 123: the retest — trades back into the gap and closes above it.
  bars.push(bar(123, { open: peak + 5, high: peak + 5.2, low: peak - 0.5, close: peak + 1.5 }));
  return { bars, peak };
}

test("smc_v1 goes LONG on trend + BOS + displacement + retest, and shows its working", () => {
  const { bars, peak } = bullishSmcSetup();
  const result = smcV1.evaluate(bars, bars.length - 1, {});

  assert.equal(result.signal, "LONG");
  assert.equal(result.strategy, "smc_v1");
  assert.equal(result.price, bars[bars.length - 1].close);

  const { indicators } = result;
  assert.equal(indicators.trend, "UP");
  assert.equal(indicators.retested, true);
  assert.equal(indicators.displacement, true);
  assert.ok(indicators.bosLevel <= peak && indicators.bosAge <= 12);
  assert.ok(indicators.fvgTop > indicators.fvgBottom);

  assert.ok(result.reasons.some((r) => /BOS/.test(r)));
  assert.ok(result.reasons.some((r) => /Fair value gap/.test(r)));
  assert.ok(result.reasons.some((r) => /retested/.test(r)));

  // Structural hints, on the correct side of the entry.
  assert.ok(result.stopHint < result.price);
  assert.ok(result.targetHint > result.price);
  assert.ok(result.confidence >= 50 && result.confidence <= 100);
});

test("smc_v1 will not take the trade against the trend", () => {
  const { bars } = bullishSmcSetup();
  // Same structure, but the caller's higher-timeframe context says down. The
  // strategy takes the context over its own EMAs and refuses the long.
  const result = smcV1.evaluate(bars, bars.length - 1, { trendUp: false });
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.trend, "DOWN");
  assert.equal(result.indicators.trendSource, "context");
});

test("smc_v1 does not enter on the displacement candle or the bar that completes the gap", () => {
  const { bars } = bullishSmcSetup();
  // The break itself, and the gap bar — the two bars a chasing implementation
  // would take. A gap is not tradeable until it has fully formed on bars the
  // decision can look back at.
  assert.equal(smcV1.evaluate(bars, bars.length - 3, {}).signal, "FLAT");
  assert.equal(smcV1.evaluate(bars, bars.length - 2, {}).signal, "FLAT");
});

test("smc_v1 waits when the gap has formed but price has not come back to it", () => {
  const { bars, peak } = bullishSmcSetup();
  // Same setup, except the final bar drifts higher instead of pulling back
  // into the gap.
  const held = [...bars.slice(0, -1), bar(123, { open: peak + 5, high: peak + 7, low: peak + 4.5, close: peak + 6.5 })];

  const result = smcV1.evaluate(held, held.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.retested, false);
  assert.ok(result.indicators.fvgTop > 0, "the gap itself was still found");
  assert.ok(result.reasons.some((r) => /No pullback into the gap/.test(r)));
});

test("smc_v1 reads only up to the decided bar", () => {
  const { bars } = bullishSmcSetup();
  const withFuture = smcV1.evaluate([...bars, bar(124, { open: 500, high: 600, low: 400, close: 550 })], bars.length - 1, {});
  const withoutFuture = smcV1.evaluate(bars, bars.length - 1, {});
  assert.deepEqual(withFuture, withoutFuture);
});

/* ── Backtest integration ─────────────────────────────────── */

// An uptrend with real pullbacks in it: the drift keeps the EMAs bullish while
// the wave keeps RSI oscillating back into mindset_v1's entry band, so the run
// actually produces trades to assert on.
function trendingCandles(count) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 0.2 + Math.sin(i / 9) * 4;
    bars.push(bar(i, { open: close - 0.2, high: close + 1, low: close - 1, close, volume: 1000 + (i % 7) * 100 }));
  }
  return bars;
}

test("the backtest accepts a strategy id and reports it in the result", async () => {
  const service = new BacktestService({ config });
  const candles = trendingCandles(300);

  for (const id of ["mindset_v1", "smc_v1"]) {
    const result = await service.run({ symbol: "BTCUSDT", interval: "15m", candles, strategy: id });
    assert.equal(result.strategy, id);
    assert.equal(result.strategyName, getStrategy(id).name);
    // A strategy's warmup requirement is a floor the run cannot undercut.
    assert.ok(result.warmupBars >= getStrategy(id).requiredWarmupBars);
    assert.ok(Array.isArray(result.signals));
  }
});

test("an unknown strategy id fails the backtest with a 400", async () => {
  const service = new BacktestService({ config });
  await assert.rejects(
    () => service.run({ symbol: "BTCUSDT", candles: trendingCandles(300), strategy: "nope_v9" }),
    (err) => err.statusCode === 400,
  );
});

test("trades carry the strategy id, so history and metrics can be grouped by it", async () => {
  const service = new BacktestService({ config });
  const result = await service.run({
    symbol: "BTCUSDT",
    interval: "15m",
    candles: trendingCandles(400),
    strategy: "mindset_v1",
  });

  const positions = [...result.trades, ...result.openAtEnd];
  assert.ok(positions.length > 0, "expected the trending series to produce at least one entry");
  for (const position of positions) {
    assert.equal(position.signalSource, "backtest:mindset_v1:15m");
    assert.equal(position.meta.strategy, "mindset_v1");
  }
  assert.ok(result.metrics.groups.strategy.some((row) => row.key === "backtest:mindset_v1:15m"));
});

test("a bare function strategy still works, and is not confused for a registered one", async () => {
  const service = new BacktestService({ config });
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: trendingCandles(200),
    strategy: ({ bars }) => (bars.length === 120 ? "LONG" : null),
  });
  assert.equal(result.strategy, "custom");
});

test("compare runs every strategy over the same candles and reduces each to the promotion numbers", async () => {
  const candles = trendingCandles(400);
  let fetches = 0;
  const service = new BacktestService({
    config,
    signalScreenerService: {
      getCandles: async () => {
        fetches += 1;
        return candles;
      },
    },
  });

  const comparison = await service.compare({
    symbol: "BTCUSDT",
    interval: "15m",
    strategies: ["mindset_v1", "smc_v1"],
  });

  // One fetch for the whole comparison: strategies that saw different candles
  // would not be comparable.
  assert.equal(fetches, 1);
  assert.equal(comparison.results.length, 2);
  assert.deepEqual(comparison.results.map((r) => r.strategy).sort(), ["mindset_v1", "smc_v1"]);

  for (const row of comparison.results) {
    for (const field of [
      "strategy",
      "symbol",
      "interval",
      "bars",
      "closedTrades",
      "netPnlUsd",
      "expectancyR",
      "maxDrawdownPct",
      "winRate",
      "worstLossStreak",
    ]) {
      assert.ok(row[field] !== undefined, `comparison row is missing ${field}`);
    }
    // profitFactor is nullable by design (wins and no losses), so it is
    // checked for presence rather than for being a number.
    assert.ok("profitFactor" in row);
    assert.equal(row.symbol, "BTCUSDT");
    assert.equal(row.interval, "15m");
  }
});

test("comparing an unknown strategy fails before any candles are fetched", async () => {
  let fetches = 0;
  const service = new BacktestService({
    config,
    signalScreenerService: {
      getCandles: async () => {
        fetches += 1;
        return trendingCandles(300);
      },
    },
  });

  await assert.rejects(
    () => service.compare({ symbol: "BTCUSDT", strategies: ["mindset_v1", "nope_v9"] }),
    (err) => err.statusCode === 400,
  );
  assert.equal(fetches, 0);
});
