"use strict";

// The Directional Bias route is a projection, not an engine: it must pass the
// screener's own numbers through untouched, translate LONG/SHORT/FLAT into the
// dashboard vocabulary server-side so every front end says the same thing, and
// degrade a broken row rather than the scan.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const { createDirectionalBiasRouter } = require("../src/routes/directional-bias");
const { SignalScreenerService } = require("../src/services/signal-screener");
const { toDirectionalBias } = require("../src/services/screener-projections");
const { MemoryCache } = require("../src/services/cache");

function screenerRow(overrides = {}) {
  return {
    symbol: "SOLUSDT",
    signal: "LONG",
    score: 78,
    rsi: 61.4,
    adx: 27.8,
    price: 150.2,
    candleCloseTime: 1_700_000_000_000,
    computedAt: new Date(1_700_000_000_000).toISOString(),
    trendRegime: "TREND_UP",
    extreme: { bottom: { score: 15 }, top: { score: 100 }, dominant: "top", state: "CONFIRMED" },
    indicators: {
      rsi: 61.4,
      adx: 27.8,
      macdBullish: true,
      aboveVwap: true,
      volumeAboveAverage: true,
      ema20AboveEma50: true,
      priceAboveEma200: true,
      bullishChecks: 5,
      bearishChecks: 1,
    },
    ...overrides,
  };
}

async function withServer(router, run) {
  const app = express();
  app.use("/api/directional-bias", router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function stubScreener(rows) {
  return {
    calls: 0,
    async scanDirectionalBias(interval) {
      this.calls += 1;
      return rows.map((row) => toDirectionalBias(row, interval));
    },
  };
}

test("LONG, SHORT and FLAT become BULLISH, BEARISH and NEUTRAL", () => {
  assert.equal(toDirectionalBias(screenerRow({ signal: "LONG" }), "4h").bias, "BULLISH");
  assert.equal(toDirectionalBias(screenerRow({ signal: "SHORT" }), "4h").bias, "BEARISH");
  assert.equal(toDirectionalBias(screenerRow({ signal: "FLAT" }), "4h").bias, "NEUTRAL");
});

test("the wire value rides along unchanged, so the bot and bridge are unaffected", () => {
  // The rename is a presentation decision. Anything already switching on
  // LONG / SHORT / FLAT must keep working against this payload.
  for (const signal of ["LONG", "SHORT", "FLAT"]) {
    assert.equal(toDirectionalBias(screenerRow({ signal }), "4h").signal, signal);
  }
});

test("score, ADX, RSI and trend regime are passed through, never recomputed", () => {
  const row = toDirectionalBias(screenerRow(), "4h");
  assert.equal(row.score, 78);
  assert.equal(row.adx, 27.8);
  assert.equal(row.rsi, 61.4);
  assert.equal(row.trendRegime, "TREND_UP");
  assert.equal(row.price, 150.2);
  assert.deepEqual(row.checks, { bullish: 5, bearish: 1 });
});

test("the six checks are reported individually in the page's vocabulary", () => {
  const bullish = toDirectionalBias(screenerRow(), "4h");
  assert.equal(bullish.emaStructure, "BULLISH");
  assert.equal(bullish.ema200, "ABOVE");
  assert.equal(bullish.vwap, "ABOVE");
  assert.equal(bullish.macd, "BULLISH");
  assert.equal(bullish.volume, "CONFIRMED");

  const bearish = toDirectionalBias(screenerRow({
    signal: "SHORT",
    indicators: {
      macdBullish: false,
      aboveVwap: false,
      volumeAboveAverage: false,
      ema20AboveEma50: false,
      priceAboveEma200: false,
      bullishChecks: 1,
      bearishChecks: 5,
    },
  }), "4h");
  assert.equal(bearish.emaStructure, "BEARISH");
  assert.equal(bearish.ema200, "BELOW");
  assert.equal(bearish.vwap, "BELOW");
  assert.equal(bearish.macd, "BEARISH");
  assert.equal(bearish.volume, "LIGHT");
});

test("a component with no reading stays null instead of defaulting to bearish", () => {
  const row = toDirectionalBias(screenerRow({ indicators: {} }), "4h");
  for (const key of ["emaStructure", "ema200", "vwap", "macd", "volume"]) {
    assert.equal(row[key], null, `${key} must not invent a reading`);
  }
});

test("an error row degrades to a named failure, not a neutral-looking row", () => {
  const row = toDirectionalBias({ symbol: "APTUSDT", error: "Binance klines HTTP 451" }, "4h");
  assert.equal(row.symbol, "APTUSDT");
  assert.match(row.error, /HTTP 451/);
  assert.equal(row.bias, null, "a failure must not read as NEUTRAL");
  assert.equal(row.score, null);
  assert.equal(row.freshness.state, "UNKNOWN", "absent evidence must not read as current evidence");
});

test("every row carries the shared freshness assessment", () => {
  const now = 1_700_000_000_000 + 60_000;
  const fresh = toDirectionalBias(screenerRow(), "4h", now);
  assert.equal(fresh.freshness.state, "FRESH");
  assert.equal(fresh.candleCloseTime, 1_700_000_000_000);

  // Past a whole bar plus slack, the feed itself is behind.
  const stale = toDirectionalBias(screenerRow(), "4h", now + 7 * 60 * 60 * 1000);
  assert.equal(stale.freshness.state, "STALE");
  assert.ok(stale.freshness.staleReasons.length);
});

test("the route answers with the scan, the interval and the USDT.D context", async () => {
  const dominance = { symbol: "USDT.D", percent: 6.24, direction: "FALLING", live: true };
  const screener = stubScreener([screenerRow()]);
  const router = createDirectionalBiasRouter({
    signalScreenerService: screener,
    usdtDominanceService: { async read() { return dominance; } },
  });

  await withServer(router, async (base) => {
    const body = await (await fetch(`${base}/api/directional-bias?interval=4h`)).json();
    assert.equal(body.interval, "4h");
    assert.equal(body.minChecks, 4);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].bias, "BULLISH");
    assert.deepEqual(body.context.usdtDominance, dominance);
    assert.ok(body.updatedAt);
  });
});

test("a dominance provider failure degrades the context row, not the scan", async () => {
  const router = createDirectionalBiasRouter({
    signalScreenerService: stubScreener([screenerRow()]),
    usdtDominanceService: { async read() { throw new Error("CoinGecko 429"); } },
  });

  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/directional-bias`);
    assert.equal(res.status, 200, "the scan still answers");
    const body = await res.json();
    assert.equal(body.results[0].bias, "BULLISH");
    assert.equal(body.context.usdtDominance.percent, null);
    assert.match(body.context.usdtDominance.error, /CoinGecko 429/);
  });
});

test("the route works without a dominance service at all", async () => {
  const router = createDirectionalBiasRouter({ signalScreenerService: stubScreener([screenerRow()]) });

  await withServer(router, async (base) => {
    const body = await (await fetch(`${base}/api/directional-bias`)).json();
    assert.equal(body.context.usdtDominance, null);
  });
});

test("minChecks is clamped to what the screener supports", async () => {
  const router = createDirectionalBiasRouter({ signalScreenerService: stubScreener([screenerRow()]) });

  await withServer(router, async (base) => {
    assert.equal((await (await fetch(`${base}/api/directional-bias?minChecks=99`)).json()).minChecks, 6);
    assert.equal((await (await fetch(`${base}/api/directional-bias?minChecks=1`)).json()).minChecks, 3);
  });
});

// The whole point of projecting rather than rescanning: the pair of screener
// pages must cost one upstream pass over a symbol + interval, not two.
test("both screeners reuse one cached scan instead of hitting Binance twice", async () => {
  let fetches = 0;
  const candles = Array.from({ length: 300 }, (_, i) => {
    const close = 100 + i * 0.4;
    return [i * 14400000, close, close + 1, close - 1, close, 1000, i * 14400000 + 14399999];
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => candles };
  };
  try {
    const service = new SignalScreenerService({ cache: new MemoryCache(), tokens: ["BTCUSDT"] });
    const bias = await service.scanDirectionalBias("4h", 4);
    const extremes = await service.scanLocalExtremes("4h", 4);
    assert.equal(fetches, 1, "the second view must come from the cached scan");
    assert.equal(bias[0].symbol, "BTCUSDT");
    assert.equal(extremes[0].symbol, "BTCUSDT");
    // Same scan, so both views describe the same candle.
    assert.equal(bias[0].candleCloseTime, extremes[0].candleCloseTime);
    assert.equal(bias[0].computedAt, extremes[0].computedAt);
  } finally {
    global.fetch = originalFetch;
  }
});
