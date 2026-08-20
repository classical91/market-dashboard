"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { mindsetV1 } = require("../src/services/trading/strategies/mindset-v1");
const {
  mindsetV11,
  evaluateMindsetV11,
  MINDSET_V1_1_VARIANTS,
} = require("../src/services/trading/strategies/mindset-v1-1");
const { assertValidOptions } = require("../src/services/trading/strategies");
const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");
const { buildExperimentRecord } = require("../src/services/trading/experiment-record");

function wave(count, { down = false, amplitude = 5, volume = null } = {}) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = (down ? 300 - i * 0.15 : 100 + i * 0.15) + Math.sin(i / 4) * amplitude;
    bars.push({
      openTime: i * 900000,
      closeTime: (i + 1) * 900000 - 1,
      open: close + (down ? 0.2 : -0.2),
      high: close + 1,
      low: close - 1,
      close,
      volume: volume ? volume(i) : 1000 + (i % 9) * 100,
    });
  }
  return bars;
}

function signalsFor(bars, options) {
  const out = [];
  for (let i = 0; i < bars.length; i += 1) {
    const result = evaluateMindsetV11(bars.slice(0, i + 1), options);
    if (result.signal !== "FLAT") out.push({ index: i, ...result });
  }
  return out;
}

test("mindset_v1 remains frozen while v1.1 has an independent experimental identity", () => {
  assert.equal(mindsetV1.id, "mindset_v1");
  assert.equal(mindsetV1.version, "1.0.0");
  assert.equal(mindsetV1.status, "forward-paper");
  assert.equal(mindsetV1.supportsLiveScanner, true);

  assert.equal(mindsetV11.id, "mindset_v1_1");
  assert.equal(mindsetV11.version, "1.1.0-experimental.1");
  assert.equal(mindsetV11.status, "experimental");
  assert.equal(mindsetV11.supportsLiveScanner, false);
  assert.deepEqual(MINDSET_V1_1_VARIANTS, [
    "baseline",
    "rsi_trigger",
    "trend_strength",
    "pullback",
    "macd_confirmation",
    "volume_confirmation",
  ]);
});

test("v1.1 baseline is signal- and indicator-identical to frozen v1", () => {
  const bars = wave(220);
  for (const index of [49, 50, 73, 100, 150, 219]) {
    const v1 = mindsetV1.evaluate(bars, index, {});
    const v11 = mindsetV11.evaluate(bars, index, { options: { variant: "baseline" } });
    assert.equal(v11.signal, v1.signal, `bar ${index}`);
    const { experimentVariant, ...v11Indicators } = v11.indicators;
    assert.equal(experimentVariant, "baseline");
    assert.deepEqual(v11Indicators, v1.indicators, `bar ${index}`);
  }
});

test("fresh RSI trigger requires a strict cross and is LONG/SHORT symmetric", () => {
  const longs = signalsFor(wave(220), { variant: "rsi_trigger" });
  const shorts = signalsFor(wave(220, { down: true }), { variant: "rsi_trigger" });
  assert.ok(longs.length > 2);
  assert.ok(shorts.length > 2);
  longs.forEach((row) => {
    assert.equal(row.signal, "LONG");
    assert.ok(row.indicators.previousRsi <= 50 && row.indicators.rsi > 50);
  });
  shorts.forEach((row) => {
    assert.equal(row.signal, "SHORT");
    assert.ok(row.indicators.previousRsi >= 50 && row.indicators.rsi < 50);
  });
});

test("RSI band boundaries remain strict", () => {
  const bars = wave(100);
  const control = evaluateMindsetV11(bars, { variant: "baseline" });
  assert.equal(control.signal, "LONG");
  const rsi = control.indicators.rsi;
  assert.equal(evaluateMindsetV11(bars, { variant: "baseline", rsiLongMin: rsi }).signal, "FLAT");
  assert.equal(evaluateMindsetV11(bars, { variant: "baseline", rsiLongMax: rsi }).signal, "FLAT");
});

test("every ablation is deterministic and reads no future bars", () => {
  const bars = wave(180);
  for (const variant of MINDSET_V1_1_VARIANTS) {
    const context = { options: { variant } };
    const fromFull = mindsetV11.evaluate(bars, 120, context);
    const fromPrefix = mindsetV11.evaluate(bars.slice(0, 121), 120, context);
    assert.deepEqual(fromFull, fromPrefix, variant);
    assert.deepEqual(mindsetV11.evaluate(bars, 120, context), fromFull, `${variant} is nondeterministic`);
  }
});

test("v1.1 validates experiment configuration before replay", () => {
  assert.throws(() => assertValidOptions(mindsetV11, { variant: "everything_at_once" }), /variant must be one of/);
  assert.throws(() => assertValidOptions(mindsetV11, { fastLen: 50, slowLen: 20 }), /fastLen must be less/);
  assert.throws(() => assertValidOptions(mindsetV11, { rsiLongMin: 75, rsiLongMax: 75 }), /rsiLongMin/);
  assert.doesNotThrow(() => assertValidOptions(mindsetV11, { variant: "trend_strength", trendStrengthMin: 0.4 }));
});

test("v1.1 experiment records preserve variant, execution, costs, and expanded counts", async () => {
  const service = new BacktestService({ config: makeTradingConfig() });
  const result = await service.run({
    symbol: "BTCUSDT",
    interval: "15m",
    candles: wave(260),
    strategy: "mindset_v1_1",
    options: { variant: "rsi_trigger" },
    executionMode: "shared",
    costScenario: "baseline",
  });
  const record = buildExperimentRecord(result, { gitCommit: "test" });

  assert.equal(record.strategy, "mindset_v1_1");
  assert.equal(record.strategyVersion, "1.1.0-experimental.1");
  assert.equal(record.options.variant, "rsi_trigger");
  assert.equal(record.executionMode, "shared");
  assert.equal(record.costScenario, "baseline");
  assert.equal(record.signals, record.longSignals + record.shortSignals);
  assert.equal(record.executedTrades, record.longTrades + record.shortTrades);
  assert.equal(record.averageR, record.expectancyR);
});

test("the Pine diagnostic preserves the recovered wrapper and instruments the two-trade question", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "tradingview", "mindset-v1-signal-execution-parity.pine"),
    "utf8",
  );
  assert.match(source, /Recovered Pine Parity Diagnostic/);
  assert.match(source, /pyramiding=0/);
  assert.match(source, /margin_long=1/);
  assert.match(source, /strategy\.equity\*pct\/100\.0/);
  assert.match(source, /neededBars=math\.max\(slowLen/);
  assert.match(source, /longBars/);
  assert.match(source, /shortBars/);
  assert.match(source, /longOpps/);
  assert.match(source, /shortOpps/);
  assert.match(source, /sizingFailures/);
  assert.match(source, /marginRejects/);
  assert.match(source, /strategy\.closedtrades/);
  assert.match(source, /strategy\.opentrades/);
});
