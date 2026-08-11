"use strict";

// Experiment records and their persistence.
//
// The property these tests defend: a stored experiment must be enough, on its
// own, to explain and reproduce a number someone later argues about — which
// strategy at which version, over which bars, under which costs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ExperimentStore } = require("../src/services/trading/experiment-store");
const {
  buildExperimentRecord,
  resolveGitCommit,
  newExperimentId,
} = require("../src/services/trading/experiment-record");
const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-experiments-"));
}

function makeStore(overrides = {}) {
  return new ExperimentStore({ dataDir: tmpDir(), logger: { warn() {}, error() {} }, ...overrides });
}

// A wavy uptrend: enough history for smc_v1's warmup, with pullbacks so
// mindset_v1 actually trades.
function candles(n = 400) {
  const bars = [];
  for (let i = 0; i < n; i += 1) {
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

function makeService({ store = null, costs = {} } = {}) {
  return new BacktestService({
    config: makeTradingConfig(costs),
    signalScreenerService: { getCandles: async () => candles() },
    experimentStore: store,
    logger: { error() {} },
  });
}

/* ── Record shape ─────────────────────────────────────────── */

test("a record carries what it takes to reproduce the run", async () => {
  const service = makeService();
  const result = await service.run({ symbol: "BTCUSDT", interval: "15m", candles: candles(), strategy: "mindset_v1" });
  const record = buildExperimentRecord(result, { gitCommit: "abc123" });

  assert.match(record.id, /^exp_/);
  assert.equal(record.strategy, "mindset_v1");
  assert.equal(record.strategyVersion, "1.0.0");
  assert.equal(record.strategyStatus, "forward-paper");
  assert.equal(record.gitCommit, "abc123");
  assert.equal(record.symbol, "BTCUSDT");
  assert.equal(record.timeframe, "15m");
  assert.equal(record.bars, result.bars);
  assert.equal(record.warmupBars, result.warmupBars);
  assert.ok(record.from && record.to, "the historical window must be recorded");
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
  assert.ok(record.options && typeof record.options === "object");
});

test("record metrics are the backtest's own, not a second calculation", async () => {
  const service = makeService();
  const result = await service.run({ symbol: "BTCUSDT", interval: "15m", candles: candles(), strategy: "mindset_v1" });
  const record = buildExperimentRecord(result);
  const m = result.stats.riskMetrics;

  assert.equal(record.closedTrades, m.closedTrades);
  assert.equal(record.netPnlUsd, m.netReturnUsd);
  assert.equal(record.expectancyR, m.expectancyR);
  assert.equal(record.profitFactor, m.profitFactor);
  assert.equal(record.maxDrawdownPct, m.maxDrawdownPct);
  assert.equal(record.worstLossStreak, m.worstConsecutiveLosses);
  assert.equal(record.winRate, result.stats.winRate);
  assert.equal(record.signals, result.signals.length);
});

test("the cost assumptions travel with the experiment", async () => {
  const costs = { takerFeeRate: 0.0006, slippageRate: 0.0003, fundingRate8h: 0.0001 };
  const service = makeService({ costs });
  const result = await service.run({ symbol: "BTCUSDT", interval: "15m", candles: candles(), strategy: "mindset_v1" });
  const record = buildExperimentRecord(result);

  // Without these the stored expectancy is unreproducible: the same strategy
  // over the same bars at different fees is a different experiment.
  assert.deepEqual(record.costs, costs);
});

test("a git commit is resolved from the environment when the checkout is unavailable", () => {
  const fromEnv = resolveGitCommit({ env: { GIT_COMMIT_SHA: "deadbeef" }, useCache: false });
  assert.equal(fromEnv, "deadbeef");

  const noGit = resolveGitCommit({
    env: {},
    useCache: false,
    exec: () => {
      throw new Error("git: not found");
    },
  });
  // Recorded as unknown rather than guessed.
  assert.equal(noGit, null);
});

test("ids are unique and sort chronologically", () => {
  const ids = [newExperimentId(1000), newExperimentId(2000), newExperimentId(3000)];
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual([...ids].sort(), ids);
});

/* ── Persistence ──────────────────────────────────────────── */

test("a recorded experiment survives a new store instance", () => {
  const dataDir = tmpDir();
  const store = new ExperimentStore({ dataDir });
  store.record({ id: "exp_1", strategy: "smc_v1", strategyVersion: "1.0.0", symbol: "BTCUSDT", timeframe: "4h" });

  const reopened = new ExperimentStore({ dataDir });
  assert.equal(reopened.count(), 1);
  assert.equal(reopened.get("exp_1").strategy, "smc_v1");
});

test("experiments are stored apart from the paper-trading ledger", () => {
  const dataDir = tmpDir();
  const store = new ExperimentStore({ dataDir });
  store.record({ id: "exp_1", strategy: "smc_v1" });

  assert.ok(fs.existsSync(path.join(dataDir, "research", "experiments.json")));
  // Nothing was created under the books' directory.
  assert.ok(!fs.existsSync(path.join(dataDir, "trading-lab")));
});

test("writes are atomic: no .tmp file is left behind", () => {
  const dataDir = tmpDir();
  const store = new ExperimentStore({ dataDir });
  store.record({ id: "exp_1" });
  store.record({ id: "exp_2" });

  const files = fs.readdirSync(path.join(dataDir, "research"));
  assert.deepEqual(files, ["experiments.json"]);
});

test("re-recording an id replaces it rather than duplicating it", () => {
  const store = makeStore();
  store.record({ id: "exp_1", symbol: "BTCUSDT" });
  store.record({ id: "exp_1", symbol: "ETHUSDT" });

  assert.equal(store.count(), 1);
  assert.equal(store.get("exp_1").symbol, "ETHUSDT");
});

test("an experiment without an id is refused", () => {
  const store = makeStore();
  assert.throws(() => store.record({ strategy: "smc_v1" }), (err) => err.statusCode === 400);
});

test("the newest experiments come first, and the log is capped", () => {
  const store = makeStore({ cap: 3 });
  for (const id of ["exp_1", "exp_2", "exp_3", "exp_4"]) store.record({ id });

  const { items } = store.list();
  assert.deepEqual(items.map((e) => e.id), ["exp_4", "exp_3", "exp_2"]);
  assert.equal(store.get("exp_1"), null, "the oldest entry aged out of the cap");
});

/* ── Corrupt persistence ──────────────────────────────────── */

test("a corrupt experiments file degrades to empty instead of throwing", () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, "research"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "research", "experiments.json"), "{not json at all");

  const store = new ExperimentStore({ dataDir, logger: { warn() {}, error() {} } });
  assert.deepEqual(store.list().items, []);
  assert.equal(store.get("exp_1"), null);
  assert.equal(store.count(), 0);

  // And the next write repairs the file.
  store.record({ id: "exp_new" });
  assert.equal(new ExperimentStore({ dataDir }).count(), 1);
});

test("a file holding the wrong shape, or half-records, is not served as data", () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, "research"), { recursive: true });
  const file = path.join(dataDir, "research", "experiments.json");
  const logger = { warn() {}, error() {} };

  fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
  assert.deepEqual(new ExperimentStore({ dataDir, logger }).list().items, []);

  // Entries with no id cannot be fetched, so they are dropped rather than
  // returned as records that no detail view can ever open.
  fs.writeFileSync(file, JSON.stringify([{ id: "exp_ok" }, { strategy: "orphan" }, null]));
  const items = new ExperimentStore({ dataDir, logger }).list().items;
  assert.deepEqual(items.map((e) => e.id), ["exp_ok"]);

  fs.writeFileSync(file, "");
  assert.deepEqual(new ExperimentStore({ dataDir, logger }).list().items, []);
});

/* ── Filtering ────────────────────────────────────────────── */

test("experiments filter by strategy, version, symbol and timeframe", () => {
  const store = makeStore();
  store.record({ id: "a", strategy: "mindset_v1", strategyVersion: "1.0.0", symbol: "BTCUSDT", timeframe: "15m" });
  store.record({ id: "b", strategy: "smc_v1", strategyVersion: "1.0.0", symbol: "BTCUSDT", timeframe: "4h" });
  store.record({ id: "c", strategy: "smc_v1", strategyVersion: "2.0.0", symbol: "ETHUSDT", timeframe: "4h" });

  assert.deepEqual(store.list({ strategy: "smc_v1" }).items.map((e) => e.id), ["c", "b"]);
  assert.deepEqual(store.list({ version: "2.0.0" }).items.map((e) => e.id), ["c"]);
  assert.deepEqual(store.list({ symbol: "ETHUSDT" }).items.map((e) => e.id), ["c"]);
  assert.deepEqual(store.list({ timeframe: "4h" }).items.map((e) => e.id), ["c", "b"]);
  assert.deepEqual(store.list({ strategy: "smc_v1", timeframe: "4h", symbol: "BTCUSDT" }).items.map((e) => e.id), ["b"]);

  // Symbols are compared case-insensitively; the same market is the same market.
  assert.deepEqual(store.list({ symbol: "btcusdt" }).items.map((e) => e.id), ["b", "a"]);

  // `total` counts matches, `items` is the capped page.
  const limited = store.list({ strategy: "smc_v1", limit: 1 });
  assert.equal(limited.total, 2);
  assert.equal(limited.items.length, 1);
});

/* ── Backtest integration ─────────────────────────────────── */

test("a backtest records nothing unless it is asked to", async () => {
  const store = makeStore();
  const service = makeService({ store });

  const plain = await service.backtestSymbol({ symbol: "BTCUSDT", interval: "15m", strategy: "smc_v1" });
  assert.equal(plain.experimentId, undefined, "an unrecorded run must not claim an experiment id");
  assert.equal(store.count(), 0);
});

test("a recorded backtest persists the experiment and returns its id", async () => {
  const store = makeStore();
  const service = makeService({ store });

  const result = await service.backtestSymbol({
    symbol: "BTCUSDT",
    interval: "15m",
    strategy: "smc_v1",
    record: true,
    notes: "first smc sweep",
  });

  assert.match(result.experimentId, /^exp_/);
  assert.equal(store.count(), 1);

  const stored = store.get(result.experimentId);
  assert.equal(stored.strategy, "smc_v1");
  assert.equal(stored.strategyVersion, "1.0.0");
  assert.equal(stored.notes, "first smc sweep");
  assert.equal(stored.symbol, "BTCUSDT");
  assert.equal(stored.timeframe, "15m");
  assert.deepEqual(stored.costs, result.costs);
});

test("a failing store does not fail the backtest", async () => {
  const service = makeService({
    store: {
      record() {
        throw new Error("disk on fire");
      },
    },
  });

  const result = await service.backtestSymbol({ symbol: "BTCUSDT", strategy: "smc_v1", record: true });
  // The numbers are still true; they just did not get filed, and the result
  // says so rather than implying a record exists.
  assert.ok(result.stats);
  assert.equal(result.experimentId, null);
  assert.match(result.experimentError, /disk on fire/);
});

test("comparison is untouched by experiment recording", async () => {
  const store = makeStore();
  const service = makeService({ store });

  const comparison = await service.compare({ symbol: "BTCUSDT", interval: "15m", strategies: ["mindset_v1", "smc_v1"] });
  assert.equal(comparison.results.length, 2);
  // Comparison is exploratory by nature — it must not fill the research log.
  assert.equal(store.count(), 0);
});
