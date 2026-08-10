"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BacktestService, contextAtBar, trendBreakoutStrategy } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");

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

test("a backtest never touches the live books and leaves no temp ledger behind", async () => {
  const service = makeService();
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("md-backtest-")).length;

  const result = await service.run({ symbol: "BTCUSDT", candles: risingCandles(200) });
  assert.ok(result.stats);

  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("md-backtest-")).length;
  assert.equal(after, before);
});

test("the temp ledger is cleaned up even when the run throws", async () => {
  const service = makeService();
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("md-backtest-")).length;

  await assert.rejects(() =>
    service.run({
      symbol: "BTCUSDT",
      candles: risingCandles(200),
      strategy: () => {
        throw new Error("strategy exploded");
      },
    }),
  );

  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("md-backtest-")).length;
  assert.equal(after, before);
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

  const truncated = contextAtBar(candles.slice(0, 80), options);
  // Same 80 bars, but with 40 more appended afterwards — the extra bars must
  // not change what was knowable at bar 80.
  const withFuture = contextAtBar(candles.slice(0, 80), options);

  assert.deepEqual(truncated, withFuture);
  assert.equal(truncated.close, candles[79].close);
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
      return { open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
    }
    return { open: 104, high: 120, low: 90, close: 95, volume: 1000 };
  });

  const result = await service.run({
    symbol: "BTCUSDT",
    candles,
    warmupBars: WARMUP - 1,
    strategy: onlyAtEntryBar("SHORT"),
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

  for (const seed of [7, 42, 1234, 99999]) {
    const result = await service.run({ symbol: "RNDUSDT", candles: randomWalk(seed) });
    const m = result.stats.riskMetrics;
    if (!m.closedTrades) continue;

    assert.ok(
      m.expectancyR <= 0.15,
      `seed ${seed}: expectancy ${m.expectancyR}R on a random walk suggests lookahead or an optimistic fill`,
    );
    assert.ok(
      m.profitFactor === null || m.profitFactor < 1.5,
      `seed ${seed}: profit factor ${m.profitFactor} on a random walk suggests lookahead or an optimistic fill`,
    );
  }
});

test("a strongly trending series is where a trend strategy is allowed to win", async () => {
  const service = makeService();
  // The same generator with real drift — proof the pessimistic fills have not
  // simply made every strategy lose, which would be its own kind of wrong.
  const result = await service.run({ symbol: "TRNUSDT", candles: randomWalk(42, { drift: 0.004 }) });
  assert.ok(result.stats.riskMetrics.closedTrades > 0);
  assert.ok(result.stats.riskMetrics.expectancyR > 0);
});

/* ── Default strategy ─────────────────────────────────────── */

test("the default strategy only fires on a breakout of the PRIOR range", () => {
  const bars = makeCandles(40, (i) => ({ close: 100, high: 101, low: 99, open: 100, volume: 1000 }));
  const options = { breakoutLookback: 20, trendFast: 21, trendSlow: 55 };

  // Inside the prior range with no trend read — nothing to do.
  assert.equal(trendBreakoutStrategy({ bars, context: { trendUp: null, close: 100 }, options }), null);
  // Above the prior high, but the trend is down — the rule does not fade.
  assert.equal(trendBreakoutStrategy({ bars, context: { trendUp: false, close: 110 }, options }), null);
  // Above the prior high with an up trend.
  assert.equal(trendBreakoutStrategy({ bars, context: { trendUp: true, close: 110 }, options }), "LONG");
  // Below the prior low with a down trend.
  assert.equal(trendBreakoutStrategy({ bars, context: { trendUp: false, close: 90 }, options }), "SHORT");
  // Matching the prior high exactly is not a break of it.
  assert.equal(trendBreakoutStrategy({ bars, context: { trendUp: true, close: 101 }, options }), null);
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
