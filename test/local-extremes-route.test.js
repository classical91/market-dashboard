"use strict";

// The Local Extremes route is a projection of local-extreme-engine.js output.
// These pin the properties that make the page readable: both scores stay
// independent, the dominant side is reported without replacing the other one,
// state and evidence survive the trip, and nothing turns a location into a
// buy or sell instruction.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const { createLocalExtremesRouter } = require("../src/routes/local-extremes");
const { toLocalExtremes } = require("../src/services/screener-projections");

function side(score, state, reasons, components, metrics) {
  return {
    score,
    state,
    tier: "High-confluence extreme",
    confirmed: Boolean(components.confirmation),
    reasons: reasons.map((label, index) => ({ key: `k${index}`, label, weight: 20 - index })),
    components,
    metrics,
  };
}

function screenerRow(overrides = {}) {
  return {
    symbol: "APTUSDT",
    signal: "LONG",
    score: 67,
    price: 0.727,
    candleCloseTime: 1_700_000_000_000,
    computedAt: new Date(1_700_000_000_000).toISOString(),
    extreme: {
      bottom: side(45, "WATCH", ["Volume climax 1.9×"], {
        priceLocation: false, momentum: false, divergence: false, liquidity: false, volume: true, confirmation: false,
      }, { zScore: null, rsi: null, volumeRatio: 1.9, sweptLevel: null }),
      top: side(100, "CONFIRMED", [
        "Regular bearish divergence",
        "Swing high swept",
        "Upper BB excursion",
        "Volume climax 1.9×",
        "Bearish structure break",
      ], {
        priceLocation: true, momentum: true, divergence: true, liquidity: true, volume: true, confirmation: true,
      }, { zScore: 2.3, rsi: 74.2, volumeRatio: 1.9, sweptLevel: 0.721 }),
      dominant: "top",
      state: "CONFIRMED",
      mainReason: "Regular bearish divergence + Swing high swept",
      context: { trend: "UPTREND", priceAboveEma200: true, ema200: 0.7, setupType: "reversal top" },
    },
    ...overrides,
  };
}

async function withServer(router, run) {
  const app = express();
  app.use("/api/local-extremes", router);
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
    async scanLocalExtremes(interval) {
      return rows.map((row) => toLocalExtremes(row, interval));
    },
  };
}

test("bottom and top scores stay independent, both sides in full", () => {
  const row = toLocalExtremes(screenerRow(), "4h");
  assert.equal(row.bottomScore, 45);
  assert.equal(row.topScore, 100);
  // The losing side is not collapsed away: "Bottom 45 / Top 100" is the
  // reading, and a reader must be able to see the other side building.
  assert.equal(row.bottom.score, 45);
  assert.equal(row.bottom.state, "WATCH");
  assert.deepEqual(row.bottom.reasons, ["Volume climax 1.9×"]);
  assert.equal(row.top.score, 100);
});

test("the dominant side and its state are preserved", () => {
  const row = toLocalExtremes(screenerRow(), "4h");
  assert.equal(row.dominant, "top");
  assert.equal(row.state, "CONFIRMED");
  assert.equal(row.setupType, "reversal top");
  assert.equal(row.trend, "UPTREND");
});

test("evidence reasons and metrics survive the projection", () => {
  const row = toLocalExtremes(screenerRow(), "4h");
  assert.deepEqual(row.reasons, [
    "Regular bearish divergence",
    "Swing high swept",
    "Upper BB excursion",
    "Volume climax 1.9×",
    "Bearish structure break",
  ]);
  assert.deepEqual(row.metrics, { zScore: 2.3, rsi: 74.2, volumeRatio: 1.9, sweptLevel: 0.721 });
  assert.deepEqual(row.components, {
    priceLocation: true, momentum: true, divergence: true, liquidity: true, volume: true, confirmation: true,
  });
});

test("a bullish bias and a confirmed top coexist — neither rewrites the other", () => {
  // The row below is LONG on the screener and CONFIRMED on the top side.
  // Nothing in the payload resolves that into one verdict, and no BUY/SELL
  // or LONG/SHORT vocabulary appears anywhere in it.
  const row = toLocalExtremes(screenerRow({ signal: "LONG" }), "4h");
  assert.equal(row.dominant, "top");
  assert.equal(row.state, "CONFIRMED");
  const serialized = JSON.stringify(row);
  for (const word of ["BUY", "SELL", "LONG", "SHORT"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${word}"`), `${word} must not appear in a location payload`);
  }
});

test("a row with no extreme reports NONE rather than a missing state", () => {
  const quiet = screenerRow({
    extreme: {
      bottom: side(0, "NONE", [], { priceLocation: false, momentum: false, divergence: false, liquidity: false, volume: false, confirmation: false }, { zScore: null, rsi: null, volumeRatio: null, sweptLevel: null }),
      top: side(15, "NONE", [], { priceLocation: false, momentum: false, divergence: false, liquidity: false, volume: true, confirmation: false }, { zScore: null, rsi: null, volumeRatio: 1.6, sweptLevel: null }),
      dominant: null,
      state: "NONE",
      mainReason: null,
      context: { trend: "DOWNTREND", priceAboveEma200: false, ema200: 0.8, setupType: "none" },
    },
  });
  const row = toLocalExtremes(quiet, "4h");
  assert.equal(row.dominant, null);
  assert.equal(row.state, "NONE");
  assert.equal(row.bottomScore, 0);
  assert.equal(row.topScore, 15);
  assert.deepEqual(row.reasons, []);
});

test("error rows and warm-up rows degrade without faking scores", () => {
  const failed = toLocalExtremes({ symbol: "APTUSDT", error: "Binance klines HTTP 451" }, "4h");
  assert.match(failed.error, /HTTP 451/);
  assert.equal(failed.bottomScore, null, "a failure must not read as a zero score");
  assert.equal(failed.topScore, null);
  assert.equal(failed.state, null);
  assert.equal(failed.freshness.state, "UNKNOWN");

  const warming = toLocalExtremes(
    { symbol: "APTUSDT", price: 1, extreme: { error: "Not enough candle history for local-extreme scoring" } },
    "4h",
  );
  assert.match(warming.error, /Not enough candle history/);
  assert.equal(warming.bottomScore, null);
});

test("rows carry the shared freshness assessment on the screener's clock", () => {
  const now = 1_700_000_000_000 + 60_000;
  assert.equal(toLocalExtremes(screenerRow(), "4h", now).freshness.state, "FRESH");
  assert.equal(toLocalExtremes(screenerRow(), "4h", now + 7 * 60 * 60 * 1000).freshness.state, "STALE");
});

test("the route answers with the scan, the interval and an assembly stamp", async () => {
  const router = createLocalExtremesRouter({ signalScreenerService: stubScreener([screenerRow()]) });

  await withServer(router, async (base) => {
    const body = await (await fetch(`${base}/api/local-extremes?interval=1D`)).json();
    assert.equal(body.interval, "1D");
    assert.equal(body.minChecks, 4, "the default matches the bias route so both share one cache entry");
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].topScore, 100);
    assert.equal(body.results[0].bottomScore, 45);
    assert.ok(body.updatedAt);
  });
});

test("a screener failure surfaces as an error response, not a silent empty scan", async () => {
  const router = createLocalExtremesRouter({
    signalScreenerService: { async scanLocalExtremes() { throw new Error("screener down"); } },
  });
  const app = express();
  app.use("/api/local-extremes", router);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/local-extremes`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /screener down/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
