"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { classifyWindow, detectDivergence, PatternScannerService, SCAN_INTERVALS } = require("../src/services/pattern-scanner");
const { MemoryCache } = require("../src/services/cache");

const DIVERGENCE_OPTS = {
  pivotOrder: 2,
  rsiLen: 14,
  divergenceMaxAge: 12,
  divergenceMinRsiDelta: 1.5,
  divergenceMinPriceDeltaPct: 0.1,
};

function candle(i, close) {
  return { openTime: i * 3600000, open: close, high: close + 0.3, low: close - 0.3, close, volume: 100 };
}

// Fast move to a first extreme, bounce, then a slower move to a second,
// further extreme: price sets a lower low (or higher high) while RSI, driven
// by the gentler pace, does not confirm — the classic divergence shape.
function makeDivergenceCandles(direction) {
  const sign = direction === "bullish" ? -1 : 1;
  const closes = [];
  let price = 100;
  for (let i = 0; i < 16; i++) closes.push(price); // RSI warm-up preamble
  for (let i = 0; i < 12; i++) { price += sign * 2; closes.push(price); } // fast leg
  for (let i = 0; i < 6; i++) { price -= sign * 1.5; closes.push(price); } // retrace
  for (let i = 0; i < 20; i++) { price += sign * 0.5; closes.push(price); } // slow leg past the first extreme
  for (let i = 0; i < 3; i++) { price -= sign * 1; closes.push(price); } // turn, forming the second pivot
  return closes.map((c, i) => candle(i, c));
}

// Builds a synthetic zigzag price series that oscillates between two
// trendlines (upperStart/upperSlope for the highs, lowerStart/lowerSlope for
// the lows) so pivot detection has real fractal highs/lows to fit against —
// a straight line has no pivots at all.
function makeZigzagCandles({ count, upperStart, upperSlope, lowerStart, lowerSlope, volume }) {
  const candles = [];
  const period = 6;
  for (let i = 0; i < count; i++) {
    const upper = upperStart + upperSlope * i;
    const lower = lowerStart + lowerSlope * i;
    // Oscillate between the two trendlines: 1 (touching upper) at phase 0,
    // -1 (touching lower) at phase 3, so pivot detection has real fractal
    // highs/lows to fit against — a straight line has no pivots at all.
    const cyclePos = (i % period) / period;
    const wave = Math.cos(cyclePos * 2 * Math.PI);
    const mid = (upper + lower) / 2;
    const amp = (upper - lower) / 2;
    const close = mid + amp * wave;
    candles.push({
      openTime: i,
      open: close,
      high: close + Math.abs(amp) * 0.02 + 0.01,
      low: close - Math.abs(amp) * 0.02 - 0.01,
      close,
      volume: volume(i),
    });
  }
  return candles;
}

test("classifyWindow detects a rising wedge (converging, both slopes up)", () => {
  const candles = makeZigzagCandles({
    count: 36,
    upperStart: 100,
    upperSlope: 0.15,
    lowerStart: 90,
    lowerSlope: 0.35,
    volume: () => 100,
  });
  const result = classifyWindow(candles, {
    window: 36,
    impulseWindow: 20,
    pivotOrder: 2,
    minR2: 0.3,
    impulseMin: 0.04,
    breakoutBuffer: 0.002,
  });
  assert.ok(result, "expected a pattern to be detected");
  assert.equal(result.pattern, "Rising Wedge");
  assert.equal(result.bias, "bearish");
});

test("classifyWindow detects a falling wedge (converging, both slopes down)", () => {
  const candles = makeZigzagCandles({
    count: 36,
    upperStart: 110,
    upperSlope: -0.35,
    lowerStart: 90,
    lowerSlope: -0.1,
    volume: () => 100,
  });
  const result = classifyWindow(candles, {
    window: 36,
    impulseWindow: 20,
    pivotOrder: 2,
    minR2: 0.3,
    impulseMin: 0.04,
    breakoutBuffer: 0.002,
  });
  assert.ok(result, "expected a pattern to be detected");
  assert.equal(result.pattern, "Falling Wedge");
  assert.equal(result.bias, "bullish");
});

test("detectDivergence flags a regular bullish divergence (price LL, RSI HL)", () => {
  const result = detectDivergence(makeDivergenceCandles("bullish"), DIVERGENCE_OPTS);
  assert.ok(result, "expected a divergence to be detected");
  assert.equal(result.type, "Regular Bullish");
  assert.equal(result.bias, "bullish");
  assert.ok(result.priceDeltaPct < 0, "price should have made a lower low");
  assert.ok(result.rsiDelta > 0, "RSI should have made a higher low");
});

test("detectDivergence flags a regular bearish divergence (price HH, RSI LH)", () => {
  const result = detectDivergence(makeDivergenceCandles("bearish"), DIVERGENCE_OPTS);
  assert.ok(result, "expected a divergence to be detected");
  assert.equal(result.type, "Regular Bearish");
  assert.equal(result.bias, "bearish");
  assert.ok(result.priceDeltaPct > 0, "price should have made a higher high");
  assert.ok(result.rsiDelta < 0, "RSI should have made a lower high");
});

test("scanAll scans every configured token across every timeframe", async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(url);
    const rows = [];
    for (let i = 0; i < 90; i++) {
      rows.push([i * 3600000, "100", "100.3", "99.7", "100", "100"]);
    }
    return { ok: true, json: async () => rows };
  };
  try {
    const service = new PatternScannerService({ cache: new MemoryCache(), tokens: ["BTCUSDT", "ETHUSDT"] });
    const results = await service.scanAll();
    assert.equal(results.length, 2 * SCAN_INTERVALS.length);
    const intervals = new Set(results.filter((r) => r.symbol === "BTCUSDT").map((r) => r.interval));
    assert.deepEqual([...intervals].sort(), [...SCAN_INTERVALS].sort());
    assert.ok(results.every((r) => !r.error), "no scan should error");
  } finally {
    global.fetch = originalFetch;
  }
});

test("scanToken hits carry drawable chart geometry with rebased coordinates", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    // Falling-wedge shaped klines: converging zigzag between two down-sloping
    // trendlines. Gentler slopes than the classifyWindow tests because this
    // series is 90 bars long — steeper lines would cross before the end,
    // inverting the channel inside the scan window.
    const rows = [];
    for (let i = 0; i < 90; i++) {
      const upper = 110 + -0.15 * i;
      const lower = 90 + -0.05 * i;
      const mid = (upper + lower) / 2;
      const amp = (upper - lower) / 2;
      const wave = Math.cos(((i % 6) / 6) * 2 * Math.PI);
      const close = mid + amp * wave;
      rows.push([i * 3600000, String(close), String(close + Math.abs(amp) * 0.02 + 0.01), String(close - Math.abs(amp) * 0.02 - 0.01), String(close), "100"]);
    }
    return { ok: true, json: async () => rows };
  };
  try {
    const service = new PatternScannerService({ cache: new MemoryCache(), tokens: ["BTCUSDT"] });
    const result = await service.scanToken("BTCUSDT", "4h");
    assert.ok(result.pattern, "expected a pattern hit");
    assert.ok(result.chart, "hit should include chart data");
    assert.ok(Array.isArray(result.chart.candles) && result.chart.candles.length >= 36);
    const p = result.chart.pattern;
    assert.ok(p, "chart should include pattern trendlines");
    assert.ok(p.x0 >= 0 && p.x1 < result.chart.candles.length, "line x coords must fall inside the candle slice");
    [p.upper.y0, p.upper.y1, p.lower.y0, p.lower.y1].forEach((v) => assert.ok(Number.isFinite(v)));
    assert.ok(!("lines" in result.pattern), "raw geometry should live on chart, not the pattern summary");
  } finally {
    global.fetch = originalFetch;
  }
});

test("classifyWindow returns null for a flat, non-converging channel", () => {
  const candles = makeZigzagCandles({
    count: 36,
    upperStart: 105,
    upperSlope: 0,
    lowerStart: 95,
    lowerSlope: 0,
    volume: () => 100,
  });
  const result = classifyWindow(candles, {
    window: 36,
    impulseWindow: 20,
    pivotOrder: 2,
    minR2: 0.3,
    impulseMin: 0.04,
    breakoutBuffer: 0.002,
  });
  assert.equal(result, null);
});
