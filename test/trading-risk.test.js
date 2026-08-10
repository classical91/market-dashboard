"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { resolveAtr, calculatePositionSize, calculateLevels, planTrade } = require("../src/services/trading/risk");
const { makeTradingConfig } = require("../src/services/trading/config");

const config = makeTradingConfig();

test("ATR falls back to a fixed fraction of price when the signal carries none", () => {
  assert.equal(resolveAtr(64000, 800, config), 800);
  assert.equal(resolveAtr(64000, null, config), 640); // 1% of price
  assert.equal(resolveAtr(64000, 0, config), 640);
  assert.equal(resolveAtr(64000, -5, config), 640);
});

test("position size risks exactly the configured fraction of the account", () => {
  // $10k account, 1% risk, 10-point stop distance → $100 / 10 = 10 units.
  const size = calculatePositionSize({
    entryPrice: 100,
    stopLoss: 90,
    accountSize: 10000,
    riskPct: 0.01,
    sizeMultiplier: 1,
  });
  assert.equal(size, 10);
});

test("the size multiplier scales risk proportionally", () => {
  const args = { entryPrice: 100, stopLoss: 90, accountSize: 10000, riskPct: 0.01 };
  assert.equal(calculatePositionSize({ ...args, sizeMultiplier: 0.5 }), 5);
  assert.equal(calculatePositionSize({ ...args, sizeMultiplier: 0.25 }), 2.5);
  assert.equal(calculatePositionSize({ ...args, sizeMultiplier: 0 }), 0);
});

test("a zero stop distance sizes to zero rather than dividing by it", () => {
  assert.equal(
    calculatePositionSize({ entryPrice: 100, stopLoss: 100, accountSize: 10000, riskPct: 0.01, sizeMultiplier: 1 }),
    0,
  );
});

test("size never falls below the exchange minimum", () => {
  // A huge stop distance would size to almost nothing; the floor keeps the
  // order placeable rather than silently rounding to zero.
  const size = calculatePositionSize({
    entryPrice: 100,
    stopLoss: -900000,
    accountSize: 10000,
    riskPct: 0.01,
    sizeMultiplier: 1,
  });
  assert.equal(size, 0.001);
});

test("long levels put the stop below entry and both targets above", () => {
  const levels = calculateLevels({ entryPrice: 1000, atr: 100, direction: "LONG", config });
  assert.equal(levels.slDistance, 150); // 1.5 x ATR
  assert.equal(levels.stopLoss, 850);
  assert.equal(levels.tp1, 1225); // entry + 1.5R
  assert.equal(levels.tp2, 1375); // entry + 2.5R
});

test("short levels are the mirror image", () => {
  const levels = calculateLevels({ entryPrice: 1000, atr: 100, direction: "SHORT", config });
  assert.equal(levels.slDistance, 150);
  assert.equal(levels.stopLoss, 1150);
  assert.equal(levels.tp1, 775);
  assert.equal(levels.tp2, 625);
});

test("targets sit at the configured R multiples of the stop distance", () => {
  const levels = calculateLevels({ entryPrice: 1000, atr: 100, direction: "LONG", config });
  const risk = levels.tp1 - 1000;
  assert.equal(risk / levels.slDistance, config.tp1RMultiple);
  assert.equal((levels.tp2 - 1000) / levels.slDistance, config.tp2RMultiple);
});

test("planTrade returns a complete, self-consistent trade", () => {
  const plan = planTrade({
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 1000,
    atr: 100,
    sizeMultiplier: 1,
    config,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.stopLoss, 850);
  assert.equal(plan.riskUsd, 100); // 1% of $10k
  // Size × stop distance reproduces the intended dollar risk.
  assert.equal(Math.round(plan.size * (plan.entryPrice - plan.stopLoss)), plan.riskUsd);
});

test("planTrade halves the dollar risk on a half-size decision", () => {
  const plan = planTrade({ symbol: "BTCUSDT", direction: "LONG", entryPrice: 1000, atr: 100, sizeMultiplier: 0.5, config });
  assert.equal(plan.riskUsd, 50);
  assert.equal(Math.round(plan.size * (plan.entryPrice - plan.stopLoss)), 50);
});

test("planTrade refuses nonsensical input instead of guessing", () => {
  assert.equal(planTrade({ direction: "LONG", entryPrice: 0, sizeMultiplier: 1, config }).ok, false);
  assert.equal(planTrade({ direction: "SIDEWAYS", entryPrice: 100, sizeMultiplier: 1, config }).ok, false);
  assert.equal(planTrade({ direction: "LONG", entryPrice: 100, sizeMultiplier: 0, config }).ok, false);
});
