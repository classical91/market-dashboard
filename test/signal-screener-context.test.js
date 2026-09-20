"use strict";

// The screener route carries its market-context row alongside the scan, so the
// page makes one request. These cover the contract the front end reads and,
// more importantly, that a context failure never takes the screener with it.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const { createSignalScreenerRouter } = require("../src/routes/signal-screener");

const SCAN_RESULTS = [{ symbol: "BTCUSDT", signal: "LONG", score: 67, price: 81280.38 }];

function stubScreener() {
  return { async scanAll() { return SCAN_RESULTS; } };
}

async function withServer(router, run) {
  const app = express();
  app.use("/api/signal-screener", router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the scan carries the USDT.D context row", async () => {
  const dominance = { symbol: "USDT.D", percent: 6.24, direction: "FALLING", live: true };
  const router = createSignalScreenerRouter({
    signalScreenerService: stubScreener(),
    usdtDominanceService: { async read() { return dominance; } },
  });

  await withServer(router, async (base) => {
    const body = await (await fetch(`${base}/api/signal-screener?interval=4h`)).json();
    assert.deepEqual(body.results, SCAN_RESULTS);
    assert.deepEqual(body.context.usdtDominance, dominance);
  });
});

test("a dominance provider failure degrades the context row, not the screener", async () => {
  const router = createSignalScreenerRouter({
    signalScreenerService: stubScreener(),
    usdtDominanceService: { async read() { throw new Error("CoinGecko 429"); } },
  });

  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/signal-screener`);
    assert.equal(res.status, 200, "the scan still answers");
    const body = await res.json();
    assert.deepEqual(body.results, SCAN_RESULTS);
    assert.equal(body.context.usdtDominance.percent, null);
    assert.match(body.context.usdtDominance.error, /CoinGecko 429/);
  });
});

test("the route works without a dominance service at all", async () => {
  const router = createSignalScreenerRouter({ signalScreenerService: stubScreener() });

  await withServer(router, async (base) => {
    const body = await (await fetch(`${base}/api/signal-screener`)).json();
    assert.deepEqual(body.results, SCAN_RESULTS);
    assert.equal(body.context.usdtDominance, null);
  });
});
