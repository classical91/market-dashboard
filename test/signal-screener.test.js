"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { rsi, ema, macd, vwapSeries, adxSeries, dropUnclosedCandle, SignalScreenerService } = require("../src/services/signal-screener");
const { MemoryCache } = require("../src/services/cache");

test("ema converges to a constant series' value", () => {
  const closes = new Array(60).fill(42);
  const result = ema(closes, 20);
  assert.equal(result[59], 42);
});

test("rsi hits 100 on an unbroken uptrend and 0 on an unbroken downtrend", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(up, 14)[29], 100);
  assert.equal(rsi(down, 14)[29], 0);
});

test("macd line is positive when a fast EMA is above a slow EMA (steady uptrend)", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
  const { macdLine, signalLine } = macd(closes, 12, 26, 9);
  const last = closes.length - 1;
  assert.ok(macdLine[last] > 0, "macd line should be positive in a steady uptrend");
  assert.ok(signalLine[last] != null, "signal line should be computed once warmed up");
});

test("vwapSeries resets at each UTC day boundary", () => {
  const dayMs = 86400000;
  const candles = [
    { openTime: 0, high: 10, low: 10, close: 10, volume: 100 },
    { openTime: 1000, high: 20, low: 20, close: 20, volume: 100 },
    // New UTC day: VWAP should reset and not be dragged down by day 1's prices.
    { openTime: dayMs, high: 100, low: 100, close: 100, volume: 100 },
  ];
  const result = vwapSeries(candles);
  assert.equal(result[2], 100);
});

test("adxSeries returns null until warmed up, then a finite number", () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({
    openTime: i * 3600000,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
    volume: 100,
  }));
  const result = adxSeries(candles, 14);
  assert.equal(result[10], null);
  assert.ok(Number.isFinite(result[59]));
});

test("dropUnclosedCandle removes only a still-open last candle", () => {
  const now = 1000000;
  const closed = [{ close: 1, closeTime: now - 100 }, { close: 2, closeTime: now - 50 }];
  assert.equal(dropUnclosedCandle(closed, now).length, 2, "fully closed series stays intact");

  const withOpen = [...closed, { close: 3, closeTime: now + 500 }];
  const result = dropUnclosedCandle(withOpen, now);
  assert.equal(result.length, 2, "the open candle is dropped");
  assert.equal(result[1].close, 2);

  assert.equal(dropUnclosedCandle([], now).length, 0, "empty input stays empty");
});

test("a wild still-open candle cannot flip the signal, but is shown as the live price", async () => {
  const rows = [];
  for (let i = 0; i < 500; i++) {
    const price = 100 + i * 0.3;
    // closeTime far in the past = closed.
    rows.push([i * 3600000, String(price), String(price + 1), String(price - 1), String(price), "1000", i * 3600000 + 3599999]);
  }
  // Live, unclosed candle crashing -50%: on the old behavior this would flip
  // several checks (RSI, VWAP, EMA200) intrabar; it must be ignored for the
  // signal while still supplying the displayed price.
  rows.push([500 * 3600000, "125", "126", "120", "124", "1000", Date.now() + 60 * 60 * 1000]);

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    const service = new SignalScreenerService({ cache: new MemoryCache(), tokens: ["BTCUSDT"] });
    const result = await service.scanToken("BTCUSDT", "1h", 4);
    assert.equal(result.signal, "LONG", "signal must come from closed candles only");
    assert.equal(result.price, 124, "displayed price should still be the live close");
  } finally {
    global.fetch = originalFetch;
  }
});

test("SignalScreenerService.scanToken reports a LONG signal for a strong steady uptrend", async () => {
  const candles = [];
  for (let i = 0; i < 500; i++) {
    const price = 100 + i * 0.3;
    candles.push([i * 3600000, price, price + 1, price - 1, price, "1000"]);
  }
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => candles });
  try {
    const service = new SignalScreenerService({ cache: new MemoryCache(), tokens: ["BTCUSDT"] });
    const result = await service.scanToken("BTCUSDT", "1h", 4);
    assert.equal(result.symbol, "BTCUSDT");
    assert.equal(result.signal, "LONG");
    assert.ok(result.score >= 50);
  } finally {
    global.fetch = originalFetch;
  }
});
