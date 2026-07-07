"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { StrategyEngineService, atrSeries, backtestStrategy, normalizeSymbol } = require("../src/services/strategy-engine");

function candle(i, close, spread = 1) {
  return {
    openTime: i * 3600000,
    high: close + spread,
    low: close - spread,
    close,
    volume: 1000,
    closeTime: i * 3600000 + 3599999,
  };
}

function breakoutCandles() {
  return [
    candle(0, 100),
    candle(1, 101),
    candle(2, 102),
    candle(3, 103),
    candle(4, 104),
    candle(5, 103),
    candle(6, 102),
    candle(7, 105, 1.5),
    candle(8, 109, 2),
    candle(9, 110, 1),
  ];
}

test("normalizeSymbol accepts base tickers and full USDT pairs", () => {
  assert.equal(normalizeSymbol("btc"), "BTCUSDT");
  assert.equal(normalizeSymbol("ETHUSDT"), "ETHUSDT");
});

test("atrSeries warms up and returns finite ATR values", () => {
  const result = atrSeries(breakoutCandles(), 2);
  assert.equal(result[1], null);
  assert.ok(Number.isFinite(result[8]));
});

test("backtestStrategy creates a conservative target win from an EMA breakout", () => {
  const result = backtestStrategy(breakoutCandles(), "1h", {
    trendEmaLen: 5,
    entryEmaLen: 3,
    rsiLen: 2,
    atrLen: 2,
    atrMultSL: 0.5,
    rr: 1,
    useVwap: false,
    feePct: 0,
    allowShort: false,
  });

  assert.equal(result.summary.trades, 1);
  assert.equal(result.trades[0].side, "LONG");
  assert.equal(result.trades[0].exitReason, "TARGET");
  assert.ok(result.summary.netPct > 0);
});

test("StrategyEngineService analyzes candles from the existing screener service", async () => {
  const service = new StrategyEngineService({
    signalScreenerService: {
      getCandles: async () => breakoutCandles(),
    },
  });

  const result = await service.analyze({
    symbol: "BTC",
    interval: "1h",
    options: {
      trendEmaLen: 5,
      entryEmaLen: 3,
      rsiLen: 2,
      atrLen: 2,
      atrMultSL: 0.5,
      rr: 1,
      useVwap: false,
      feePct: 0,
      allowShort: false,
    },
  });

  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.interval, "1h");
  assert.equal(result.summary.trades, 1);
});
