"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../public/assets/js/overview-v2-model");

test("bias breadth matches the screener strip and failures stay outside neutral", () => {
  const results = [
    ...Array.from({ length: 16 }, (_, i) => ({ symbol: `BEAR${i}`, bias: "BEARISH", score: 83, freshness: { state: "FRESH" } })),
    ...Array.from({ length: 9 }, (_, i) => ({ symbol: `FLAT${i}`, bias: "NEUTRAL", score: 50, freshness: { state: i ? "FRESH" : "STALE" } })),
    { symbol: "FAILED", error: "offline", bias: null },
  ];
  const summary = model.directional({ results });
  assert.equal(summary.lead, "RISK OFF");
  assert.equal(summary.subtitle, "16 with a directional bias");
  assert.deepEqual(summary.metrics.map((m) => m.value), [0, 16, 9]);
  assert.deepEqual(summary.health, { unavailable: 1, notFresh: 1 });
  assert.equal(model.directional({ results: [{ error: "offline" }] }).lead, "UNAVAILABLE");
});

test("extremes preserve both scores independently of trend direction", () => {
  const summary = model.extremes({ results: [{ symbol: "BTCUSDT", state: "CONFIRMED", dominant: "top", bottomScore: 45, topScore: 75, trend: "UP", freshness: { state: "FRESH" } }] });
  assert.deepEqual(summary.metrics.map((m) => m.value), [0, 1, 1]);
  assert.equal(summary.readings[0].value, "Bottom 45 / Top 75 · CONFIRMED");
});

test("pattern breadth uses the pattern bias before divergence just as the scanner does", () => {
  const summary = model.patterns({ results: [
    { symbol: "BTC", interval: "4h", pattern: { bias: "bearish", label: "Wedge" }, divergence: { bias: "bullish" } },
    { symbol: "ETH", interval: "1h", divergence: { bias: "bullish", label: "RSI divergence" } },
    { symbol: "SOL", interval: "1D", error: "offline" },
    { symbol: "XRP", interval: "1D" },
  ] });
  assert.equal(summary.lead, "BALANCED");
  assert.deepEqual(summary.metrics.map((m) => m.value), [1, 1, 0]);
  assert.equal(summary.health.unavailable, 1);
  assert.equal(model.patterns({ results: [{ error: "offline" }] }).lead, "UNAVAILABLE");
});

test("OI without change history never becomes zero growth or a bullish vote", () => {
  const summary = model.cryptoOi({ summary: { assetsWithOi: 1, assetsTracked: 25, totalOiUsd: 1e9, horizons: { "24h": { state: "UNKNOWN", changePct: null } } } });
  assert.equal(summary.lead, "NO CHANGE HISTORY");
  assert.equal(summary.metrics[1].value, "—");
  assert.equal(summary.metrics[2].value, "—");
});

test("weekly OI excludes absent comparisons but retains independent net speculator coverage", () => {
  const summary = model.crossOi({ source: { status: "CACHED", reportDate: "2026-11-10" }, rows: [
    { marketName: "Gold", metricType: "OI", normalizedValue: 3.1, freshness: { state: "STALE" } },
    { marketName: "Oil", metricType: "OI", normalizedValue: null },
    { marketName: "Gold", metricType: "COT_NET_SPEC", normalizedValue: -5 },
    { marketName: "Oil", metricType: "COT_NET_SPEC", normalizedValue: 4 },
  ] });
  assert.deepEqual(summary.metrics.map((m) => m.value), [1, 0, "1 / 2"]);
  assert.deepEqual(summary.health, { unavailable: 1, notFresh: 1 });
  assert.match(summary.subtitle, /CACHED/);
});

test("RSI does not average incomplete instruments or turn missing cells into zero", () => {
  const summary = model.rsi({ timeframes: ["1h", "4h"], instruments: [
    { label: "BTC", average: 72, averageState: "mtf-overbought", values: { "1h": 70, "4h": 74 }, freshness: { "1h": { barsBehind: 0 }, "4h": { barsBehind: 2 } } },
    { label: "ETH", average: null, values: { "1h": 29, "4h": null }, freshness: { "1h": { barsBehind: 0 } } },
  ] });
  assert.deepEqual(summary.metrics.map((m) => m.value), [1, 0, 1]);
  assert.equal(summary.health.unavailable, 1);
  assert.equal(summary.health.notFresh, 1);
  assert.equal(summary.readings.length, 1);
});
