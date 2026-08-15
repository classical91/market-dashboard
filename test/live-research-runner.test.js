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

// A live demo experiment begins with a BASELINE: the first cycle records the
// latest already-closed candle without evaluating it, because that candle
// closed before the experiment existed. Tests that want an entry therefore
// establish the baseline first and then deliver a genuinely new close.
async function startExperiment(subject) {
  const result = await subject.runOnce();
  assert.equal(result.status, "baseline", "the first cycle must be a baseline, not a trade");
  return result;
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

  await startExperiment(subject);
  assert.equal(evaluations, 0, "the baseline candle must never be evaluated for entry");
  rows.push(candle(131, { close: 100 }));
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

  await startExperiment(runner({ lab, cache, source, evaluate }));
  rows.push(candle(131, { close: 100 }));
  // A restart reads the persisted baseline and processes the new close once;
  // a second restart must not re-execute a candle already processed.
  await runner({ lab, cache, source, evaluate }).runOnce();
  await runner({ lab, cache, source, evaluate }).runOnce();

  assert.equal(evaluations, 1);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);
});

test("backtest-status strategies may collect live research without gaining scanner permission", async () => {
  const lab = tempLab();
  const rows = candles();
  const subject = runner({
    id: "donchian_breakout_v1", lab,
    source: { async getCandles() { return rows; } },
    evaluate: () => signal("LONG"),
  });

  await startExperiment(subject);
  rows.push(candle(131, { close: 100 }));
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
  const rows = candles();
  const source = { async getCandles() { return rows; } };
  const mindset = runner({ id: "mindset_v1", lab, source, evaluate: () => signal("LONG") });
  const smc = runner({ id: "smc_v1", lab, source, evaluate: () => signal("LONG") });

  await Promise.all([startExperiment(mindset), startExperiment(smc)]);
  rows.push(candle(131, { close: 100 }));
  await Promise.all([mindset.runOnce(), smc.runOnce()]);

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
  // The bar immediately after the baseline — the first this experiment may act
  // on. Built once and its close time read from it: candle() derives timestamps
  // from Date.now(), so calling it twice produces two different bars.
  const entryBar = candle(130, { open: 100, high: 101, low: 99, close: 100 });
  const entryCloseTime = entryBar.closeTime;
  const subject = runner({
    lab,
    cache,
    source: { async getCandles() { return current; } },
    // LONG on the first close after the baseline, FLAT on every later one.
    evaluate: (_bars, index) => closeTimeAt(_bars[index]) === entryCloseTime
      ? signal("LONG")
      : signal("FLAT", 90, { indicators: { atr: 2, trend: "FLAT" } }),
  });

  await startExperiment(subject);
  // The entry candle has to close AFTER the baseline, so it is appended rather
  // than being the baseline itself.
  current = [...rows, entryBar];
  await subject.runOnce();
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1, "entry taken on the new close");
  current = [...current, candle(131, { open: 100, high: 101, low: 90, close: 90 })];
  await subject.runOnce();

  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
  assert.equal(lab.strategyLedger("mindset_v1").getHistory().length, 1);
  assert.ok(subject.status().activity.some((entry) => entry.message.includes("STOP_HIT")));
});

test("downtime catch-up manages missed bars but evaluates and enters only the newest close", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  let current = candles();
  let live = false;
  const evaluated = [];
  const subject = runner({
    lab,
    cache,
    source: { async getCandles(_symbol, _timeframe, options) {
      assert.equal(options.force, true, "runner must bypass cached unfinished klines");
      return current;
    } },
    evaluate: (bars, index) => {
      evaluated.push(closeTimeAt(bars[index]));
      return live ? signal("LONG") : signal("FLAT");
    },
  });

  await subject.runOnce();
  evaluated.length = 0;
  live = true;
  const missedOne = candle(131, { close: 101 });
  const missedTwo = candle(132, { close: 102 });
  const newest = candle(133, { close: 103 });
  current = [...current, missedOne, missedTwo, newest];

  await subject.runOnce();

  assert.deepEqual(evaluated, [newest.closeTime], "missed bars must not be scored with present-time context");
  const [position] = lab.strategyLedger("mindset_v1").getOpenPositions();
  assert.ok(position);
  assert.equal(position.openedAt, new Date(newest.closeTime).toISOString());
  assert.equal(position.executionOwner, "live-research");
  assert.equal(subject.status().activity.filter((entry) => entry.type === "catch-up").length, 2);
});

test("an opposing strategy signal does not add a live-only exit absent from backtesting", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  let current = candles();
  let direction = "LONG";
  const subject = runner({
    lab,
    cache,
    source: { async getCandles() { return current; } },
    evaluate: () => signal(direction),
  });

  await startExperiment(subject);
  current = [...current, candle(131, { open: 100, high: 101, low: 99, close: 100 })];
  await subject.runOnce();
  const first = lab.strategyLedger("mindset_v1").getOpenPositions()[0];
  assert.ok(first, "a position must exist before an opposing signal can be tested");
  direction = "SHORT";
  current = [...current, candle(132, { open: 100, high: 101, low: 99, close: 100 })];
  await subject.runOnce();

  const [stillOpen] = lab.strategyLedger("mindset_v1").getOpenPositions();
  assert.equal(stillOpen.id, first.id);
  assert.equal(lab.strategyLedger("mindset_v1").getHistory().length, 0);
  assert.ok(!subject.status().activity.some((entry) => entry.message.includes("STRATEGY_EXIT")));
});

test("one runner error does not stop another account", async () => {
  const lab = tempLab();
  // One frozen candle set shared by every runner. Each call to candles()
  // derives timestamps from Date.now(), so regenerating per cycle made the
  // second cycle's "is there a new close?" answer depend on millisecond drift
  // between the two runOnce() calls — a flake, not a test.
  const rows = candles();
  const source = { async getCandles() { return rows; } };
  const service = new LiveResearchService({
    tradingLabService: lab,
    candleSource: source,
    stateCache: new MemoryStateCache(),
    logger: QUIET,
  });
  service._runners.set("smc_v1", runner({
    id: "smc_v1",
    lab,
    source,
    evaluate: () => { throw new Error("SMC test failure"); },
  }));
  service._runners.set("mindset_v1", runner({ id: "mindset_v1", lab, source, evaluate: () => signal("FLAT") }));

  // First cycle baselines both accounts; a genuinely new close then arrives,
  // and the second cycle evaluates it.
  await service.runOnce();
  rows.push(candle(130, { close: 100 }));
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

test("Live Scanner and Live Research cannot claim the same strategy-account writer", () => {
  // The invariant is "one ledger, one writer" — and it is now enforced by
  // EXCLUDING the reserved strategy rather than by throwing.
  //
  // Throwing enforced the same rule at ruinous cost: the constructor runs
  // during createApp(), mindset_v1 is both scanner eligible and live-research
  // eligible, so every deployment with ENABLE_LIVE_SCANNER=true failed to boot
  // and restarted forever. The rule was right; taking the whole dashboard down
  // to enforce it was not.
  const service = new LiveResearchService({
    tradingLabService: tempLab(),
    candleSource: { async getCandles() { return candles(); } },
    stateCache: new MemoryStateCache(),
    enabled: true,
    reservedStrategyIds: ["mindset_v1"],
    logger: QUIET,
  });

  assert.equal(service.ownsStrategy("mindset_v1"), false, "Live Research must not claim the scanner's ledger");
  assert.deepEqual(service.reservedByScanner, ["mindset_v1"]);
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

/* ── Experiment integrity ─────────────────────────────────── */

test("first startup establishes a baseline and cannot open a position", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  let evaluated = 0;
  const subject = runner({
    lab,
    cache,
    // A signal that would trade every single candle, so nothing but the
    // baseline rule can be what keeps the ledger empty.
    evaluate: () => { evaluated += 1; return signal("LONG"); },
  });

  const result = await subject.runOnce();
  const status = subject.status();

  assert.equal(result.status, "baseline");
  assert.equal(evaluated, 0, "the baseline candle must not be evaluated for entry");
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
  assert.equal(lab.strategyLedger("mindset_v1").getHistory().length, 0);

  // The baseline is recorded, so the next cycle knows where the experiment began.
  assert.ok(status.lastProcessedCandle.closeTime > 0);
  assert.ok(status.baselineCandle.closeTime > 0);
  assert.equal(status.baselineCandle.closeTime, status.lastProcessedCandle.closeTime);
  assert.ok(status.baselineAt);
  assert.equal(status.runnerStatus, "WAITING_FOR_NEXT_CANDLE");
  assert.equal(status.currentIntent.code, "BASELINE_ESTABLISHED");
  assert.ok(status.activity.some((entry) => entry.type === "baseline"));
});

test("the first candle to close after the baseline can produce an entry", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  const subject = runner({ lab, cache, source: { async getCandles() { return rows; } }, evaluate: () => signal("LONG") });

  await startExperiment(subject);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);

  const fresh = candle(130, { close: 100 });
  rows.push(fresh);
  await subject.runOnce();

  const [position] = lab.strategyLedger("mindset_v1").getOpenPositions();
  assert.ok(position, "a candle closing after the baseline is tradeable");
  assert.equal(position.executionOwner, "live-research");
  // Opened at the new candle's close, not at the baseline's.
  assert.equal(position.openedAt, new Date(fresh.closeTime).toISOString());
});

test("state loss with an open position manages it without inventing an entry", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  const source = { async getCandles() { return rows; } };
  const subject = runner({ lab, cache, source, evaluate: () => signal("LONG") });

  await startExperiment(subject);
  rows.push(candle(130, { close: 100 }));
  await subject.runOnce();
  const opened = lab.strategyLedger("mindset_v1").getOpenPositions();
  assert.equal(opened.length, 1);

  // Runner state is lost; the ledger still holds the live-research position.
  cache.map.clear();
  const recovered = runner({ lab, cache, source, evaluate: () => signal("LONG") });
  // A bar that takes out the stop, so recovery has real work to do.
  rows.push(candle(131, { open: 100, high: 101, low: 80, close: 80 }));
  const result = await recovered.runOnce();

  assert.equal(result.status, "baseline", "recovery re-baselines rather than replaying history");
  const ledger = lab.strategyLedger("mindset_v1");
  // The stop was honoured — the position was not orphaned.
  assert.equal(ledger.getOpenPositions().length, 0);
  assert.equal(ledger.getHistory().length, 1, "exactly the one pre-existing trade, closed");
  const status = recovered.status();
  assert.ok(status.activity.some((entry) => entry.type === "recovery"));
  assert.ok(status.baselineCandle.closeTime > 0);
});

test("a reset restarts the experiment so no old candle can be traded", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  const source = { async getCandles() { return rows; } };
  const subject = runner({ lab, cache, source, evaluate: () => signal("LONG") });

  await startExperiment(subject);
  rows.push(candle(130, { close: 100 }));
  await subject.runOnce();
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);

  const service = new LiveResearchService({
    tradingLabService: lab,
    candleSource: source,
    stateCache: cache,
    logger: QUIET,
  });
  service._runners.set("mindset_v1", subject);
  lab.attachLiveResearchService(service);

  const reset = await lab.resetExperiment("mindset_v1");
  assert.equal(reset.runnerReset, true, "the runner restarts with the ledger");
  assert.equal(reset.account.balance, reset.account.startingBalance);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
  assert.equal(lab.strategyLedger("mindset_v1").getHistory().length, 0);

  // The very next cycle must re-baseline, not trade the candle it already saw.
  const after = await subject.runOnce();
  assert.equal(after.status, "baseline");
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
});

test("reading an account never mutates it", async () => {
  const lab = tempLab();
  const cache = new MemoryStateCache();
  const rows = candles();
  const subject = runner({ lab, cache, source: { async getCandles() { return rows; } }, evaluate: () => signal("LONG") });

  await startExperiment(subject);
  rows.push(candle(130, { close: 100 }));
  await subject.runOnce();

  const ledger = lab.strategyLedger("mindset_v1");
  const before = JSON.stringify({
    positions: ledger.getOpenPositions(),
    history: ledger.getHistory(),
    account: ledger.getAccount(),
  });

  // What a dashboard refresh does: read the account, the detail, the status.
  await lab.strategyAccounts();
  await lab.strategyAccount("mindset_v1");
  subject.status();
  await lab.strategyAccounts();

  assert.equal(
    JSON.stringify({
      positions: ledger.getOpenPositions(),
      history: ledger.getHistory(),
      account: ledger.getAccount(),
    }),
    before,
    "a page load changed the experiment",
  );
});

/* ── Writer conflicts must not take the app down ──────────── */

test("a strategy the Live Scanner owns is excluded, not fatal", () => {
  // This threw, and mindset_v1 is both scanner eligible and live-research
  // eligible — so every deployment with ENABLE_LIVE_SCANNER=true failed to
  // boot, health check included. A resolvable conflict in one subsystem must
  // not stop the whole dashboard from starting.
  const service = new LiveResearchService({
    tradingLabService: tempLab(),
    candleSource: { async getCandles() { return candles(); } },
    stateCache: new MemoryStateCache(),
    reservedStrategyIds: ["mindset_v1"],
    logger: QUIET,
  });

  assert.deepEqual(service.reservedByScanner, ["mindset_v1"]);
  assert.equal(service.ownsStrategy("mindset_v1"), false, "the scanner keeps sole ownership");
  // Every other eligible strategy still collects live research.
  for (const id of ["smc_v1", "donchian_breakout_v1", "vwap_reversion_v1"]) {
    assert.equal(service.ownsStrategy(id), true, id);
  }
});

test("a reserved strategy reports its real reason, not the event-replay one", () => {
  const service = new LiveResearchService({
    tradingLabService: tempLab(),
    candleSource: { async getCandles() { return candles(); } },
    stateCache: new MemoryStateCache(),
    reservedStrategyIds: ["mindset_v1"],
    logger: QUIET,
  });

  const status = service.statusFor("mindset_v1");
  assert.equal(status.runnerStatus, "OWNED_BY_LIVE_SCANNER");
  assert.match(status.currentIntent.summary, /Live Scanner writes this strategy's account/i);
  // Saying "cannot be evaluated from OHLCV candles" would be false: it IS
  // evaluated, by the other loop.
  assert.doesNotMatch(status.currentIntent.summary, /cannot be evaluated/i);
  assert.notEqual(status.healthStatus, "EVENT_REPLAY_ONLY");

  // And the exclusion is visible at the top level rather than only per runner.
  assert.deepEqual(service.status().reservedByScanner, ["mindset_v1"]);
});

test("a reserved strategy gets no live-research runner at all", async () => {
  const lab = tempLab();
  const service = new LiveResearchService({
    tradingLabService: lab,
    candleSource: { async getCandles() { return candles(); } },
    stateCache: new MemoryStateCache(),
    reservedStrategyIds: ["mindset_v1"],
    logger: QUIET,
  });

  const cycle = await service.runOnce();
  assert.equal(cycle.status, "complete");
  assert.ok(
    !cycle.results.some((row) => row.strategyId === "mindset_v1"),
    "the reserved strategy must not be cycled by Live Research",
  );
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
});
