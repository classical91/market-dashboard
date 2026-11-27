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

test("a rising wedge that breaks above its upper trendline has bullish breakout bias", () => {
  const candles = makeZigzagCandles({
    count: 36, upperStart: 100, upperSlope: 0.15, lowerStart: 90, lowerSlope: 0.35, volume: () => 100,
  });
  const opts = {
    window: 36, pivotOrder: 3, minR2: 0.35, impulseMin: 0.04, breakoutBuffer: 0.002,
  };
  candles.at(-1).close = 110;
  candles.at(-1).high = 110.03;
  const breakout = classifyWindow(candles, opts);
  assert.equal(breakout.pattern, "Rising Wedge");
  assert.equal(breakout.setupBias, "bearish");
  assert.equal(breakout.bias, "bullish");
  assert.equal(breakout.status, "breakout");
  assert.equal(breakout.breakoutCrossed, true);

  candles.at(-2).close = 110;
  candles.at(-2).high = 110.03;
  const alreadyOutside = classifyWindow(candles, opts);
  assert.equal(alreadyOutside.status, "breakout");
  assert.equal(alreadyOutside.breakoutCrossed, false);
});

test("scanToken detects flags using the candles before the consolidation window", async (t) => {
  for (const { start, step, slope, name } of [
    { start: 90, step: 1, slope: -0.18, name: "Bull Flag" },
    { start: 130, step: -1, slope: 0.18, name: "Bear Flag" },
  ]) {
    const pole = Array.from({ length: 20 }, (_, i) => ({ ...candle(i, start + step * i), volume: 200 }));
    const consolidation = makeZigzagCandles({
      count: 36, upperStart: 112, lowerStart: 106, upperSlope: slope, lowerSlope: slope, volume: () => 100,
    });
    const rows = [...pole, ...consolidation].map((c, i) => [i, c.open, c.high, c.low, c.close, c.volume, i + 1]);
    const fetchMock = t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => rows }));
    const service = new PatternScannerService({ cache: new MemoryCache() });
    const result = await service.scanToken("BTCUSDT", "1h");
    assert.equal(result.pattern?.pattern, name);
    assert.equal(result.pattern.volumeRatio, 0.5);
    assert.equal(Math.sign(result.pattern.impulseReturnPct), step);
    fetchMock.mock.restore();
  }
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

test("a scan reports the closed candle it ran on alongside when it ran", async () => {
  // scannedAt alone cannot distinguish a quiet scan from one whose feed has
  // stopped advancing; the candle it saw can.
  const originalFetch = global.fetch;
  const rows = [];
  for (let i = 0; i < 90; i++) {
    rows.push([i * 3600000, "100", "100.3", "99.7", "100", "100", i * 3600000 + 3599999]);
  }
  const lastClosed = 89 * 3600000 + 3599999;
  rows.push([90 * 3600000, "100", "100.3", "99.7", "100", "100", Date.now() + 3600000]);

  global.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    const service = new PatternScannerService({ cache: new MemoryCache(), tokens: ["BTCUSDT"] });
    const result = await service.scanToken("BTCUSDT", "1h");
    assert.equal(result.candleCloseTime, lastClosed, "the unclosed candle is dropped from the scan and from its timestamp");
    assert.ok(Date.parse(result.scannedAt) > 0);
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Request pacing: concurrency cap, in-flight coalescing, rate limits ---

function flatKlineRows() {
  const rows = [];
  for (let i = 0; i < 90; i++) rows.push([i * 3600000, "100", "100.3", "99.7", "100", "100", i * 3600000 + 3599999]);
  return rows;
}

function urlKey(url) {
  const u = new URL(url);
  return `${u.searchParams.get("symbol")}:${u.searchParams.get("interval")}`;
}

test("scanAll never has more Binance requests in flight than the concurrency cap", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return { ok: true, status: 200, json: async () => flatKlineRows() };
  });
  const tokens = Array.from({ length: 20 }, (_, i) => `T${i}USDT`);
  const service = new PatternScannerService({ cache: new MemoryCache(), tokens, fetchOptions: { concurrency: 4 } });
  // Two overlapping scans with different universes still share one cap.
  const [all, extra] = await Promise.all([
    service.scanAll({ force: true }),
    service.scanAll({ force: true, symbols: ["X1USDT", "X2USDT", "X3USDT"] }),
  ]);
  assert.equal(all.length, 20 * SCAN_INTERVALS.length);
  assert.equal(extra.length, 3 * SCAN_INTERVALS.length);
  assert.equal(calls, 23 * SCAN_INTERVALS.length);
  assert.ok(maxInFlight <= 4, `max in flight was ${maxInFlight}`);
  assert.equal(maxInFlight, 4, "the cap should actually be used");
  // Job order is preserved: symbol-major, then SCAN_INTERVALS order.
  assert.deepEqual(
    all.slice(0, 4).map((r) => `${r.symbol}:${r.interval}`),
    ["T0USDT:1h", "T0USDT:4h", "T0USDT:1D", "T1USDT:1h"],
  );
  assert.ok(all.every((r) => !r.error));
});

test("overlapping forced scans fetch each symbol/interval once", async (t) => {
  const perKey = new Map();
  t.mock.method(global, "fetch", async (url) => {
    const key = urlKey(url);
    perKey.set(key, (perKey.get(key) || 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, status: 200, json: async () => flatKlineRows() };
  });
  const service = new PatternScannerService({ cache: new MemoryCache(), tokens: ["BTCUSDT", "ETHUSDT"] });
  const [a, b, c] = await Promise.all([
    service.scanAll({ force: true }),
    service.scanAll({ force: true }),
    service.scanToken("BTCUSDT", "4h"),
  ]);
  assert.equal(perKey.size, 2 * SCAN_INTERVALS.length);
  for (const [key, count] of perKey) assert.equal(count, 1, `${key} fetched ${count} times`);
  assert.deepEqual(a.map((r) => r.symbol + r.interval), b.map((r) => r.symbol + r.interval));
  assert.ok(!c.error);

  // Once the first load settles, a new forced refresh fetches again.
  await service.scanToken("BTCUSDT", "4h", { force: true });
  assert.equal(perKey.get("BTCUSDT:4h"), 2);
});

test("a 429 respects Retry-After, pauses other requests, and is retried", async (t) => {
  const sleeps = [];
  let calls = 0;
  t.mock.method(global, "fetch", async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: new Headers({ "Retry-After": "2" }), json: async () => ({}) };
    return { ok: true, status: 200, json: async () => flatKlineRows() };
  });
  const service = new PatternScannerService({
    cache: new MemoryCache(),
    tokens: ["BTCUSDT"],
    fetchOptions: { concurrency: 1 },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const results = await service.scanAll();
  assert.ok(results.every((r) => !r.error), JSON.stringify(results.map((r) => r.error)));
  assert.equal(calls, 1 + SCAN_INTERVALS.length, "only the rate-limited job is re-requested");
  assert.ok(sleeps.length >= 1);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 2000), `sleeps: ${sleeps}`);
  assert.equal(sleeps[0] > 1500, true, "the first wait follows Retry-After");
});

test("a persistent 429 is reported on that job only", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    if (urlKey(url) === "BTCUSDT:1h") return { ok: false, status: 429, headers: new Headers(), json: async () => ({}) };
    return { ok: true, status: 200, json: async () => flatKlineRows() };
  });
  const sleeps = [];
  const service = new PatternScannerService({
    cache: new MemoryCache(),
    tokens: ["BTCUSDT", "ETHUSDT"],
    fetchOptions: { maxRetries: 2, retryBaseMs: 10 },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const results = await service.scanAll();
  assert.equal(results.length, 2 * SCAN_INTERVALS.length);
  const failed = results.filter((r) => r.error);
  assert.deepEqual(failed.map((r) => `${r.symbol}:${r.interval}`), ["BTCUSDT:1h"]);
  assert.match(failed[0].error, /rate limited HTTP 429/);
  assert.equal(failed[0].pattern, null);
  assert.equal(global.fetch.mock.calls.filter((c) => urlKey(c.arguments[0]) === "BTCUSDT:1h").length, 3);
});

test("a long 418 ban fails fast per job and stops further requests", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    if (urlKey(url) === "BTCUSDT:1h") return { ok: false, status: 418, headers: new Headers({ "Retry-After": "600" }), json: async () => ({}) };
    return { ok: true, status: 200, json: async () => flatKlineRows() };
  });
  const sleeps = [];
  const service = new PatternScannerService({
    cache: new MemoryCache(),
    tokens: ["BTCUSDT", "ETHUSDT"],
    fetchOptions: { concurrency: 1 },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const results = await service.scanAll();
  assert.equal(results.length, 2 * SCAN_INTERVALS.length);
  assert.match(results[0].error, /rate limited HTTP 418.*retry after 600s/);
  for (const r of results.slice(1)) assert.match(r.error, /cooling down/, `${r.symbol}:${r.interval}`);
  assert.equal(global.fetch.mock.calls.length, 1, "no request is sent during the ban");
  assert.deepEqual(sleeps, [], "a ban longer than maxRetryWaitMs is never waited out");
});
