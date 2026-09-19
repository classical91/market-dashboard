"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  WEIGHTS,
  calculateLocalExtremes,
  classifyExtremeState,
  detectRegularDivergence,
  findLiquiditySweep,
} = require("../src/services/local-extreme-engine");

function candle(close, { open = close, high = close + 1, low = close - 1, volume = 100, index = 0 } = {}) {
  return {
    openTime: index * 3_600_000,
    open,
    high,
    low,
    close,
    volume,
    closeTime: index * 3_600_000 + 3_599_999,
  };
}

test("local-extreme weights remain independent and total 100", () => {
  assert.deepEqual(WEIGHTS, {
    priceLocation: 15,
    momentum: 10,
    divergence: 20,
    liquidity: 20,
    volume: 15,
    confirmation: 20,
  });
  assert.equal(Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100);
});

test("confirmation changes candidate state without implying certainty", () => {
  assert.equal(classifyExtremeState(39, false), "NONE");
  assert.equal(classifyExtremeState(40, false), "WATCH");
  assert.equal(classifyExtremeState(74, false), "CANDIDATE");
  assert.equal(classifyExtremeState(80, false), "CANDIDATE");
  assert.equal(classifyExtremeState(80, true), "CONFIRMING");
  assert.equal(classifyExtremeState(85, true), "CONFIRMED");
});

test("regular divergence only treats lower-low/higher-RSI as bullish reversal evidence", () => {
  const swings = {
    lows: [{ index: 2, price: 95 }, { index: 6, price: 92 }],
    highs: [],
  };
  const bullishRsi = [null, null, 22, null, null, null, 31];
  const hiddenRsi = [null, null, 35, null, null, null, 28];
  assert.ok(detectRegularDivergence(swings, bullishRsi, "bottom"));
  assert.equal(detectRegularDivergence(swings, hiddenRsi, "bottom"), null);
});

test("liquidity sweep requires taking the level and closing back through it", () => {
  const candles = [
    candle(100, { low: 99, index: 0 }),
    candle(96, { low: 95, index: 1 }),
    candle(101, { low: 100, index: 2 }),
    candle(102, { low: 101, index: 3 }),
    candle(97, { low: 94, index: 4 }),
  ];
  const swings = { lows: [{ index: 1, price: 95 }], highs: [] };
  const sweep = findLiquiditySweep(candles, swings, "bottom", 3);
  assert.equal(sweep.level, 95);
  assert.equal(sweep.extreme, 94);

  candles[4] = candle(94, { low: 93, index: 4 });
  assert.equal(findLiquiditySweep(candles, swings, "bottom", 3), null, "a close below the level is continuation, not a sweep");
});

test("a reclaimed lower-band selloff produces a bottom score without altering a directional score", () => {
  const candles = Array.from({ length: 200 }, (_, index) => {
    const close = 100 + Math.sin(index / 3) * 0.4;
    return candle(close, { open: close - 0.1, high: close + 0.7, low: close - 0.7, index });
  });
  const additions = [
    candle(100, { high: 101, low: 99, index: 200 }),
    candle(93, { open: 100, high: 100, low: 92, index: 201 }),
    candle(99, { open: 93, high: 100, low: 93, index: 202 }),
    candle(101, { high: 102, low: 98, index: 203 }),
    candle(100, { high: 101, low: 98, index: 204 }),
    candle(94, { open: 100, high: 100, low: 90, volume: 320, index: 205 }),
    candle(99, { open: 94, high: 100, low: 93, index: 206 }),
    candle(103, { open: 99, high: 104, low: 98, index: 207 }),
  ];
  const result = calculateLocalExtremes(candles.concat(additions));
  assert.ok(result.bottom.score >= 60, `expected a meaningful bottom score, received ${result.bottom.score}`);
  assert.ok(result.bottom.score > result.top.score);
  assert.equal(result.dominant, "bottom");
  assert.match(result.bottom.state, /CONFIRMING|CONFIRMED/);
  assert.ok(result.bottom.reasons.some((reason) => reason.key === "priceLocation"));
  assert.ok(result.bottom.reasons.some((reason) => reason.key === "confirmation"));
  assert.ok(["trend-pullback bottom", "reversal bottom"].includes(result.context.setupType));
});
