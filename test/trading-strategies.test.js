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
const { donchianBreakoutV1 } = require("../src/services/trading/strategies/donchian-breakout-v1");
const { vwapReversionV1 } = require("../src/services/trading/strategies/vwap-reversion-v1");
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
  assert.deepEqual(ids.sort(), [
    "donchian_breakout_v1",
    "mindset_v1",
    "mindset_v1_1",
    "shadow_bananagun_v1",
    "smc_v1",
    "vwap_reversion_v1",
  ]);
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
  const result = smcV1.evaluate(bars, bars.length - 1, { htfTrendUp: false });
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.trend, "DOWN");
  assert.equal(result.indicators.trendSource, "htf");
});

test("smc_v1 ignores a same-timeframe trend offered as higher-timeframe context", () => {
  const { bars } = bullishSmcSetup();

  // `timeframeTrendUp` is the trend of the chart smc_v1 is already reading. It
  // is not higher-timeframe information and must not be treated as any, so a
  // false value here cannot veto the long the way `htfTrendUp: false` does
  // above — the strategy falls through to its own EMA read.
  const offered = smcV1.evaluate(bars, bars.length - 1, { timeframeTrendUp: false });
  const bare = smcV1.evaluate(bars, bars.length - 1, {});

  assert.equal(offered.indicators.trendSource, "ema");
  assert.equal(offered.signal, bare.signal);
  assert.equal(offered.confidence, bare.confidence);
});

test("smc_v1 pays its higher-timeframe confidence bonus only for genuine HTF data", () => {
  const { bars } = bullishSmcSetup();

  const withoutHtf = smcV1.evaluate(bars, bars.length - 1, {});
  const withHtf = smcV1.evaluate(bars, bars.length - 1, { htfTrendUp: true });

  assert.equal(withoutHtf.signal, "LONG");
  assert.equal(withHtf.signal, "LONG");
  // The +10 is a payment for information from OUTSIDE the traded timeframe. It
  // used to be collected on a candle backtest, where the backtester filled in
  // `trendUp` from an EMA cross of the very same candles — the strategy being
  // paid for agreeing with itself.
  assert.equal(withoutHtf.indicators.trendSource, "ema");
  assert.equal(withHtf.indicators.trendSource, "htf");
  assert.equal(withHtf.confidence - withoutHtf.confidence, 10);
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
    // This test is about how a trade is LABELLED, not about whether a
    // candles-only setup clears the checklist's floor, so it supplies the
    // higher-timeframe and macro context a real caller would have.
    marketContext: {
      htfTrendUp: true,
      usdtDominanceSignal: "RISK_ON",
      btcDominanceRising: false,
      bearMarket: false,
      fundingRate: 0,
    },
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

/* ── donchian_breakout_v1 ─────────────────────────────────── */

// A quiet range, so the channel is well defined and nothing has broken it.
function range(count, { from = 0, mid = 100, width = 1 } = {}) {
  const bars = [];
  for (let i = from; i < from + count; i += 1) {
    const close = mid + Math.sin(i / 2) * width;
    bars.push(bar(i, { open: close, high: close + width, low: close - width, close }));
  }
  return bars;
}

test("donchian_breakout_v1 returns FLAT on insufficient candles, and says how many it needs", () => {
  const result = donchianBreakoutV1.evaluate(range(20), 19, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.strategy, "donchian_breakout_v1");
  assert.match(result.error, /Need at least \d+ closed candles/);
});

test("donchian_breakout_v1 stays FLAT inside the channel", () => {
  const bars = range(200);
  const result = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.brokeOut, false);
  assert.ok(result.reasons.some((r) => /inside the channel/.test(r)));
});

// A long rise (so the SMA trend filter agrees) followed by a decisive close
// above everything the channel has seen.
function breakoutSeries({ breakTo = 160 } = {}) {
  const bars = [];
  for (let i = 0; i < 200; i += 1) {
    const close = 100 + i * 0.15;
    bars.push(bar(i, { open: close, high: close + 0.4, low: close - 0.4, close }));
  }
  bars.push(bar(200, { open: 130, high: breakTo + 1, low: 129, close: breakTo }));
  return bars;
}

test("donchian_breakout_v1 goes LONG on a fresh close beyond the channel, with ATR stop geometry", () => {
  const bars = breakoutSeries();
  const result = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});

  assert.equal(result.signal, "LONG");
  assert.equal(result.indicators.brokeOut, true);
  assert.equal(result.indicators.fresh, true);
  assert.ok(result.price > result.indicators.channelHigh);
  assert.ok(result.stopHint < result.price, "stop sits below entry on a long");
  assert.ok(result.targetHint > result.price, "target sits above entry on a long");

  // Reward must be the configured multiple of the risk, or the baseline is not
  // testing the geometry it claims to.
  const risk = result.price - result.stopHint;
  const reward = result.targetHint - result.price;
  assert.ok(Math.abs(reward / risk - 3) < 1e-9);
});

test("donchian_breakout_v1 refuses a break that only wicked through the channel", () => {
  const bars = breakoutSeries();
  const last = bars[bars.length - 1];
  // Same high, but the bar closes back inside: a test of the level, not a break.
  bars[bars.length - 1] = bar(200, { open: 130, high: last.high, low: 129, close: 130 });

  const result = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.brokeOut, false);
});

test("donchian_breakout_v1 signals once, not on every bar of the move that follows", () => {
  const bars = breakoutSeries();
  // A second bar that closes even higher — still beyond the channel, but the
  // break already happened.
  bars.push(bar(201, { open: 160, high: 166, low: 159, close: 165 }));

  const result = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.brokeOut, true);
  assert.equal(result.indicators.fresh, false);
  assert.ok(result.reasons.some((r) => /continuation, not a fresh break/.test(r)));
});

test("donchian_breakout_v1 refuses a break against its trend filter, and takes it without one", () => {
  // A long downtrend, then a pop above the recent channel: the break is real
  // but price is still far below the SMA100.
  const bars = [];
  for (let i = 0; i < 200; i += 1) {
    const close = 200 - i * 0.4;
    bars.push(bar(i, { open: close, high: close + 0.4, low: close - 0.4, close }));
  }
  // Closes above the 20-bar channel high (128.4) while still far below the
  // SMA100 (~139.9) — a real break that the trend filter should still refuse.
  bars.push(bar(200, { open: 121, high: 132, low: 120, close: 131 }));

  const filtered = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});
  assert.equal(filtered.signal, "FLAT");
  assert.equal(filtered.indicators.brokeOut, true);
  assert.ok(filtered.reasons.some((r) => /Counter-trend break refused/.test(r)));

  const unfiltered = donchianBreakoutV1.evaluate(bars, bars.length - 1, {
    options: { useTrendFilter: false },
  });
  assert.equal(unfiltered.signal, "LONG");
});

test("donchian_breakout_v1 reads only up to the decided bar", () => {
  const bars = breakoutSeries();
  const withFuture = donchianBreakoutV1.evaluate(
    [...bars, bar(201, { open: 500, high: 600, low: 400, close: 550 })],
    bars.length - 1,
    {},
  );
  const withoutFuture = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});
  assert.deepEqual(withFuture, withoutFuture);
});

/* ── vwap_reversion_v1 ────────────────────────────────────── */

// A quiet oscillation around a flat mean keeps ADX low and VWAP near price;
// the caller then appends whatever stretch it wants to test.
function quietRange(count) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + Math.sin(i / 2) * 0.6;
    bars.push(bar(i, { open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 }));
  }
  return bars;
}

test("vwap_reversion_v1 returns FLAT on insufficient candles, and says how many it needs", () => {
  const result = vwapReversionV1.evaluate(quietRange(20), 19, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.strategy, "vwap_reversion_v1");
  assert.match(result.error, /Need at least \d+ closed candles/);
});

test("vwap_reversion_v1 stays FLAT when price sits near VWAP", () => {
  const bars = quietRange(80);
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.ok(Math.abs(result.indicators.stretchAtr) < 1.8);
  assert.ok(result.reasons.some((r) => /near fair value/.test(r)));
});

// Stretch far above VWAP, then a bar that closes lower: stretched and stalling.
function stretchedAbove({ stall = true } = {}) {
  // 120 bars of range, not 80: ADX needs enough quiet history to actually read
  // as a range regime, and a shorter series leaves it sitting on the threshold
  // where the test would be measuring the fixture rather than the strategy.
  const bars = quietRange(120);
  bars.push(bar(120, { open: 100, high: 104, low: 100, close: 103.5, volume: 100 }));
  bars.push(
    stall
      ? bar(121, { open: 103.5, high: 104, low: 102.6, close: 102.8, volume: 100 })
      : bar(121, { open: 103.5, high: 105.5, low: 103.4, close: 105.2, volume: 100 }),
  );
  return bars;
}

test("vwap_reversion_v1 goes SHORT on a stalled stretch above VWAP, targeting VWAP itself", () => {
  const bars = stretchedAbove();
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, {});

  assert.equal(result.signal, "SHORT");
  assert.equal(result.indicators.regime, "RANGE");
  assert.equal(result.indicators.stalled, true);
  assert.ok(result.indicators.stretchAtr >= 1.8);
  assert.equal(result.targetHint, result.indicators.vwap, "the target is the reversion, nothing beyond it");
  assert.ok(result.stopHint > result.price, "stop sits above entry on a short");
  assert.ok(result.indicators.rewardR >= 1);
});

test("vwap_reversion_v1 will not catch a stretch that is still extending", () => {
  const bars = stretchedAbove({ stall: false });
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, {});
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.stalled, false);
  assert.ok(result.reasons.some((r) => /still extending/.test(r)));
});

test("vwap_reversion_v1 stands down in a trending regime rather than fading it", () => {
  const bars = stretchedAbove();
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, { options: { maxAdx: 0 } });
  assert.equal(result.signal, "FLAT");
  assert.equal(result.indicators.regime, "TREND");
  assert.ok(result.reasons.some((r) => /stands down/.test(r)));
});

test("vwap_reversion_v1 refuses a correct read with unusable geometry", () => {
  const bars = stretchedAbove();
  // The setup is unchanged; only the reward/risk floor moves. A strategy that
  // still traded here would be taking small wins funded by large losses.
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, { options: { minRewardR: 50 } });
  assert.equal(result.signal, "FLAT");
  assert.ok(result.reasons.some((r) => /wrong geometry/.test(r)));
});

test("vwap_reversion_v1 waits for VWAP to accumulate after a session reset", () => {
  const bars = stretchedAbove();
  // 122 bars of 15m candles crosses one UTC midnight, so the last bar sits
  // ~26 bars into its session. A threshold above that exercises the session
  // refusal; a threshold above the bar count would trip the warmup floor
  // first, which is a different — and also correct — refusal.
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, { options: { minSessionBars: 30 } });
  assert.equal(result.signal, "FLAT");
  assert.ok(result.indicators.sessionBars < 30);
  assert.ok(result.reasons.some((r) => /VWAP is not meaningful yet/.test(r)));
});

test("an option that cannot be satisfied by the data is a warmup refusal, not a crash", () => {
  const bars = stretchedAbove();
  // You cannot be 500 bars into a session with 122 bars of history, so the
  // warmup floor is what answers here.
  const result = vwapReversionV1.evaluate(bars, bars.length - 1, { options: { minSessionBars: 500 } });
  assert.equal(result.signal, "FLAT");
  assert.match(result.error, /Need at least 500 closed candles/);
});

test("vwap_reversion_v1 picks its VWAP anchor from the candle spacing", () => {
  // 15m bars: 96 per day, so a daily anchor accumulates plenty.
  const intraday = vwapReversionV1.evaluate(stretchedAbove(), 121, {});
  assert.equal(intraday.indicators.anchor, "day");

  // The same shape on 4h bars: six bars per day is not a session, and a daily
  // anchor there silently produces a strategy that never trades. Regression
  // test for exactly that — it shipped dead on the lab's default interval.
  const wide = stretchedAbove().map((b, i) => ({
    ...b,
    openTime: i * 14400000,
    closeTime: (i + 1) * 14400000 - 1,
  }));
  const swing = vwapReversionV1.evaluate(wide, wide.length - 1, {});
  assert.equal(swing.indicators.anchor, "month");

  // An explicit anchor still wins over the inference.
  assert.equal(
    vwapReversionV1.evaluate(wide, wide.length - 1, { options: { anchor: "day" } }).indicators.anchor,
    "day",
  );
});

test("vwap_reversion_v1 reads only up to the decided bar", () => {
  const bars = stretchedAbove();
  const withFuture = vwapReversionV1.evaluate(
    [...bars, bar(122, { open: 500, high: 600, low: 400, close: 550 })],
    bars.length - 1,
    {},
  );
  const withoutFuture = vwapReversionV1.evaluate(bars, bars.length - 1, {});
  assert.deepEqual(withFuture, withoutFuture);
});

/* ── The two together ─────────────────────────────────────── */

test("the trend baseline and the reversion strategy do not fire on the same bar", () => {
  // Not a claim about correlation in general — a structural one. A fresh
  // channel break IS the trending move vwap_reversion_v1 refuses to fade, so
  // the two agreeing would mean one of the regime filters is not working.
  const bars = breakoutSeries();
  const breakout = donchianBreakoutV1.evaluate(bars, bars.length - 1, {});
  const reversion = vwapReversionV1.evaluate(bars, bars.length - 1, {});
  assert.equal(breakout.signal, "LONG");
  assert.equal(reversion.signal, "FLAT");
});
