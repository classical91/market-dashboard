"use strict";

// The /api/trading-lab backtest surface, end to end over HTTP: the strategy
// catalogue, the strategy parameter, and the admin gate that still stands in
// front of every run.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const { createTradingLabRouter } = require("../src/routes/trading-lab");
const { createRequireAdmin } = require("../src/middleware/admin-auth");
const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");

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

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/trading-lab",
    createTradingLabRouter({
      tradingLabService: { overview: async () => ({}), listBooks: () => [] },
      backtestService: new BacktestService({
        config: makeTradingConfig(),
        signalScreenerService: { getCandles: async () => candles() },
      }),
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
  assert.deepEqual(body.strategies.map((s) => s.id).sort(), ["mindset_v1", "smc_v1"]);
  for (const strategy of body.strategies) {
    assert.ok(strategy.name && strategy.description && strategy.requiredWarmupBars > 0);
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

test("comparison defaults to every registered strategy", async () => {
  const res = await post("/api/trading-lab/backtest/compare", { symbol: "BTCUSDT", interval: "15m" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results.length, 2);
});

test("running or comparing without an admin key is refused", async () => {
  for (const path of ["/api/trading-lab/backtest", "/api/trading-lab/backtest/compare"]) {
    const res = await post(path, { symbol: "BTCUSDT", strategy: "smc_v1" }, { admin: false });
    assert.equal(res.status, 401, `${path} must stay admin-gated`);
  }
});
