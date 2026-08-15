"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CandleLiveResearchRunner,
  LiveResearchService,
} = require("../src/services/trading/live-research-runner");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { getLiveResearchStrategy } = require("../src/services/trading/strategies");
const { makeTradingConfig } = require("../src/services/trading/config");

const QUIET = { log() {}, warn() {}, error() {} };
const TRADEABLE_STATE = {
  regime: "TREND_UP",
  dailyBias: "BULLISH",
  volumeRatio: 1.6,
  macdBullish: true,
  stochSignal: "OVERSOLD_CROSS",
};

class MemoryStateCache {
  constructor() { this.map = new Map(); }
  get(key) {
    const value = this.map.get(key);
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }
  set(key, value) {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
    return value;
  }
}

function tempLab() {
  const lab = new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "live-research-")),
    config: makeTradingConfig({ takerFeeRate: 0, slippageRate: 0, fundingRate8h: 0 }),
  });
  lab.stateForInterval = async () => ({ ...TRADEABLE_STATE });
  return lab;
}

function candle(index, overrides = {}) {
  const openTime = Date.now() - (200 - index) * 3_600_000;
  const close = overrides.close ?? 100;
  return {
    openTime,
    closeTime: openTime + 3_600_000 - 1,
    open: overrides.open ?? close,
    high: overrides.high ?? close + 1,
    low: overrides.low ?? close - 1,
    close,
    volume: 1000,
    ...overrides,
  };
}

function candles(count = 130) {
  return Array.from({ length: count }, (_, index) => candle(index));
}

function definition(id, evaluate) {
  return { ...getLiveResearchStrategy(id), evaluate };
}

function signal(direction, price = 100, extra = {}) {
  return {
    signal: direction,
    strategy: "test",
    price,
    error: null,
    reasons: direction === "FLAT" ? ["No setup on this confirmed close"] : [`${direction} setup confirmed`],
    indicators: { atr: 2, atrRatio: 1, volumeRatio: 1.6, macdBullish: direction === "LONG", trend: direction === "SHORT" ? "DOWN" : "UP" },
    confidence: null,
    stopHint: null,
    targetHint: null,
    ...extra,
  };
}

function runner({ id = "mindset_v1", evaluate, source, cache, lab } = {}) {
  return new CandleLiveResearchRunner({
    definition: definition(id, evaluate || (() => signal("FLAT"))),
    tradingLabService: lab || tempLab(),
    candleSource: source || { async getCandles() { return candles(); } },
    stateCache: cache || new MemoryStateCache(),
    symbol: "BTCUSDT",
    timeframe: "1h",
    logger: QUIET,
  });
}

test("only a fully closed candle can produce live-research execution", async () => {
  const lab = tempLab();
  const future = candle(250, { openTime: Date.now(), closeTime: Date.now() + 3_600_000, close: 100 });
  const subject = runner({
    lab,
    source: { async getCandles() { return [future]; } },
    evaluate: () => signal("LONG"),
  });

  const result = await subject.runOnce();
  assert.equal(result.status, "waiting");
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
  assert.equal(subject.status().lastProcessedCandle, null);
});

test("a newly closed candle is evaluated once and persists structured intent", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  let evaluations = 0;
  const subject = runner({
    lab,
    cache,
    source: { async getCandles() { return rows; } },
    evaluate: () => { evaluations += 1; return signal("LONG"); },
  });

  await subject.runOnce();
  await subject.runOnce();

  const status = subject.status();
  assert.equal(evaluations, 1, "the same closed candle was evaluated twice");
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);
  assert.equal(status.currentSignal, "LONG");
  assert.equal(status.currentIntent.code, "POSITION_OPENED");
  assert.equal(status.decisionTrail.at(-1).status, "OPENED");
  assert.ok(status.lastProcessedCandle.closeTime > 0);
  assert.ok(status.activity.some((entry) => entry.type === "position-opened"));
});

test("restart state prevents duplicate evaluation and duplicate execution", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  const source = { async getCandles() { return rows; } };
  let evaluations = 0;
  const evaluate = () => { evaluations += 1; return signal("LONG"); };

  await runner({ lab, cache, source, evaluate }).runOnce();
  await runner({ lab, cache, source, evaluate }).runOnce();

  assert.equal(evaluations, 1);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);
});

test("backtest-status strategies may collect live research without gaining scanner permission", async () => {
  const lab = tempLab();
  const subject = runner({ id: "donchian_breakout_v1", lab, evaluate: () => signal("LONG") });

  const result = await subject.runOnce();
  assert.equal(result.status, "processed");
  assert.equal(lab.strategyLedger("donchian_breakout_v1").getOpenPositions().length, 1);
  await assert.rejects(
    () => lab.execute({
      strategyId: "donchian_breakout_v1",
      symbol: "BTCUSDT",
      direction: "LONG",
      entryPrice: 100,
      atr: 2,
      state: TRADEABLE_STATE,
    }),
    /cannot forward-paper trade/,
  );
});

test("each runner reads risk and writes trades only in its own account", async () => {
  const lab = tempLab();
  await Promise.all([
    runner({ id: "mindset_v1", lab, evaluate: () => signal("LONG") }).runOnce(),
    runner({ id: "smc_v1", lab, evaluate: () => signal("LONG") }).runOnce(),
  ]);

  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);
  assert.equal(lab.strategyLedger("smc_v1").getOpenPositions().length, 1);
  assert.equal(lab.strategyLedger("vwap_reversion_v1").getOpenPositions().length, 0);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("a later candle continues SL/TP management before evaluating the next setup", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  let current = rows;
  const firstCloseTime = rows.at(-1).closeTime;
  const subject = runner({
    lab,
    cache,
    source: { async getCandles() { return current; } },
    evaluate: (_bars, index) => closeTimeAt(_bars[index]) === firstCloseTime ? signal("LONG") : signal("FLAT", 90, { indicators: { atr: 2, trend: "FLAT" } }),
  });

  await subject.runOnce();
  current = [...rows, candle(131, { open: 100, high: 101, low: 90, close: 90 })];
  await subject.runOnce();

  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
  assert.equal(lab.strategyLedger("mindset_v1").getHistory().length, 1);
  assert.ok(subject.status().activity.some((entry) => entry.message.includes("STOP_HIT")));
});

test("one runner error does not stop another account", async () => {
  const lab = tempLab();
  const service = new LiveResearchService({
    tradingLabService: lab,
    candleSource: { async getCandles() { return candles(); } },
    stateCache: new MemoryStateCache(),
    logger: QUIET,
  });
  service._runners.set("smc_v1", runner({
    id: "smc_v1",
    lab,
    evaluate: () => { throw new Error("SMC test failure"); },
  }));
  service._runners.set("mindset_v1", runner({ id: "mindset_v1", lab, evaluate: () => signal("FLAT") }));

  const cycle = await service.runOnce();
  assert.equal(cycle.status, "complete");
  assert.equal(service.statusFor("smc_v1").healthStatus, "ERROR");
  assert.equal(service.statusFor("mindset_v1").healthStatus, "RUNNING");
  assert.ok(service.statusFor("mindset_v1").lastSuccessfulEvaluationAt);
});

test("disabled live research reports an explicit paused state", () => {
  const service = new LiveResearchService({
    tradingLabService: tempLab(),
    candleSource: { async getCandles() { throw new Error("must not be called"); } },
    stateCache: new MemoryStateCache(),
    enabled: false,
    logger: QUIET,
  });
  const status = service.statusFor("donchian_breakout_v1");
  assert.equal(status.enabled, false);
  assert.equal(status.healthStatus, "PAUSED");
  assert.equal(status.runnerStatus, "PAUSED");
  assert.equal(status.currentIntent.code, "LIVE_RESEARCH_PAUSED");
  assert.match(status.currentIntent.reason, /LIVE_RESEARCH_ENABLED=false/);
});

test("BananaGun is event-data-only and never receives a candle runner", () => {
  const service = new LiveResearchService({
    tradingLabService: tempLab(),
    candleSource: { async getCandles() { throw new Error("must not be called"); } },
    stateCache: new MemoryStateCache(),
    logger: QUIET,
  });
  const status = service.statusFor("shadow_bananagun_v1");
  assert.equal(service._runners.has("shadow_bananagun_v1"), false);
  assert.equal(status.healthStatus, "EVENT_REPLAY_ONLY");
  assert.equal(status.runnerStatus, "WAITING_FOR_LIVE_EVENT_DATA");
  assert.match(status.currentIntent.reason, /candidate.*safety/i);
});

function closeTimeAt(row) {
  return Number(row && row.closeTime) || 0;
}
