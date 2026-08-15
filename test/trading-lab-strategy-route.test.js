"use strict";

// The /api/trading-lab backtest surface, end to end over HTTP: the strategy
// catalogue, the strategy parameter, and the admin gate that still stands in
// front of every run.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const fs = require("node:fs");
const os = require("node:os");
const pathMod = require("node:path");

const { createTradingLabRouter } = require("../src/routes/trading-lab");
const { createRequireAdmin } = require("../src/middleware/admin-auth");
const { BacktestService } = require("../src/services/trading/backtest");
const { ExperimentStore } = require("../src/services/trading/experiment-store");
const { makeTradingConfig } = require("../src/services/trading/config");
const { TradingLabService } = require("../src/services/trading/trading-lab");

const ADMIN_KEY = "strategy-route-test-key";

// The same wavy uptrend the strategy tests use: enough history for smc_v1's
// 120-bar warmup, with pullbacks so mindset_v1 has entries to find.
function candles(count = 400) {
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

let server;
let base;
let experimentStore;
let tradingLabService;

function rangeCandles(count = 200) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i / 2) * 2;
    return {
      openTime: i * 3600000,
      closeTime: (i + 1) * 3600000 - 1,
      open: close,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 1000,
    };
  });
}

function regimeTrade(strategy, rMultiple) {
  return {
    status: "closed",
    symbol: "BTCUSDT",
    realizedPnl: rMultiple * 100,
    rMultiple,
    signalSource: "regime-route-test",
    meta: { strategy, regime: "RANGE", regimeConfidence: 80 },
  };
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  experimentStore = new ExperimentStore({
    dataDir: fs.mkdtempSync(pathMod.join(os.tmpdir(), "md-exp-route-")),
  });
  tradingLabService = new TradingLabService({
    dataDir: fs.mkdtempSync(pathMod.join(os.tmpdir(), "md-regime-route-")),
    signalScreenerService: { getCandles: async () => rangeCandles() },
  });
  app.use(
    "/api/trading-lab",
    createTradingLabRouter({
      tradingLabService,
      backtestService: new BacktestService({
        config: makeTradingConfig(),
        signalScreenerService: { getCandles: async () => candles() },
        experimentStore,
      }),
      experimentStore,
      requireAdmin: createRequireAdmin({ adminKey: ADMIN_KEY }),
    }),
  );
  // Mirrors the app's error handler, which is what turns a registry 400 into a
  // 400 response rather than a 500.
  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.expose || status < 500 ? err.message : "Internal server error" });
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function post(path, body, { admin = true } = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { "x-admin-key": ADMIN_KEY } : {}) },
    body: JSON.stringify(body),
  });
}

test("the strategy catalogue is public, so the selector can render before any key is entered", async () => {
  const res = await fetch(`${base}/api/trading-lab/strategies`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.default, "mindset_v1");
  assert.deepEqual(body.strategies.map((s) => s.id).sort(), [
    "donchian_breakout_v1",
    "mindset_v1",
    "shadow_bananagun_v1",
    "smc_v1",
    "vwap_reversion_v1",
  ]);
  for (const strategy of body.strategies) {
    assert.ok(strategy.name && strategy.description && strategy.requiredWarmupBars >= 0);
    // Lifecycle metadata rides along, so a client never has to guess what a
    // strategy is cleared for.
    assert.ok(strategy.version && strategy.status);
    assert.equal(typeof strategy.supportsBacktest, "boolean");
    assert.equal(typeof strategy.supportsEventReplay, "boolean");
    assert.equal(typeof strategy.supportsLiveScanner, "boolean");
    assert.equal(typeof strategy.scannerEligible, "boolean");
    assert.equal(strategy.realMoneyEligible, false, "nothing is real-money eligible");
    assert.equal(strategy.liveEligible, undefined, "the ambiguous field is gone");
  }
});

test("regime routing compares all accounts regardless of the selected strategy", async () => {
  const donchian = tradingLabService.strategyLedger("donchian_breakout_v1");
  const vwap = tradingLabService.strategyLedger("vwap_reversion_v1");
  for (let i = 0; i < 5; i += 1) {
    donchian.addToHistory(regimeTrade("donchian_breakout_v1", 0.5));
    vwap.addToHistory(regimeTrade("vwap_reversion_v1", -0.4));
  }

  const selectedVwap = await (
    await fetch(`${base}/api/trading-lab/regime?symbol=BTCUSDT&interval=1h&min_trades=5&strategyId=vwap_reversion_v1`)
  ).json();
  const selectedDonchian = await (
    await fetch(`${base}/api/trading-lab/regime?symbol=BTCUSDT&interval=1h&min_trades=5&strategyId=donchian_breakout_v1`)
  ).json();

  assert.equal(selectedVwap.regime.regime, "RANGE");
  assert.equal(selectedVwap.routing.preferred.strategy, "donchian_breakout_v1");
  assert.equal(selectedDonchian.routing.preferred.strategy, "donchian_breakout_v1");
  assert.deepEqual(selectedVwap.routing, selectedDonchian.routing, "card selection cannot change routing evidence");

  const vwapMatrix = await (
    await fetch(`${base}/api/trading-lab/regime-matrix?strategyId=vwap_reversion_v1&min_trades=5`)
  ).json();
  assert.deepEqual(vwapMatrix.rows.map((row) => row.strategy), ["vwap_reversion_v1"]);
});

/* ── Research history ─────────────────────────────────────── */

test("a backtest records an experiment only when asked, and the id is returned", async () => {
  const before = experimentStore.count();

  const plain = await (await post("/api/trading-lab/backtest", { symbol: "BTCUSDT", interval: "15m" })).json();
  assert.equal(plain.experimentId, undefined);
  assert.equal(experimentStore.count(), before, "an ordinary run must leave no trace");

  const recorded = await (
    await post("/api/trading-lab/backtest", {
      symbol: "BTCUSDT",
      interval: "15m",
      strategy: "smc_v1",
      record: true,
      notes: "route smoke",
    })
  ).json();
  assert.match(recorded.experimentId, /^exp_/);
  assert.equal(experimentStore.count(), before + 1);
});

test("experiments are readable, filterable and individually fetchable", async () => {
  const created = await (
    await post("/api/trading-lab/backtest", {
      symbol: "ETHUSDT",
      interval: "1h",
      strategy: "mindset_v1",
      record: true,
    })
  ).json();

  const list = await (await fetch(`${base}/api/trading-lab/experiments`)).json();
  assert.ok(list.total >= 1);
  assert.ok(list.items.some((e) => e.id === created.experimentId));

  const filtered = await (
    await fetch(`${base}/api/trading-lab/experiments?strategy=mindset_v1&symbol=ETHUSDT&timeframe=1h&version=1.0.0`)
  ).json();
  assert.ok(filtered.items.length >= 1);
  for (const item of filtered.items) {
    assert.equal(item.strategy, "mindset_v1");
    assert.equal(item.symbol, "ETHUSDT");
    assert.equal(item.timeframe, "1h");
    assert.equal(item.strategyVersion, "1.0.0");
  }

  const one = await (await fetch(`${base}/api/trading-lab/experiments/${created.experimentId}`)).json();
  assert.equal(one.experiment.id, created.experimentId);
  // The cost assumptions are part of the record, not of the run that made it.
  assert.ok(one.experiment.costs);
  assert.equal(one.experiment.strategyStatus, "forward-paper");
});

test("an unknown experiment id is a 404", async () => {
  const res = await fetch(`${base}/api/trading-lab/experiments/exp_nope`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /exp_nope/);
});

test("research history is public, and there are no promotion mutations to find", async () => {
  assert.equal((await fetch(`${base}/api/trading-lab/experiments`)).status, 200);
  // Promotion is a human decision for a later PR; nothing here may change a
  // strategy's lifecycle state.
  for (const path of ["/api/trading-lab/experiments", "/api/trading-lab/strategies/mindset_v1/promote"]) {
    const res = await post(path, { status: "live-eligible" });
    assert.equal(res.status, 404, `${path} must not accept mutations`);
  }
});

test("a backtest with no strategy runs mindset_v1", async () => {
  const res = await post("/api/trading-lab/backtest", { symbol: "btcusdt", interval: "15m" });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.strategy, "mindset_v1");
  assert.equal(body.symbol, "BTCUSDT");
  assert.equal(body.interval, "15m");
});

test("a backtest runs the strategy it was asked for and reports it back", async () => {
  const res = await post("/api/trading-lab/backtest", { symbol: "BTCUSDT", interval: "15m", strategy: "smc_v1" });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.strategy, "smc_v1");
  assert.equal(body.strategyName, "SMC v1");
  assert.ok(body.warmupBars >= 120, "smc_v1's warmup floor applies to a run started over HTTP too");
});

test("an unknown strategy is a 400 that names what was accepted", async () => {
  const res = await post("/api/trading-lab/backtest", { symbol: "BTCUSDT", strategy: "moon_v1" });
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.match(body.error, /Unknown strategy "moon_v1"/);
  assert.match(body.error, /mindset_v1/);
});

test("comparison returns one row per strategy over the same symbol and interval", async () => {
  const res = await post("/api/trading-lab/backtest/compare", {
    symbol: "BTCUSDT",
    interval: "15m",
    strategies: ["mindset_v1", "smc_v1"],
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.symbol, "BTCUSDT");
  assert.equal(body.results.length, 2);
  assert.deepEqual(body.results.map((r) => r.strategy).sort(), ["mindset_v1", "smc_v1"]);
});

test("Banana Gun is exposed as event replay and reports insufficient data instead of candle performance", async () => {
  const catalogue = await (await fetch(`${base}/api/trading-lab/strategies`)).json();
  const banana = catalogue.strategies.find((s) => s.id === "shadow_bananagun_v1");
  assert.equal(banana.supportsBacktest, false);
  assert.equal(banana.supportsEventReplay, true);
  assert.equal(banana.datasetAvailability.productionStatus, "insufficient-data-until-snapshots-exist");

  const run = await (
    await post("/api/trading-lab/backtest", {
      symbol: "BTCUSDT",
      interval: "15m",
      strategy: "shadow_bananagun_v1",
    })
  ).json();
  assert.equal(run.status, "insufficient-data");
  assert.equal(run.replayType, "event-replay");
  assert.equal(run.trades.length, 0);
  assert.match(run.dataset.reason, /No historical candidate events/);
});

// The Backtest and Strategy Comparison cards print the cost assumptions under
// every result, so that a frictionless run cannot be mistaken for a realistic
// one. That display has nothing to fall back on if the fields stop arriving.
test("every result carries the cost assumptions the UI prints", async () => {
  const run = await (await post("/api/trading-lab/backtest", { symbol: "BTCUSDT", interval: "15m" })).json();
  const comparison = await (await post("/api/trading-lab/backtest/compare", { symbol: "BTCUSDT", interval: "15m" })).json();

  for (const costs of [run.costs, ...comparison.results.map((r) => r.costs)]) {
    assert.ok(costs, "a result without costs would render as if it had none");
    const candleCosts = ["takerFeeRate", "slippageRate", "fundingRate8h"];
    const eventCosts = ["gasUsd", "slippagePct", "mevPenaltyPct", "failedTxPct", "failedTxGasUsd"];
    const fields = costs.gasUsd === undefined ? candleCosts : eventCosts;
    for (const field of fields) {
      assert.equal(typeof costs[field], "number", `costs.${field} must be a number`);
    }
  }
});

test("comparison defaults to every registered strategy", async () => {
  const res = await post("/api/trading-lab/backtest/compare", { symbol: "BTCUSDT", interval: "15m" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 5);
  assert.ok(body.results.some((row) => row.strategy === "shadow_bananagun_v1" && row.status === "insufficient-data"));
});

test("running or comparing without an admin key is refused", async () => {
  for (const path of ["/api/trading-lab/backtest", "/api/trading-lab/backtest/compare"]) {
    const res = await post(path, { symbol: "BTCUSDT", strategy: "smc_v1" }, { admin: false });
    assert.equal(res.status, 401, `${path} must stay admin-gated`);
  }
});

/* ── History windowing ────────────────────────────────────── */

test("a truncated history window reports the balance it starts from", async () => {
  // 240 closed trades of +$10 each on a $10,000 account, requested 80 at a
  // time. Before this, a client drawing the curve had only the ORIGINAL
  // starting balance to begin from, so past trade 80 it redrew the account as
  // if the earlier trades had never happened — a plausible-looking line that
  // was wrong by $1,600 at the left-hand edge.
  const history = [];
  for (let i = 0; i < 240; i += 1) {
    history.push({ id: `t${i}`, pnl: 10, closedAt: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString() });
  }

  const app = express();
  app.use(express.json());
  app.use(
    "/api/trading-lab",
    createTradingLabRouter({
      tradingLabService: {
        overview: async () => ({}),
        listBooks: () => [],
        book: () => ({
          book: "main",
          getHistory: () => history,
          getAccount: () => ({ startingBalance: 10000 }),
        }),
      },
      requireAdmin: createRequireAdmin({ adminKey: ADMIN_KEY }),
    }),
  );
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, resolve));
  const localBase = `http://127.0.0.1:${local.address().port}`;

  try {
    const windowed = await (await fetch(`${localBase}/api/trading-lab/history?limit=80`)).json();
    assert.equal(windowed.total, 240);
    assert.equal(windowed.returned, 80);
    assert.equal(windowed.truncated, true);
    // 160 trades happened before this window, at +$10 each.
    assert.equal(windowed.openingBalance, 11600);
    // Opening balance plus the window's own P&L is the true current balance,
    // which is the property that makes the drawn curve correct.
    const windowPnl = windowed.items.reduce((sum, t) => sum + t.pnl, 0);
    assert.equal(windowed.openingBalance + windowPnl, 10000 + 2400);

    // A window that covers everything opens at the account's starting balance.
    const whole = await (await fetch(`${localBase}/api/trading-lab/history?limit=1000`)).json();
    assert.equal(whole.truncated, false);
    assert.equal(whole.openingBalance, 10000);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test("the backtest routes accept an execution mode and refuse an unknown one", async () => {
  const native = await post("/api/trading-lab/backtest", {
    symbol: "BTCUSDT",
    interval: "15m",
    strategy: "smc_v1",
    executionMode: "native",
  });
  assert.equal(native.status, 200);
  assert.equal((await native.json()).executionMode, "native");

  // Defaulting silently to shared would make a caller's typo look like a
  // native run that happened to match shared results.
  const bogus = await post("/api/trading-lab/backtest", {
    symbol: "BTCUSDT",
    strategy: "smc_v1",
    executionMode: "whatever",
  });
  assert.equal(bogus.status, 400);
  assert.match((await bogus.json()).error, /Unknown executionMode/);
});

test("a bad strategy option is refused by the route as a 400", async () => {
  const res = await post("/api/trading-lab/backtest", {
    symbol: "BTCUSDT",
    interval: "15m",
    strategy: "donchian_breakout_v1",
    options: { channelLength: 99999 },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /channelLength must be at most/);
});
