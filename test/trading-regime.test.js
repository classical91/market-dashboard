"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  REGIMES,
  REGIME_DEFAULTS,
  classifyRegime,
  classifyAt,
  buildRegimeSeries,
  toChecklistRegime,
  warmupFor,
} = require("../src/services/trading/regime");
const { buildRegimeMatrix, verdictFor, regimeKey } = require("../src/services/trading/regime-metrics");
const { routeRegime } = require("../src/services/trading/regime-router");
const { marketState } = require("../src/services/trading/checklist");
const { buildStrategyMetrics } = require("../src/services/trading/metrics");
const { BacktestService } = require("../src/services/trading/backtest");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");

function bar(i, { close, high, low, volume = 1000 }) {
  return {
    openTime: i * 3600000,
    closeTime: (i + 1) * 3600000 - 1,
    open: close,
    high,
    low,
    close,
    volume,
  };
}

// A clean, persistent uptrend: every bar closes higher, so ADX builds and the
// fast EMA pulls away from the slow one.
function uptrend(count, { start = 100, step = 1.2, volume = 1000 } = {}) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = start + i * step;
    bars.push(bar(i, { close, high: close + step * 0.4, low: close - step * 0.4, volume }));
  }
  return bars;
}

function downtrend(count, opts = {}) {
  return uptrend(count, { ...opts, step: -(opts.step || 1.2), start: opts.start || 400 });
}

// Chop with no net direction: ADX collapses, the EMAs sit on top of each other.
function chop(count, { start = 100, amplitude = 2, volume = 1000 } = {}) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = start + Math.sin(i / 2) * amplitude;
    bars.push(bar(i, { close, high: close + amplitude * 0.3, low: close - amplitude * 0.3, volume }));
  }
  return bars;
}

/* ── Vocabulary and warmup ────────────────────────────────── */

test("the regime vocabulary keeps the original labels and adds the new ones", () => {
  for (const label of ["TREND_UP", "TREND_DOWN", "RANGE", "VOLATILE_EXPANSION", "LOW_COMPRESSION", "UNKNOWN"]) {
    assert.ok(REGIMES.includes(label), `${label} must survive`);
  }
  for (const label of ["ACCUMULATION", "DISTRIBUTION", "TRANSITION"]) {
    assert.ok(REGIMES.includes(label), `${label} must be added`);
  }
});

test("too little history is UNKNOWN, not a guess", () => {
  const read = classifyRegime(chop(20));
  assert.equal(read.regime, "UNKNOWN");
  assert.equal(read.confidence, 0);
  assert.equal(read.actionable, false);
  assert.match(read.reasons[0], /Need at least/);
});

test("no candles at all is UNKNOWN rather than a throw", () => {
  assert.equal(classifyRegime([]).regime, "UNKNOWN");
  assert.equal(classifyRegime(null).regime, "UNKNOWN");
});

test("warmup covers the slowest indicator the engine uses", () => {
  const needed = warmupFor();
  assert.ok(needed >= REGIME_DEFAULTS.adxLen * 3);
  assert.ok(needed >= REGIME_DEFAULTS.emaSlowLen + 1);
});

/* ── The lookahead barrier ────────────────────────────────── */

test("a regime read at bar i uses only bars 0..i", () => {
  const bars = uptrend(200);
  const series = buildRegimeSeries(bars);

  for (const index of [80, 120, 199]) {
    const withFuture = classifyAt(bars, index, { series });
    const withoutFuture = classifyRegime(bars.slice(0, index + 1));

    assert.equal(withFuture.regime, withoutFuture.regime, `regime at ${index}`);
    assert.equal(withFuture.confidence, withoutFuture.confidence, `confidence at ${index}`);
    assert.deepEqual(withFuture.indicators, withoutFuture.indicators, `indicators at ${index}`);
  }
});

test("a violent future bar cannot change an earlier read", () => {
  const bars = uptrend(150);
  const spiked = bars.map((b, i) =>
    i === 149 ? { ...b, high: b.high * 3, low: b.low / 3, close: b.close * 2 } : b,
  );

  const before = classifyAt(bars, 120, { series: buildRegimeSeries(bars) });
  const after = classifyAt(spiked, 120, { series: buildRegimeSeries(spiked) });
  assert.deepEqual(after.indicators, before.indicators);
  assert.equal(after.regime, before.regime);
});

/* ── Classification ───────────────────────────────────────── */

test("a persistent uptrend reads as TREND_UP with a long bias", () => {
  const read = classifyRegime(uptrend(200));
  assert.equal(read.regime, "TREND_UP");
  assert.equal(read.direction, "UP");
  assert.equal(read.bias, "LONG");
  assert.equal(read.preferredMode, "TREND_FOLLOWING");
  assert.ok(read.confidence > 50, `expected a confident read, got ${read.confidence}`);
  assert.ok(read.indicators.adx >= REGIME_DEFAULTS.adxTrendMin);
});

test("a persistent downtrend reads as TREND_DOWN", () => {
  const read = classifyRegime(downtrend(200));
  assert.equal(read.regime, "TREND_DOWN");
  assert.equal(read.direction, "DOWN");
  assert.equal(read.bias, "SHORT");
});

test("directionless chop reads as a range, not a trend", () => {
  const read = classifyRegime(chop(200));
  assert.ok(
    ["RANGE", "ACCUMULATION", "DISTRIBUTION", "LOW_COMPRESSION"].includes(read.regime),
    `expected a range-family regime, got ${read.regime}`,
  );
  assert.notEqual(read.preferredMode, "TREND_FOLLOWING");
});

test("a range reports no trend, whichever way its moving averages happen to sit", () => {
  // The fast EMA has to sit on one side of the slow one, and in a range which
  // side that is carries no information. Reporting it as a direction next to a
  // RANGE label would state a trend the engine just measured the absence of.
  const read = classifyRegime(chop(200));
  assert.equal(read.trend, "NEUTRAL");
  assert.ok(["UP", "DOWN", "NEUTRAL"].includes(read.direction), "the raw EMA read is still available");
  assert.ok(read.indicators.adx < REGIME_DEFAULTS.adxRangeMax);
});

test("a trend reports its direction as the trend", () => {
  assert.equal(classifyRegime(uptrend(200)).trend, "UP");
  assert.equal(classifyRegime(downtrend(200)).trend, "DOWN");
});

test("a volatility blowout outranks the trend read", () => {
  const bars = uptrend(200);
  // Three bars of several times the usual range, which is what an expansion is.
  for (let i = 197; i < 200; i += 1) {
    const b = bars[i];
    bars[i] = { ...b, high: b.close + 40, low: b.close - 40, volume: 5000 };
  }
  const read = classifyRegime(bars);
  assert.equal(read.regime, "VOLATILE_EXPANSION");
  assert.equal(read.riskPosture, "REDUCED");
  assert.equal(read.actionable, false, "an expansion is a sizing problem, not a selection one");
});

// A label that can never fire is a bug, not a feature — these three exist to
// prove each new regime is actually reachable from real candle geometry rather
// than only from a hand-built read object.

test("a quiet range worked from its lows on heavy volume reads as ACCUMULATION", () => {
  const bars = [];
  for (let i = 0; i < 200; i += 1) {
    // A range whose floor lifts late, finishing near the bottom of its own
    // structure with volume in it.
    let close = 100 + Math.sin(i / 2) * 3;
    if (i > 175) close += (i - 175) * 0.05;
    if (i >= 198) close = 99 + (i - 198) * 0.1;
    bars.push(bar(i, { close, high: close + 0.9, low: close - 0.9, volume: i > 194 ? 2200 : 1000 }));
  }

  const read = classifyRegime(bars);
  assert.equal(read.regime, "ACCUMULATION");
  assert.equal(read.bias, "LONG");
  assert.equal(read.structure.higherLows, true);
  assert.ok(read.structure.position <= REGIME_DEFAULTS.edgeFraction);
});

test("the mirror image reads as DISTRIBUTION", () => {
  const bars = [];
  for (let i = 0; i < 200; i += 1) {
    let close = 100 + Math.sin(i / 2) * 3;
    if (i > 175) close -= (i - 175) * 0.05;
    if (i >= 198) close = 101 + (i - 198) * 0.1;
    bars.push(bar(i, { close, high: close + 0.9, low: close - 0.9, volume: i > 194 ? 2200 : 1000 }));
  }

  const read = classifyRegime(bars);
  assert.equal(read.regime, "DISTRIBUTION");
  assert.equal(read.bias, "SHORT");
  assert.equal(read.structure.lowerHighs, true);
});

test("a collapsing range reads as LOW_COMPRESSION and forbids trading", () => {
  const bars = [];
  for (let i = 0; i < 200; i += 1) {
    const quiet = i > 170;
    const amplitude = quiet ? 0.15 : 3;
    const close = 100 + Math.sin(i / 2) * amplitude;
    bars.push(bar(i, { close, high: close + amplitude * 0.3, low: close - amplitude * 0.3, volume: quiet ? 600 : 1000 }));
  }

  const read = classifyRegime(bars);
  assert.equal(read.regime, "LOW_COMPRESSION");
  assert.equal(read.riskPosture, "NONE");
  assert.equal(read.actionable, false);
  assert.ok(read.indicators.atrRatio <= REGIME_DEFAULTS.compressionAtrRatio);
});

test("TRANSITION is returned when trend strength sits between the thresholds", () => {
  const bars = uptrend(200);
  const adx = classifyRegime(bars).indicators.adx;

  // Move the thresholds around the measured ADX rather than hunting for a
  // candle series that lands in the gap: the behaviour under test is the gap
  // itself, not any particular market.
  const read = classifyRegime(bars, { adxRangeMax: adx - 5, adxTrendMin: adx + 5 });
  assert.equal(read.regime, "TRANSITION");
  assert.equal(read.actionable, false);
  assert.equal(read.preferredMode, "NONE");
  assert.match(read.action, /NO TRADE/);
});

test("a read under the confidence floor is not actionable even with a real label", () => {
  const bars = uptrend(200);
  const read = classifyRegime(bars, { minConfidence: 101 });
  assert.equal(read.regime, "TREND_UP");
  assert.equal(read.actionable, false);
  assert.ok(read.reasons.some((r) => /under the .* floor/.test(r)));
});

/* ── The checklist boundary ───────────────────────────────── */

test("the engine never hands the checklist a label it does not understand", () => {
  // The five labels the checklist's regime gate is written against, plus the
  // UNKNOWN it defaults to. Anything outside this set would fall through every
  // branch of the gate and silently trade as if unconstrained.
  const known = new Set(["TREND_UP", "TREND_DOWN", "RANGE", "VOLATILE_EXPANSION", "LOW_COMPRESSION", "UNKNOWN"]);
  assert.equal(marketState().regime, "UNKNOWN", "the checklist still defaults to UNKNOWN");

  for (const regime of REGIMES) {
    assert.ok(
      known.has(toChecklistRegime(regime)),
      `${regime} maps to ${toChecklistRegime(regime)}, which the checklist does not know`,
    );
  }
});

test("the new labels map to RANGE rather than to a blocking regime", () => {
  // Mapping TRANSITION onto LOW_COMPRESSION would smuggle a trading policy into
  // a translation function — LOW_COMPRESSION blocks entries outright.
  for (const regime of ["ACCUMULATION", "DISTRIBUTION", "TRANSITION"]) {
    assert.equal(toChecklistRegime(regime), "RANGE");
  }
});

/* ── The evidence table ───────────────────────────────────── */

function trade({ strategy, regime, r, confidence = 70 }) {
  return {
    status: "closed",
    signalSource: strategy,
    symbol: "BTCUSDT",
    realizedPnl: r * 100,
    rMultiple: r,
    confidenceScore: confidence,
    meta: regime ? { regime, regimeConfidence: confidence } : {},
  };
}

test("trades are grouped by the regime they were opened in", () => {
  const history = [
    ...Array.from({ length: 3 }, () => trade({ strategy: "vwap", regime: "RANGE", r: 0.4 })),
    ...Array.from({ length: 2 }, () => trade({ strategy: "vwap", regime: "TREND_UP", r: -0.2 })),
  ];

  const matrix = buildRegimeMatrix(history, 10000, { minTrades: 2 });
  const row = matrix.rows.find((r) => r.strategy === "vwap");

  assert.equal(row.cells.RANGE.closedTrades, 3);
  assert.ok(row.cells.RANGE.expectancyR > 0);
  assert.equal(row.cells.TREND_UP.closedTrades, 2);
  assert.ok(row.cells.TREND_UP.expectancyR < 0);
  // The pooled figure averages the two and says less than either.
  assert.notEqual(row.summary.expectancyR, row.cells.RANGE.expectancyR);
});

test("untagged history is reported, never folded into a real regime", () => {
  const history = [
    trade({ strategy: "vwap", regime: "RANGE", r: 0.4 }),
    trade({ strategy: "vwap", regime: null, r: 0.4 }),
  ];

  const matrix = buildRegimeMatrix(history, 10000, { minTrades: 1 });
  const row = matrix.rows.find((r) => r.strategy === "vwap");

  assert.equal(row.cells.RANGE.closedTrades, 1);
  assert.equal(row.cells.UNTAGGED.closedTrades, 1);
  assert.equal(matrix.coverage.untagged, 1);
  assert.equal(matrix.coverage.taggedPct, 50);
});

test("an unrecognised regime label is treated as untagged rather than trusted", () => {
  assert.equal(regimeKey({ meta: { regime: "MOON_PHASE" } }), "UNTAGGED");
  assert.equal(regimeKey({ meta: { regime: "RANGE" } }), "RANGE");
});

test("a thin cell is marked insufficient rather than dropped", () => {
  const history = Array.from({ length: 4 }, () => trade({ strategy: "vwap", regime: "TREND_UP", r: 0.9 }));
  const matrix = buildRegimeMatrix(history, 10000, { minTrades: 20 });

  const cell = matrix.rows[0].cells.TREND_UP;
  assert.equal(cell.closedTrades, 4, "the trades are still visible");
  assert.equal(cell.sufficient, false, "four trades is not evidence");

  const { verdict } = verdictFor(matrix, "vwap", "TREND_UP");
  assert.equal(verdict, "INSUFFICIENT", "a profitable but tiny sample is not FAVOURABLE");
});

test("never having traded in a regime is INSUFFICIENT, not UNFAVOURABLE", () => {
  const history = Array.from({ length: 30 }, () => trade({ strategy: "vwap", regime: "RANGE", r: 0.4 }));
  const matrix = buildRegimeMatrix(history, 10000, { minTrades: 20 });

  assert.equal(verdictFor(matrix, "vwap", "RANGE").verdict, "FAVOURABLE");
  assert.equal(verdictFor(matrix, "vwap", "TREND_DOWN").verdict, "INSUFFICIENT");
});

test("the standard metrics grouping gained a regime dimension", () => {
  const history = [
    trade({ strategy: "vwap", regime: "RANGE", r: 0.4 }),
    trade({ strategy: "vwap", regime: null, r: 0.1 }),
  ];
  const groups = buildStrategyMetrics(history, 10000).groups;
  assert.ok(groups.regime, "a regime dimension exists");
  assert.deepEqual(groups.regime.map((r) => r.key).sort(), ["RANGE", "UNTAGGED"]);
});

/* ── Routing ──────────────────────────────────────────────── */

function matrixFor(cells, minTrades = 20) {
  const history = [];
  for (const [strategy, regimes] of Object.entries(cells)) {
    for (const [regime, { r, count }] of Object.entries(regimes)) {
      for (let i = 0; i < count; i += 1) history.push(trade({ strategy, regime, r }));
    }
  }
  return buildRegimeMatrix(history, 10000, { minTrades });
}

test("TRANSITION selects no strategy at all", () => {
  const read = { regime: "TRANSITION", confidence: 80, actionable: false, reasons: [], options: REGIME_DEFAULTS };
  const routing = routeRegime({ read, matrix: matrixFor({}) });

  assert.equal(routing.preferred, null);
  assert.deepEqual(routing.eligible, []);
  assert.deepEqual(routing.suppressed, [], "nothing is suppressed for cause — the environment is unreadable");
  assert.ok(routing.held.length > 0, "every candidate is held instead");
  assert.match(routing.reasons[0], /TRANSITION/);
});

test("a low-confidence read routes like a transition", () => {
  const read = { regime: "RANGE", confidence: 30, actionable: false, reasons: [], options: REGIME_DEFAULTS };
  const routing = routeRegime({ read, matrix: matrixFor({}) });
  assert.equal(routing.preferred, null);
  assert.match(routing.reasons[0], /under the floor/);
});

test("routing prefers the strategy with the best measured expectancy in this regime", () => {
  const read = { regime: "RANGE", confidence: 82, actionable: true, action: "WAIT / MEAN REVERSION", reasons: [], options: REGIME_DEFAULTS };
  const matrix = matrixFor({
    vwap_reversion_v1: { RANGE: { r: 0.41, count: 30 }, TREND_UP: { r: -0.21, count: 30 } },
    donchian_breakout_v1: { RANGE: { r: -0.31, count: 30 }, TREND_UP: { r: 0.47, count: 30 } },
  });

  const routing = routeRegime({
    read,
    matrix,
    strategies: ["vwap_reversion_v1", "donchian_breakout_v1"],
  });

  assert.equal(routing.preferred.strategy, "vwap_reversion_v1");
  assert.deepEqual(routing.suppressed.map((c) => c.strategy), ["donchian_breakout_v1"]);
  assert.match(routing.reasons.join(" "), /wrong regime/);
});

test("the same evidence routes the other way in a trend", () => {
  const read = { regime: "TREND_UP", confidence: 75, actionable: true, action: "TREND CONTINUATION", reasons: [], options: REGIME_DEFAULTS };
  const matrix = matrixFor({
    vwap_reversion_v1: { RANGE: { r: 0.41, count: 30 }, TREND_UP: { r: -0.21, count: 30 } },
    donchian_breakout_v1: { RANGE: { r: -0.31, count: 30 }, TREND_UP: { r: 0.47, count: 30 } },
  });

  const routing = routeRegime({ read, matrix, strategies: ["vwap_reversion_v1", "donchian_breakout_v1"] });
  assert.equal(routing.preferred.strategy, "donchian_breakout_v1");
  assert.deepEqual(routing.suppressed.map((c) => c.strategy), ["vwap_reversion_v1"]);
});

test("routing is advisory and never claims scanner eligibility", () => {
  const read = { regime: "RANGE", confidence: 82, actionable: true, action: "WAIT", reasons: [], options: REGIME_DEFAULTS };
  const matrix = matrixFor({ vwap_reversion_v1: { RANGE: { r: 0.41, count: 30 } } });
  const routing = routeRegime({ read, matrix, strategies: ["vwap_reversion_v1"] });

  assert.equal(routing.advisory, true);
  assert.equal(routing.enforced, false);
  // vwap_reversion_v1 is a backtest-only strategy: recommending it must not
  // imply the scanner may run it.
  assert.equal(routing.preferred.scannerEligible, false);
  assert.ok(routing.reasons.some((r) => /not scanner eligible/.test(r)));
});

test("with no recorded history nothing is preferred and nothing is blamed", () => {
  const read = { regime: "RANGE", confidence: 82, actionable: true, action: "WAIT", reasons: [], options: REGIME_DEFAULTS };
  const routing = routeRegime({ read, matrix: buildRegimeMatrix([], 10000, {}) });

  assert.equal(routing.preferred, null);
  assert.deepEqual(routing.suppressed, []);
  assert.ok(routing.unproven.length > 0);
  assert.match(routing.reasons[0], /no recorded trade history/);
});

/* ── End to end ───────────────────────────────────────────── */

// A rising market that clears the checklist floor. The higher-timeframe read
// is supplied because a candles-only run can only reach 60 of the 100 points
// and mostly refuses to trade at all — which would make these tests assert
// nothing.
function tradeableCandles(count) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + i * 0.8;
    bars.push({
      openTime: i * 14400000,
      closeTime: (i + 1) * 14400000,
      open: close - 0.4,
      high: close + 0.6,
      low: close - 0.8,
      close,
      volume: 1000 + (i % 5) * 200,
    });
  }
  return bars;
}

test("a backtest tags every opened trade with the regime it was opened in", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const result = await service.run({
    symbol: "BTCUSDT",
    candles: tradeableCandles(300),
    marketContext: { htfTrendUp: true },
  });
  assert.ok(result.trades.length > 0, "the run needs trades to say anything");

  for (const trade of result.trades) {
    assert.ok(trade.meta, "every trade carries meta");
    assert.ok(
      REGIMES.includes(trade.meta.regime),
      `trade tagged ${trade.meta.regime}, which is not a regime`,
    );
    assert.ok(Number.isFinite(trade.meta.regimeConfidence));
  }

  // And the run reports the same trades broken out by environment.
  assert.ok(result.regimeMetrics.rows.length > 0);
  assert.equal(result.regimeMetrics.coverage.untagged, 0, "a fresh run tags everything");
  assert.ok(Object.keys(result.regimeCounts).length > 0);
});

test("the regime tag is recorded but never consulted when deciding to open", async () => {
  // The guarantee the whole design rests on. Handing tryOpen three completely
  // different regime reads — including a TRANSITION, which the router treats
  // as "trade nothing" — must produce the identical decision and the identical
  // reasoning, differing only in what lands on the trade record.
  const service = new BacktestService({ config: makeTradingConfig() });
  const candles = tradeableCandles(300);
  const { contextAtBar, buildContextSeries } = require("../src/services/trading/backtest");
  const { PaperTradingService, MemoryStorage } = require("../src/services/trading/paper-trader");

  const opts = { breakoutLookback: 20, trendFast: 21, trendSlow: 55, macdFast: 12, macdSlow: 26, macdSignal: 9 };
  const context = contextAtBar(candles, opts, { index: 120, series: buildContextSeries(candles, opts) });

  const outcomes = ["TREND_UP", "TRANSITION", null].map((regime) => {
    const trader = new PaperTradingService({
      book: "backtest",
      config: makeTradingConfig(),
      storage: new MemoryStorage(),
      clock: candles[0].closeTime,
    });
    const outcome = service.tryOpen({
      trader,
      symbol: "BTCUSDT",
      direction: "LONG",
      context,
      interval: "4h",
      at: candles[120].closeTime,
      marketContext: { htfTrendUp: true },
      regimeRead: regime ? { regime, confidence: 90 } : null,
    });
    return { outcome, trade: trader.getOpenPositions()[0] || null };
  });

  assert.ok(outcomes[0].outcome.opened, "the setup opens at all");
  for (const { outcome } of outcomes) {
    assert.equal(outcome.opened, outcomes[0].outcome.opened, "the decision is identical");
    assert.deepEqual(outcome.reasons, outcomes[0].outcome.reasons, "the reasoning is identical");
    assert.equal(outcome.confidenceScore, outcomes[0].outcome.confidenceScore);
  }

  // Only the record differs, which is the whole point.
  assert.equal(outcomes[0].trade.meta.regime, "TREND_UP");
  assert.equal(outcomes[1].trade.meta.regime, "TRANSITION");
  assert.equal(outcomes[2].trade.meta.regime, null, "an absent read leaves the trade untagged");
});

test("the service assembles a regime read and its routing from candles", async () => {
  const candles = uptrend(200);
  const lab = new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "regime-lab-")),
    signalScreenerService: {
      getCandles: async () => candles,
    },
  });

  const payload = await lab.regime({ symbol: "BTCUSDT", interval: "1h" });

  assert.equal(payload.symbol, "BTCUSDT");
  assert.equal(payload.interval, "1h");
  assert.equal(payload.candles, 200);
  assert.equal(payload.regime.regime, "TREND_UP");
  // No trade history in a fresh book, so nothing can be preferred yet — and
  // nothing is suppressed either.
  assert.equal(payload.routing.preferred, null);
  assert.deepEqual(payload.routing.suppressed, []);
  assert.equal(payload.routing.enforced, false);
});

test("the regime endpoints report a missing candle source rather than failing quietly", async () => {
  const lab = new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "regime-lab-")),
  });
  await assert.rejects(() => lab.regime({ symbol: "BTCUSDT" }), (err) => err.statusCode === 503);
});

test("every considered strategy lands in exactly one bucket", () => {
  const read = { regime: "RANGE", confidence: 82, actionable: true, action: "WAIT", reasons: [], options: REGIME_DEFAULTS };
  const matrix = matrixFor({
    vwap_reversion_v1: { RANGE: { r: 0.41, count: 30 } },
    donchian_breakout_v1: { RANGE: { r: -0.31, count: 30 } },
    smc_v1: { RANGE: { r: 0.2, count: 2 } },
  });

  const ids = ["vwap_reversion_v1", "donchian_breakout_v1", "smc_v1"];
  const routing = routeRegime({ read, matrix, strategies: ids });
  const placed = [
    ...routing.eligible.map((c) => c.strategy),
    ...routing.suppressed.map((c) => c.strategy),
    ...routing.unproven.map((c) => c.strategy),
  ];

  assert.deepEqual(placed.sort(), ids.slice().sort());
  assert.equal(new Set(placed).size, ids.length, "no strategy appears twice");
});
