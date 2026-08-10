"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { runChecklist, runKillSwitches, scoreSetup, marketState } = require("../src/services/trading/checklist");
const { makeTradingConfig } = require("../src/services/trading/config");

const config = makeTradingConfig();

const LONG = { symbol: "BTCUSDT", direction: "LONG", price: 64000, atr: 800 };
const SHORT = { symbol: "BTCUSDT", direction: "SHORT", price: 64000, atr: 800 };

// A textbook long: trend, macro and both triggers aligned, healthy volume,
// calm volatility, neutral funding.
function perfectLongState(overrides = {}) {
  return marketState({
    regime: "TREND_UP",
    dailyBias: "BULLISH",
    usdtDominanceSignal: "RISK_ON",
    btcDominanceRising: false,
    bearMarket: false,
    macdBullish: true,
    stochSignal: "OVERSOLD_CROSS",
    volumeRatio: 1.8,
    atrRatio: 1.1,
    fundingRate: 0.0001,
    ...overrides,
  });
}

test("a fully aligned long scores 100 and takes full size", () => {
  const result = runChecklist(LONG, perfectLongState(), config);
  assert.equal(result.confidenceScore, 100);
  assert.equal(result.decision, "TAKE_FULL");
  assert.equal(result.sizeMultiplier, 1);
});

test("size steps down with the score", () => {
  // Neutral bias (+15 instead of +30) and only one trigger firing.
  const half = runChecklist(LONG, perfectLongState({ dailyBias: "NEUTRAL", stochSignal: "NEUTRAL" }), config);
  assert.equal(half.decision, "TAKE_HALF");
  assert.equal(half.sizeMultiplier, 0.5);

  const quarter = runChecklist(
    LONG,
    perfectLongState({ dailyBias: "NEUTRAL", macdBullish: false, stochSignal: "NEUTRAL", volumeRatio: 1.1 }),
    config,
  );
  assert.equal(quarter.decision, "TAKE_QUARTER");
  assert.equal(quarter.sizeMultiplier, 0.25);
});

test("a DXY headwind cuts size by 25% without changing the decision", () => {
  const result = runChecklist(LONG, perfectLongState({ dxyBullish: true }), config);
  assert.equal(result.decision, "TAKE_FULL");
  assert.equal(result.sizeMultiplier, 0.75);
  assert.match(result.warnings.join(" "), /DXY bullish/);
});

test("missing indicator data scores zero rather than partial credit", () => {
  const state = perfectLongState({ macdBullish: null, stochSignal: null });
  const { score, reasons } = scoreSetup(LONG, state, config);
  assert.equal(score, 80); // 100 minus the 20 entry-trigger points
  assert.match(reasons.join(" "), /No indicator data \(\+0\)/);
});

test("kill switches fire before any score is computed", () => {
  const result = runChecklist(LONG, perfectLongState({ dailyLossPct: 3.5 }), config);
  assert.equal(result.decision, "SKIP");
  assert.equal(result.killSwitch, true);
  assert.equal(result.confidenceScore, 0);
  assert.match(result.killReason, /DAILY_LOSS_LIMIT/);
});

test("every kill switch has a reason and none fire on a clean state", () => {
  assert.equal(runKillSwitches(perfectLongState(), config), "");
  assert.match(runKillSwitches(marketState({ weeklyLossPct: 6 }), config), /WEEKLY_LOSS_LIMIT/);
  assert.match(runKillSwitches(marketState({ consecutiveLosses: 3 }), config), /CONSECUTIVE_LOSSES/);
  assert.match(runKillSwitches(marketState({ newsBlackout: true }), config), /NEWS_WINDOW/);
  assert.match(runKillSwitches(marketState({ atrRatio: 3.5 }), config), /VOLATILITY_SPIKE/);
});

test("the funding kill switch is symmetric — magnitude matters, not sign", () => {
  assert.match(runKillSwitches(marketState({ fundingRate: 0.002 }), config), /FUNDING_BLOCK/);
  assert.match(runKillSwitches(marketState({ fundingRate: -0.002 }), config), /FUNDING_BLOCK/);
  assert.equal(runKillSwitches(marketState({ fundingRate: 0.0005 }), config), "");
});

test("the regime gate forbids counter-trend entries and all entries in compression", () => {
  assert.match(
    runChecklist(LONG, perfectLongState({ regime: "TREND_DOWN" }), config).reasons.join(" "),
    /longs forbidden/,
  );
  assert.match(
    runChecklist(SHORT, perfectLongState({ regime: "TREND_UP" }), config).reasons.join(" "),
    /shorts forbidden/,
  );
  assert.match(
    runChecklist(LONG, perfectLongState({ regime: "LOW_COMPRESSION" }), config).reasons.join(" "),
    /no entries allowed/,
  );
});

test("position and total-risk limits skip the setup", () => {
  assert.equal(runChecklist(LONG, perfectLongState({ openPositions: 3 }), config).decision, "SKIP");
  assert.equal(runChecklist(LONG, perfectLongState({ totalRiskPct: 4 }), config).decision, "SKIP");
});

test("a bear market long needs 80+ to be allowed at all", () => {
  // bearMarket downgrades the macro block from "all green" to "partial", so a
  // would-be 100 lands at 90 and still clears the bar; losing the volume
  // points as well drops it to 75, under the bear-market floor.
  const allowed = runChecklist(LONG, perfectLongState({ bearMarket: true }), config);
  assert.equal(allowed.confidenceScore, 90);
  assert.equal(allowed.decision, "TAKE_FULL");

  const blocked = runChecklist(LONG, perfectLongState({ bearMarket: true, volumeRatio: 0.8 }), config);
  assert.equal(blocked.decision, "SKIP");
  assert.match(blocked.reasons[0], /Bear market long blocked/);
});

test("a short is scored against the mirror image of a long's conditions", () => {
  const state = marketState({
    regime: "TREND_DOWN",
    dailyBias: "BEARISH",
    usdtDominanceSignal: "RISK_OFF",
    btcDominanceRising: true,
    bearMarket: true,
    macdBullish: false,
    stochSignal: "OVERBOUGHT_CROSS",
    volumeRatio: 1.8,
    atrRatio: 1.1,
    fundingRate: 0.0001,
  });
  const result = runChecklist(SHORT, state, config);
  assert.equal(result.confidenceScore, 100);
  assert.equal(result.decision, "TAKE_FULL");
});
