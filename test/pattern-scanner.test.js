"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { classifyWindow } = require("../src/services/pattern-scanner");

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
