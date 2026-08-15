"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BacktestService,
  contextAtBar,
  buildContextSeries,
  atrSeries,
  appliedExecution,
  trendBreakoutStrategy,
  downsampleCurve,
  rankRows,
} = require("../src/services/trading/backtest");
const { atr } = require("../src/services/decision-engine");
const { makeTradingConfig } = require("../src/services/trading/config");
const { summarizeRun } = require("../src/services/trading/run-summary");
const { listStrategies } = require("../src/services/trading/strategies");

const config = makeTradingConfig();

function makeService() {
  return new BacktestService({ config });
}

// Synthetic candles: a flat warmup so indicators settle, then a caller-shaped
// tail. Bars are 4h apart so closeTime is monotonic and readable.
function makeCandles(count, shape) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const base = shape ? shape(i) : {};
    const close = base.close ?? 100;
    bars.push({
      openTime: i * 14400000,
      closeTime: (i + 1) * 14400000,
      open: base.open ?? close,
      high: base.high ?? close,
      low: base.low ?? close,
      close,
      volume: base.volume ?? 1000,
    });
  }
  return bars;
}

// A steadily rising series that will put the trend filter bullish and produce
// breakouts, with enough range for ATR to be non-zero.
function risingCandles(count) {
  return makeCandles(count, (i) => {
    const close = 100 + i * 0.8;
    return { open: close - 0.4, high: close + 0.6, low: close - 0.8, close, volume: 1000 + (i % 5) * 200 };
  });
}

// Market context a caller genuinely has once a higher-timeframe and funding
// feed are wired up. Fixtures below that are testing FILL MECHANICS — which
// intra-bar extreme fires first, whether an entry fills at the signalling
// close, whether native levels are applied — supply it so the checklist has
// real evidence to score and the setup is actually sized.
//
// Without it a candle-only run has just 60 of the checklist's 100 points
// reachable (no macro, no funding, no daily bias) against an unchanged
// 50-point floor, so almost nothing trades. That restriction is correct and is
// asserted on its own further down; it just makes it a poor harness for
// testing whether a stop fills at the right price.
const FED_LONG = Object.freeze({
  htfTrendUp: true,
  usdtDominanceSignal: "RISK_ON",
  btcDominanceRising: false,
  bearMarket: false,
  fundingRate: 0,
});
const FED_SHORT = Object.freeze({
  htfTrendUp: false,
  usdtDominanceSignal: "RISK_OFF",
  btcDominanceRising: true,
  bearMarket: true,
  fundingRate: 0,
});

// 61 gently rising warmup bars followed by one caller-shaped bar. The rise is
// slow enough that the breakout rule stays quiet (so only the test's own
// strategy opens anything) but steady enough that the trend filter reads
// bullish — a flat series would make EMA fast == EMA slow, and the regime gate
// would refuse every long before the test got to what it was checking.
// Each warmup bar has a 1.0 range, which puts ATR at 1.0 and therefore the
// stop 1.5 below entry, TP1 1.5R above and TP2 2.5R above.
const WARMUP = 61;
const ENTRY_CLOSE = 100 + (WARMUP - 1) * 0.1; // 106

function trendingUpThen(finalBar) {
  return makeCandles(WARMUP + 1, (i) => {
    if (i < WARMUP) {
      const close = 100 + i * 0.1;
      return { open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
    }
    return finalBar;
  });
}

function onlyAtEntryBar(direction) {
  return ({ bars }) => (bars.length === WARMUP ? direction : null);
}

// Record every filesystem write attempted while `fn` runs. A backtest must
// make none: its ledger is in memory, which is both the isolation guarantee
// (it cannot reach the live books if it cannot write at all) and the
// performance one.
async function captureWrites(fn) {
  const originals = {
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    renameSync: fs.renameSync,
  };
  const writes = [];
  for (const name of Object.keys(originals)) {
    fs[name] = function patched(target, ...args) {
      writes.push(`${name}:${target}`);
      return originals[name].call(fs, target, ...args);
    };
  }
  try {
    await fn(writes);
  } finally {
    Object.assign(fs, originals);
  }
}

test("a run needs more candles than its warmup", async () => {
  const service = makeService();
  await assert.rejects(
    () => service.run({ symbol: "BTCUSDT", candles: risingCandles(30) }),
    (err) => err.statusCode === 400 && /Not enough candles/.test(err.message),
  );
});

test("a completed run reports metrics in the same shape as a live book", async () => {
  const service = makeService();
  const result = await service.run({ symbol: "BTCUSDT", candles: risingCandles(200) });

  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.bars, 200);
  assert.ok(result.equityCurve.length > 0);
  assert.ok(result.stats.riskMetrics);
  assert.ok(result.metrics.groups.strategy);
  assert.equal(result.stats.startingBalance, config.accountSize);
});

test("a backtest reports the execution cost assumptions it used", async () => {
  const service = new BacktestService({
    config: makeTradingConfig({ takerFeeRate: 0.0006, slippageRate: 0.0002, fundingRate8h: 0.0001 }),
  });

  const result = await service.run({ symbol: "BTCUSDT", candles: risingCandles(120) });
  assert.deepEqual(result.costs, {
    takerFeeRate: 0.0006,
    slippageRate: 0.0002,
    fundingRate8h: 0.0001,
  });
});

test("a backtest never touches the live books, and writes nothing at all", async () => {
  const service = makeService();

  await captureWrites(async (writes) => {
    const result = await service.run({ symbol: "BTCUSDT", candles: risingCandles(200) });
    assert.ok(result.stats);
    assert.ok(result.trades.length >= 0);
    // Not "cleans up after itself" — never creates anything to clean up. The
    // run's ledger is a MemoryStorage, so there is no temp directory, no
    // window in which a crash could strand one, and no path by which a
    // backtest could address a live book's files.
    assert.deepEqual(writes, []);
  });
});

test("a run that throws still leaves nothing on disk", async () => {
  const service = makeService();

  await captureWrites(async (writes) => {
    await assert.rejects(() =>
      service.run({
        symbol: "BTCUSDT",
        candles: risingCandles(200),
        strategy: () => {
          throw new Error("strategy exploded");
        },
      }),
    );
    assert.deepEqual(writes, []);
  });
});

/* ── Lookahead ────────────────────────────────────────────── */

test("the strategy only ever sees bars up to and including the current one", async () => {
  const service = makeService();
  const candles = risingCandles(120);
  const seen = [];

  await service.run({
    symbol: "BTCUSDT",
    candles,
    strategy: ({ bars, context }) => {
      seen.push({ length: bars.length, lastClose: bars[bars.length - 1].close, contextClose: context.close });
      return null;
    },
  });

  // Every call's final bar is the bar being decided, and the window grows by
  // exactly one each time — no future bar is ever in the slice.
  seen.forEach((call, i) => {
    assert.equal(call.length, 60 + i + 1);
    assert.equal(call.lastClose, candles[60 + i].close);
    assert.equal(call.contextClose, candles[60 + i].close);
  });
});

test("context at a bar is unaffected by anything after it", () => {
  const candles = risingCandles(120);
  const options = { trendFast: 21, trendSlow: 55, macdFast: 12, macdSlow: 26, macdSignal: 9 };

  // Bar 80 as computed by a caller who has ONLY the first 80 bars.
  const truncated = contextAtBar(candles.slice(0, 80), options);

  // Bar 80 as computed from the full 120-bar array via the precomputed series
  // the runner uses. The extra 40 bars exist, are in the same array, and have
  // already been walked by every series — and must still not change a single
  // value that was knowable at bar 80.
  const series = buildContextSeries(candles, options);
  const withFuture = contextAtBar(candles, options, { index: 79, series });

  assert.deepEqual(truncated, withFuture);
  assert.equal(truncated.close, candles[79].close);

  // And a future that is not merely more of the same: a violent spike after
  // bar 80 would move any indicator that leaked backwards.
  const spiked = candles.slice(0, 120).map((bar, i) =>
    i >= 80 ? { ...bar, high: bar.high * 5, low: bar.low / 5, close: bar.close * 3 } : bar,
  );
  const afterSpike = contextAtBar(spiked, options, {
    index: 79,
    series: buildContextSeries(spiked, options),
  });
  assert.deepEqual(afterSpike, truncated);
});

test("the ATR series equals a prefix recomputation at every bar", () => {
  // The optimisation that makes the runner linear rests entirely on this
  // equality, so it is asserted directly rather than inferred.
  const candles = risingCandles(200).map((bar, i) => ({
    ...bar,
    high: bar.high + (i % 7) * 0.3,
    low: bar.low - (i % 5) * 0.4,
  }));
  const series = atrSeries(candles, 14);

  for (let i = 0; i < candles.length; i += 1) {
    assert.equal(series[i], atr(candles.slice(0, i + 1), 14), `ATR mismatch at bar ${i}`);
  }
});

test("entries fill at the signalling bar's close, never at a later price", async () => {
  const service = makeService();
  const candles = risingCandles(120);
  let signalBar = null;

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    strategy: ({ bars }) => {
      if (signalBar === null && bars.length === 80) {
        signalBar = bars[bars.length - 1];
        return "LONG";
      }
      return null;
    },
    marketContext: FED_LONG,
  });

  const opened = [...result.trades, ...result.openAtEnd];
  assert.equal(opened.length, 1);
  assert.equal(opened[0].entryPrice, signalBar.close);
});

/* ── Intra-bar ordering ───────────────────────────────────── */

test("when a bar contains both the stop and the target, the stop wins", async () => {
  const service = makeService();
  // The bar after the entry spans both the stop (104.5) and TP2 (109.75). An
  // optimistic backtester would book the win; this one must book the loss.
  const candles = trendingUpThen({ open: ENTRY_CLOSE, high: 115, low: 90, close: 112, volume: 1000 });

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: WARMUP - 1,
    strategy: onlyAtEntryBar("LONG"),
    marketContext: FED_LONG,
  });

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.closeReason, "STOP_LOSS");
  assert.ok(trade.pnl < 0, `expected a loss, got ${trade.pnl}`);
  // The 90 low gapped through the 104.5 stop, so the fill is the gap, not the
  // level — a stop that gaps does not fill where you hoped.
  assert.equal(trade.exitPrice, 90);
});

test("a short's adverse extreme is the high, and it is tested first", async () => {
  const service = makeService();
  // A falling series so the trend filter reads bearish and shorts are allowed.
  const candles = makeCandles(WARMUP + 1, (i) => {
    if (i < WARMUP) {
      const close = 110 - i * 0.1;
      // Volume on the SIGNALLING bar (the last warmup bar, where this test's
      // strategy fires), not decoration. Shorts score lower than longs through
      // the checklist's macro block — a non-bear market withholds credit from
      // them — and since the daily-bias block stopped paying same-timeframe
      // trend as higher-timeframe confirmation, a with-trend short no longer
      // clears the 50-point floor on the strength of the trend alone. This bar
      // earns the full volume block instead, so the test goes on measuring
      // what it is about — which intra-bar extreme is tested first — rather
      // than whether a setup happens to be sized at all.
      return { open: close, high: close + 0.5, low: close - 0.5, close, volume: i === WARMUP - 1 ? 2000 : 1000 };
    }
    return { open: 104, high: 120, low: 90, close: 95, volume: 1000 };
  });

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: WARMUP - 1,
    strategy: onlyAtEntryBar("SHORT"),
    marketContext: FED_SHORT,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].closeReason, "STOP_LOSS");
  assert.ok(result.trades[0].pnl < 0);
  assert.equal(result.trades[0].exitPrice, 120);
});

test("a clean winning bar still books the win", async () => {
  const service = makeService();
  // Rises through TP1 (108.25) and TP2 (109.75) without ever reaching the
  // 104.5 stop, so pessimistic ordering has nothing to take away.
  const candles = trendingUpThen({ open: ENTRY_CLOSE, high: 111, low: 105.9, close: 110.5, volume: 1000 });

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: WARMUP - 1,
    strategy: onlyAtEntryBar("LONG"),
    marketContext: FED_LONG,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].closeReason, "TP2");
  assert.ok(result.trades[0].pnl > 0);
  // Both exits recorded: the TP1 scale-out and the TP2 remainder.
  assert.equal(result.trades[0].exits.length, 2);
});

test("open positions are marked before a new entry is considered", async () => {
  const service = makeService();
  const candles = makeCandles(WARMUP + 2, (i) => {
    if (i < WARMUP) {
      const close = 100 + i * 0.1;
      return { open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
    }
    if (i === WARMUP) return { open: ENTRY_CLOSE, high: 106.5, low: 105.5, close: 106, volume: 1000 };
    // The bar after that stops the position out; it must not survive to the
    // end of the run.
    return { open: 106, high: 106.5, low: 90, close: 95, volume: 1000 };
  });

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: WARMUP - 1,
    strategy: onlyAtEntryBar("LONG"),
    marketContext: FED_LONG,
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.openAtEnd.length, 0);
});

/* ── Honesty about the tail ───────────────────────────────── */

test("a position still open at the end is reported, not force-closed into the stats", async () => {
  const service = makeService();
  // The final bar drifts without reaching either the stop or a target, so the
  // position is still open when the candles run out.
  const candles = trendingUpThen({ open: ENTRY_CLOSE, high: 106.6, low: 105.6, close: 106.2, volume: 1000 });

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: WARMUP - 1,
    strategy: onlyAtEntryBar("LONG"),
    marketContext: FED_LONG,
  });

  assert.equal(result.openAtEnd.length, 1);
  assert.equal(result.trades.length, 0);
  assert.equal(result.stats.riskMetrics.closedTrades, 0);
});

test("refused candidates are recorded with the reasons they were refused", async () => {
  const service = makeService();
  const candles = makeCandles(80, (i) => ({
    close: 100,
    high: 100.5,
    low: 99.5,
    open: 100,
    volume: 1000,
  }));

  // A flat series makes the trend read neutral, so the regime gate has no
  // directional trend to permit — every candidate is refused, and says why.
  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: 60,
    strategy: () => "LONG",
  });

  assert.ok(result.skipped.length > 0);
  assert.ok(result.skipped[0].reasons.length > 0);
  assert.equal(result.trades.length + result.openAtEnd.length, 0);
});

/* ── The property that catches an optimistic backtester ───── */

// A driftless random walk has no trend to follow, so a trend-following
// strategy must not find an edge in one. If this test starts passing with a
// healthy profit factor, the backtester has developed a lookahead or an
// optimistic fill — that is far likelier than the strategy being good.
function randomWalk(seed, { bars: barCount = 600, drift = 0 } = {}) {
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const bars = [];
  let price = 60000;
  for (let i = 0; i < barCount; i += 1) {
    const move = price * (drift + (rnd() - 0.5) * 0.02);
    const open = price;
    const close = price + move;
    const wick = price * 0.006 * rnd();
    bars.push({
      openTime: i * 14400000,
      closeTime: (i + 1) * 14400000,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 900 + rnd() * 400,
    });
    price = close;
  }
  return bars;
}

test("a trend strategy finds no edge in a driftless random walk", async () => {
  const service = makeService();
  // Fed context, and not for convenience: this is the suite's load-bearing
  // test, and a null test that opens no trades asserts nothing at all. Without
  // a scored setup the loop below would `continue` past every seed and pass in
  // silence — the exact failure mode a lookahead regression would hide behind.
  // The `traded` counter makes that unfalsifiable rather than implicit.
  let traded = 0;

  for (const seed of [7, 42, 1234, 99999]) {
    const result = await service.run({
      symbol: "RNDUSDT",
      candles: randomWalk(seed),
      marketContext: FED_LONG,
    });
    const m = result.stats.riskMetrics;
    if (!m.closedTrades) continue;
    traded += m.closedTrades;

    assert.ok(
      m.expectancyR <= 0.15,
      `seed ${seed}: expectancy ${m.expectancyR}R on a random walk suggests lookahead or an optimistic fill`,
    );
    assert.ok(
      m.profitFactor === null || m.profitFactor < 1.5,
      `seed ${seed}: profit factor ${m.profitFactor} on a random walk suggests lookahead or an optimistic fill`,
    );
  }

  assert.ok(traded > 0, "no seed opened a trade — this null test proved nothing");
});

// The same null test, applied to every registered candle strategy rather than
// only the built-in default. A random walk has no edge in it for a trend
// follower OR a mean reverter, so any strategy showing one is evidence about
// the backtester, not about the strategy. New strategies are covered
// automatically: this reads the registry rather than a hardcoded list.
test("no registered strategy finds an edge in a driftless random walk", async () => {
  const service = makeService();
  const seeds = [7, 42, 1234, 4242, 99999];

  // Pooled across seeds, not asserted per seed. The selective strategies close
  // only a handful of trades per run, and at that sample size a single seed's
  // expectancy is noise — an individually-thresholded test would fail on an
  // unlucky seed and teach everyone to re-roll it until it passed, which is
  // worse than no test. Pooling R-multiples is the same question asked of a
  // sample big enough to answer it.
  for (const meta of listStrategies({ supportsBacktest: true })) {
    const rMultiples = [];
    for (const seed of seeds) {
      const result = await service.run({
        symbol: "RNDUSDT",
        candles: randomWalk(seed, { bars: 900 }),
        strategy: meta.id,
      });
      for (const trade of result.trades) {
        if (typeof trade.rMultiple === "number") rMultiples.push(trade.rMultiple);
      }
    }

    // Too few trades to say anything. Reported rather than silently passed, so
    // "no evidence" never reads as "passed the null test".
    if (rMultiples.length < 10) {
      console.log(`# ${meta.id}: only ${rMultiples.length} closed trades across ${seeds.length} random walks`);
      continue;
    }

    const expectancy = rMultiples.reduce((sum, r) => sum + r, 0) / rMultiples.length;
    assert.ok(
      expectancy <= 0.15,
      `${meta.id}: pooled expectancy ${expectancy.toFixed(3)}R over ${rMultiples.length} trades on driftless random walks — suggests lookahead or an optimistic fill`,
    );
  }
});

test("a strongly trending series is where a trend strategy is allowed to win", async () => {
  const service = makeService();
  // The same generator with real drift — proof the pessimistic fills have not
  // simply made every strategy lose, which would be its own kind of wrong.
  const result = await service.run({
    symbol: "TRNUSDT",
    candles: randomWalk(42, { drift: 0.004 }),
    marketContext: FED_LONG,
  });
  assert.ok(result.stats.riskMetrics.closedTrades > 0);
  assert.ok(result.stats.riskMetrics.expectancyR > 0);
});

/* ── Default strategy ─────────────────────────────────────── */

test("the default strategy only fires on a breakout of the PRIOR range", () => {
  const bars = makeCandles(40, (i) => ({ close: 100, high: 101, low: 99, open: 100, volume: 1000 }));
  const options = { breakoutLookback: 20, trendFast: 21, trendSlow: 55 };

  // Inside the prior range with no trend read — nothing to do.
  assert.equal(trendBreakoutStrategy({ bars, context: { timeframeTrendUp: null, close: 100 }, options }), null);
  // Above the prior high, but the trend is down — the rule does not fade.
  assert.equal(trendBreakoutStrategy({ bars, context: { timeframeTrendUp: false, close: 110 }, options }), null);
  // Above the prior high with an up trend.
  assert.equal(trendBreakoutStrategy({ bars, context: { timeframeTrendUp: true, close: 110 }, options }), "LONG");
  // Below the prior low with a down trend.
  assert.equal(trendBreakoutStrategy({ bars, context: { timeframeTrendUp: false, close: 90 }, options }), "SHORT");
  // Matching the prior high exactly is not a break of it.
  assert.equal(trendBreakoutStrategy({ bars, context: { timeframeTrendUp: true, close: 101 }, options }), null);
  // It reads the timeframe's own trend and nothing else: a higher-timeframe
  // field is not a substitute for the one this rule is defined on.
  assert.equal(trendBreakoutStrategy({ bars, context: { htfTrendUp: true, close: 110 }, options }), null);
});

test("backtestSymbol reports clearly when no candle source is wired up", async () => {
  const service = new BacktestService({ config });
  await assert.rejects(
    () => service.backtestSymbol({ symbol: "BTCUSDT" }),
    (err) => err.statusCode === 503,
  );
});

test("backtestSymbol pulls candles from the screener it was given", async () => {
  const candles = risingCandles(200);
  const service = new BacktestService({
    config,
    signalScreenerService: { getCandles: async () => candles },
  });
  const result = await service.backtestSymbol({ symbol: "ETHUSDT", interval: "1h" });
  assert.equal(result.symbol, "ETHUSDT");
  assert.equal(result.interval, "1h");
  assert.equal(result.bars, 200);
});

/* ── Comparison payload: the chart series ─────────────────── */

// A trending series with pullbacks, so both strategies actually trade.
function trendingCandlesForCompare(count) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 0.2 + Math.sin(i / 9) * 4;
    bars.push({
      openTime: i * 900000,
      closeTime: (i + 1) * 900000 - 1,
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + (i % 7) * 100,
    });
  }
  return bars;
}

test("downsampling a curve keeps both endpoints and caps the point count", () => {
  const curve = [];
  for (let i = 0; i < 1000; i += 1) curve.push({ at: i, equity: i });

  const out = downsampleCurve(curve, 120);
  assert.equal(out.length, 120);
  // The endpoints are the two points a reader measures the run by, so they
  // must survive exactly rather than being averaged into a neighbour.
  assert.deepEqual(out[0], curve[0]);
  assert.deepEqual(out[out.length - 1], curve[curve.length - 1]);
  // Monotonic and in order — a shuffled or duplicated curve would draw a
  // plausible-looking line that is not the run.
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i].at > out[i - 1].at);

  // Short curves are passed through untouched rather than padded.
  const short = curve.slice(0, 40);
  assert.equal(downsampleCurve(short, 120), short);
  assert.deepEqual(downsampleCurve(null, 120), []);
});

test("a comparison carries an equity curve per strategy for the charts", async () => {
  const candles = trendingCandlesForCompare(400);
  const service = new BacktestService({
    config,
    signalScreenerService: { getCandles: async () => candles },
  });

  const comparison = await service.compare({
    symbol: "BTCUSDT",
    interval: "15m",
    strategies: ["mindset_v1", "donchian_breakout_v1"],
  });

  for (const row of comparison.results) {
    assert.ok(Array.isArray(row.equityCurve), `${row.strategy} is missing its equity curve`);
    assert.ok(row.equityCurve.length <= 120, "the curve must be thinned before it goes over the wire");
    for (const point of row.equityCurve) {
      assert.equal(typeof point.equity, "number");
      assert.ok(point.at);
      // Display payload only: nothing else from the full curve rides along.
      assert.deepEqual(Object.keys(point).sort(), ["at", "equity"]);
    }
  }
});

test("the experiment record is unaffected by the chart series", () => {
  // summarizeRun is what gets persisted, and a few thousand equity points per
  // stored experiment is a different decision from drawing a chart. The curve
  // is attached beside it in compare(), never inside it.
  const summary = summarizeRun({
    strategy: "x",
    strategyName: "X",
    symbol: "BTCUSDT",
    interval: "4h",
    bars: 10,
    warmupBars: 1,
    signals: [],
    openAtEnd: [],
    costs: {},
    stats: { winRate: 0, riskMetrics: {} },
    equityCurve: [{ at: 1, equity: 2, balance: 2, close: 3, openPositions: 0 }],
  });
  assert.equal(summary.equityCurve, undefined);
});

/* ── Execution modes ──────────────────────────────────────── */

// A strategy with levels far from anything planTrade would pick, so a result
// produced under native execution cannot be confused with a shared one.
function nativeLevelStrategy({ stopHint, targetHint, at = 80 } = {}) {
  return {
    id: "native_test",
    name: "Native test",
    version: "1.0.0",
    status: "backtest",
    supportsBacktest: true,
    supportsLiveScanner: false,
    description: "test",
    requiredWarmupBars: 0,
    evaluate(candles, index) {
      const price = candles[index].close;
      if (index !== at) {
        return { signal: "FLAT", strategy: "native_test", price, error: null, reasons: [], indicators: {}, confidence: null, stopHint: null, targetHint: null };
      }
      return {
        signal: "LONG",
        strategy: "native_test",
        price,
        error: null,
        reasons: [],
        indicators: {},
        confidence: null,
        stopHint: typeof stopHint === "function" ? stopHint(price) : stopHint,
        targetHint: typeof targetHint === "function" ? targetHint(price) : targetHint,
      };
    },
  };
}

test("shared execution ignores the strategy's own levels — that is the point of it", async () => {
  const service = makeService();
  const strategy = nativeLevelStrategy({ stopHint: (p) => p * 0.5, targetHint: (p) => p * 1.5 });
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: risingCandles(200),
    strategy,
    marketContext: FED_LONG,
  });

  const positions = [...result.trades, ...result.openAtEnd];
  assert.equal(positions.length, 1);
  assert.equal(result.executionMode, "shared");
  // planTrade's levels, not the strategy's half-price stop.
  assert.ok(positions[0].stopLoss > positions[0].entryPrice * 0.9);
  // The hints are still recorded, so the run remains auditable.
  assert.equal(positions[0].meta.stopHint, positions[0].entryPrice * 0.5);
  assert.equal(positions[0].meta.executionMode, "shared");
});

test("native execution uses the strategy's own stop and target", async () => {
  const service = makeService();
  // The target is deliberately out of reach of this series. Once TP1 fires the
  // paper trader moves the stop to breakeven, so a CLOSED position no longer
  // reports the level it opened with — the only honest place to read the
  // native stop is a position that never hit anything.
  const strategy = nativeLevelStrategy({ stopHint: (p) => p * 0.5, targetHint: (p) => p * 5 });
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: risingCandles(200),
    strategy,
    executionMode: "native",
    marketContext: FED_LONG,
  });

  const positions = [...result.trades, ...result.openAtEnd];
  assert.equal(positions.length, 1);
  assert.equal(result.openAtEnd.length, 1, "the far target keeps this position open to the end");
  assert.equal(result.executionMode, "native");
  assert.equal(positions[0].stopLoss, positions[0].entryPrice * 0.5);
  // One target, not two: the strategy named a single level, so the position
  // closes fully there rather than at an invented further one.
  assert.equal(positions[0].tp1, positions[0].entryPrice * 5);
  assert.equal(positions[0].tp2, positions[0].entryPrice * 5);
  assert.equal(positions[0].meta.executionMode, "native");
});

test("native execution keeps the dollar risk identical to shared execution", async () => {
  // Otherwise a mode comparison would be measuring position size rather than
  // exit rules: a wider native stop must buy a smaller position, not more risk.
  const service = makeService();
  const strategy = nativeLevelStrategy({ stopHint: (p) => p * 0.5, targetHint: (p) => p * 5 });

  const shared = await service.run({
    symbol: "BTCUSDT",
    candles: risingCandles(200),
    strategy,
    marketContext: FED_LONG,
  });
  const native = await service.run({
    symbol: "BTCUSDT",
    candles: risingCandles(200),
    strategy,
    executionMode: "native",
    marketContext: FED_LONG,
  });

  const s = [...shared.trades, ...shared.openAtEnd][0];
  const n = [...native.trades, ...native.openAtEnd][0];
  assert.equal(s.riskUsd, n.riskUsd);
  // `size` is what REMAINS, and a position that closed has none left — the
  // size these two were opened with is initialSize. The wider native stop must
  // buy a smaller position, which is how identical risk is preserved.
  assert.ok(
    n.initialSize < s.initialSize,
    `native size ${n.initialSize} should be smaller than shared ${s.initialSize}`,
  );
});

test("a native run that cannot get native levels says so instead of pretending", async () => {
  const service = makeService();
  // mindset_v1 publishes no hints at all, so a "native" run of it is really a
  // shared run. Silence here would be the most misreadable outcome in the
  // module: a result labelled native that used planTrade's levels throughout.
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: trendingCandlesForCompare(400),
    strategy: "mindset_v1",
    executionMode: "native",
    marketContext: FED_LONG,
  });

  const positions = [...result.trades, ...result.openAtEnd];
  assert.ok(positions.length > 0, "expected the trending series to open something");
  assert.equal(result.nativeFallbacks, positions.length);
  assert.ok(result.caveats.some((c) => /ran on SHARED execution despite executionMode=native/.test(c)));
  positions.forEach((p) => assert.equal(p.meta.executionMode, "shared"));
});

test("a hint on the wrong side of the entry is refused, not traded", async () => {
  const service = makeService();
  // A long whose "stop" sits above the entry would fill instantly and book a
  // result. It falls back to shared levels and is counted.
  const strategy = nativeLevelStrategy({ stopHint: (p) => p * 1.2, targetHint: (p) => p * 5 });
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: risingCandles(200),
    strategy,
    executionMode: "native",
    marketContext: FED_LONG,
  });

  const positions = [...result.trades, ...result.openAtEnd];
  assert.equal(result.nativeFallbacks, positions.length);
  positions.forEach((p) => assert.equal(p.meta.executionMode, "shared"));
  // The bad hint is still recorded — it is evidence about the strategy — but
  // it was not traded: the position took planTrade's levels instead.
  assert.ok(positions[0].meta.stopHint > positions[0].entryPrice, "the hint really was on the wrong side");
  assert.notEqual(positions[0].meta.stopHint, positions[0].stopLoss);
});

test("an unknown execution mode is a 400, never a silent default", async () => {
  const service = makeService();
  await assert.rejects(
    () => service.run({ symbol: "BTCUSDT", candles: risingCandles(200), executionMode: "sideways" }),
    (err) => err.statusCode === 400 && /Unknown executionMode/.test(err.message),
  );
});

test("the execution mode is recorded on the experiment summary", () => {
  const summary = summarizeRun({
    strategy: "x",
    strategyName: "X",
    symbol: "BTCUSDT",
    interval: "4h",
    bars: 10,
    warmupBars: 1,
    signals: [],
    openAtEnd: [],
    costs: {},
    executionMode: "native",
    nativeFallbacks: 2,
    stats: { winRate: 0, riskMetrics: {} },
  });
  // Two experiments recorded under different modes are not comparable, so the
  // record has to carry which one produced it.
  assert.equal(summary.executionMode, "native");
  assert.equal(summary.nativeFallbacks, 2);
});

/* ── Comparison ranking ───────────────────────────────────── */

test("a strategy that never traded cannot outrank one that did", () => {
  const rows = [
    { strategy: "traded", closedTrades: 12, expectancyR: 0.4, profitFactor: 1.8, maxDrawdownPct: 9 },
    // The old comparator substituted 999 for a null profit factor regardless
    // of why it was null, which floated this row to the top of the table.
    { strategy: "never_traded", closedTrades: 0, expectancyR: 0, profitFactor: null, maxDrawdownPct: 0 },
    { strategy: "no_data", status: "insufficient-data", closedTrades: 0, expectancyR: 0, profitFactor: null, maxDrawdownPct: 0 },
  ];

  const ranked = rankRows(rows);
  assert.equal(ranked[0].strategy, "traded");
  assert.equal(ranked[0].rankable, true);
  assert.equal(ranked[0].unrankedReason, null);

  const unranked = ranked.slice(1);
  unranked.forEach((row) => assert.equal(row.rankable, false));
  // Kept rather than dropped: a strategy that ran and refused everything is a
  // finding, not an absence.
  assert.deepEqual(unranked.map((r) => r.strategy).sort(), ["never_traded", "no_data"]);
  assert.match(ranked.find((r) => r.strategy === "no_data").unrankedReason, /insufficient data/);
});

test("an undefeated strategy still ranks above a merely profitable one", () => {
  // The other meaning of a null profit factor: wins and no losses. That one IS
  // infinity, and must not be lost in the fix for the zero-trade case.
  const ranked = rankRows([
    { strategy: "profitable", closedTrades: 10, expectancyR: 0.5, profitFactor: 2.2, maxDrawdownPct: 5 },
    { strategy: "undefeated", closedTrades: 4, expectancyR: 0.5, profitFactor: null, maxDrawdownPct: 1 },
  ]);
  assert.equal(ranked[0].strategy, "undefeated");
  assert.equal(ranked[0].rankable, true);
});

test("the minimum ranked trade count is enforceable", () => {
  const ranked = rankRows(
    [
      { strategy: "thin", closedTrades: 3, expectancyR: 2, profitFactor: 9, maxDrawdownPct: 1 },
      { strategy: "thick", closedTrades: 40, expectancyR: 0.2, profitFactor: 1.2, maxDrawdownPct: 8 },
    ],
    10,
  );
  // A spectacular three-trade sample is not evidence, and at a threshold of 10
  // it does not get to sit at the top of the table.
  assert.equal(ranked[0].strategy, "thick");
  assert.equal(ranked[1].rankable, false);
  assert.match(ranked[1].unrankedReason, /3 closed trade\(s\), needs 10/);
});

/* ── Strategy option validation and dynamic warmup ────────── */

test("a bad strategy option is a 400 naming the option, not a 500", async () => {
  const service = makeService();
  await assert.rejects(
    () =>
      service.run({
        symbol: "BTCUSDT",
        candles: risingCandles(300),
        strategy: "donchian_breakout_v1",
        options: { channelLength: 0 },
      }),
    (err) => err.statusCode === 400 && /channelLength must be at least 2/.test(err.message),
  );

  await assert.rejects(
    () =>
      service.run({
        symbol: "BTCUSDT",
        candles: risingCandles(300),
        strategy: "vwap_reversion_v1",
        options: { anchor: "fortnight" },
      }),
    (err) => err.statusCode === 400 && /anchor must be/.test(err.message),
  );
});

test("warmup is recalculated from the options actually supplied", async () => {
  const service = makeService();
  // A 400-bar channel needs far more than donchian's default 102-bar warmup.
  // Before this, the run reserved 102 and the channel loop read off the front
  // of the array — a TypeError surfacing as a 500.
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: risingCandles(700),
    strategy: "donchian_breakout_v1",
    options: { channelLength: 400 },
  });
  assert.ok(result.warmupBars >= 402, `expected the warmup to grow, got ${result.warmupBars}`);

  // And when the data cannot cover it, the answer is a 400 about candles
  // rather than a crash.
  await assert.rejects(
    () =>
      service.run({
        symbol: "BTCUSDT",
        candles: risingCandles(300),
        strategy: "donchian_breakout_v1",
        options: { channelLength: 400 },
      }),
    (err) => err.statusCode === 400 && /Not enough candles/.test(err.message),
  );
});
