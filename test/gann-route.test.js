"use strict";

// Integration: router + GannService over a stubbed candle source. Pins that
// only closed candles are used, results are cached per closed candle, upstream
// failures surface as 502 with no invented data, and the TraderClaw feed is
// read-only and marked experimental.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const { createGannRouter } = require("../src/routes/gann");
const { GannService } = require("../src/services/gann/service");
const { MemoryCache } = require("../src/services/cache");
const { BAR_MS } = require("../src/services/gann/analysis");
const { syntheticCandles } = require("./helpers/gann-fixtures");

const NOW = Date.UTC(2026, 10, 26, 13, 30);

function stubScreener({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getCandles(symbol, tf) {
      calls.push(`${symbol}:${tf}`);
      if (fail) throw new Error("Binance klines HTTP 451");
      const barMs = BAR_MS[tf];
      // The last candle is still open at NOW, the way Binance serves it.
      const lastOpen = Math.floor(NOW / barMs) * barMs;
      return syntheticCandles({ count: 500, seed: 21, barMs, startTime: lastOpen - 499 * barMs });
    },
  };
}

async function withServer(screener, run) {
  const service = new GannService({ signalScreenerService: screener, cache: new MemoryCache(), now: () => NOW });
  const app = express();
  app.use("/api/gann", createGannRouter({ gannService: service }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/gann`;
  try {
    await run(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const get = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
};

test("analysis uses closed candles only and is cached per closed candle", async () => {
  const screener = stubScreener();
  await withServer(screener, async (base) => {
    const first = await get(`${base}/analysis?symbol=BTCUSDT&timeframe=4h`);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.candles.length, 499, "the open candle is dropped");
    assert.ok(first.body.lastClosed.closeTime < NOW);
    assert.equal(first.body.freshness.state, "FRESH");
    assert.match(first.body.notice, /Experimental/);
    const second = await get(`${base}/analysis?symbol=BTCUSDT&timeframe=4h`);
    assert.equal(second.body.computedAt, first.body.computedAt, "same closed candle, same cached result");
    const otherSettings = await get(`${base}/analysis?symbol=BTCUSDT&timeframe=4h&sq9Step=90`);
    assert.equal(otherSettings.body.settings.sq9Step, 90);
  });
});

test("unsupported inputs are 400s and never reach the candle source", async () => {
  const screener = stubScreener();
  await withServer(screener, async (base) => {
    assert.equal((await get(`${base}/analysis?symbol=FAKEUSDT&timeframe=4h`)).status, 400);
    assert.equal((await get(`${base}/analysis?symbol=BTCUSDT&timeframe=2h`)).status, 400);
    assert.equal((await get(`${base}/square-of-nine?price=-1`)).status, 400);
    assert.equal(screener.calls.length, 0);
  });
});

test("square-of-nine calculator needs no market data", async () => {
  const screener = stubScreener();
  await withServer(screener, async (base) => {
    const r = await get(`${base}/square-of-nine?price=100&step=360&count=1&normalise=false`);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.levels.map((l) => l.price), [64, 144]);
    assert.equal(screener.calls.length, 0);
  });
});

test("upstream failure is a 502 with the reason, never fabricated levels", async () => {
  await withServer(stubScreener({ fail: true }), async (base) => {
    const r = await get(`${base}/analysis?symbol=ETHUSDT&timeframe=1D`);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Market data unavailable for ETHUSDT 1D/);
    assert.equal(r.body.levels, undefined);
  });
});

test("multi-timeframe covers 15m, 1H, 4H, 1D and 1W", async () => {
  await withServer(stubScreener(), async (base) => {
    const r = await get(`${base}/mtf?symbol=SOLUSDT`);
    assert.deepStrictEqual(r.body.rows.map((x) => x.timeframe), ["15m", "1h", "4h", "1D", "1W"]);
    assert.ok(r.body.rows.every((x) => x.structure));
  });
});

test("screener scans only the shared universe", async () => {
  const screener = stubScreener();
  await withServer(screener, async (base) => {
    const r = await get(`${base}/screener?timeframe=1h`);
    assert.equal(r.status, 200);
    assert.equal(r.body.rows.length, 25);
    assert.ok(screener.calls.every((c) => c.endsWith(":1h")));
  });
});

test("backtest endpoint returns a reproducible result", async () => {
  await withServer(stubScreener(), async (base) => {
    const a = await get(`${base}/backtest?symbol=BTCUSDT&timeframe=4h&costScenario=stress`);
    assert.equal(a.status, 200);
    assert.equal(a.body.ok, true);
    assert.equal(a.body.costs.id, "stress");
    const b = await get(`${base}/backtest?symbol=BTCUSDT&timeframe=4h&costScenario=stress`);
    assert.equal(a.body.fingerprint, b.body.fingerprint);
  });
});

test("TraderClaw observations are read-only, experimental and carry no order fields", async () => {
  await withServer(stubScreener(), async (base) => {
    const r = await get(`${base}/observations?symbol=BTCUSDT&timeframe=4h`);
    assert.equal(r.status, 200);
    const o = r.body;
    assert.equal(o.schema, "gann-observations/v1");
    assert.equal(o.experimental, true);
    assert.equal(o.validated, false);
    assert.equal(o.readOnly, true);
    assert.ok(Array.isArray(o.upcomingCycleWindows));
    assert.ok(o.nearbyLevels.supports.length <= 3);
    assert.deepStrictEqual(o.higherTimeframeStructure.map((h) => h.timeframe), ["1D", "1W"]);
    assert.doesNotMatch(JSON.stringify(o), /"(action|side|size|quantity|order|signal|confidence)"/i);
  });
  // Mutating methods do not exist.
  await withServer(stubScreener(), async (base) => {
    const res = await fetch(`${base}/observations`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});
