"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { assessEdge } = require("../src/services/trading/edge-gate");
const { makeTradingConfig } = require("../src/services/trading/config");

const config = makeTradingConfig();

function trades(count, { pnl, r, strategy = "alpha", symbol = "BTCUSDT", score = 82 }) {
  return Array.from({ length: count }, () => ({
    status: "closed",
    realizedPnl: pnl,
    rMultiple: r,
    signalSource: strategy,
    symbol,
    confidenceScore: score,
  }));
}

function assess(history, overrides = {}) {
  return assessEdge({
    history,
    startingBalance: 10000,
    strategy: "alpha",
    symbol: "BTCUSDT",
    score: 82,
    config,
    ...overrides,
  });
}

test("an empty history is allowed through at full size as a learning trade", () => {
  const result = assess([]);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.sizeMultiplier, 1);
  assert.match(result.reasons[0], /EDGE_LEARNING/);
});

test("a sample below the minimum is still allowed, but says so", () => {
  const result = assess(trades(5, { pnl: -100, r: -1 }));
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.sizeMultiplier, 1);
  assert.match(result.reasons.join(" "), /sample 5\/20/);
});

test("a large sample with negative expectancy is blocked", () => {
  const result = assess(trades(25, { pnl: -100, r: -1 }));
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.sizeMultiplier, 0);
  assert.match(result.reasons.join(" "), /expectancy below/);
});

test("a strong, deep sample is allowed at full size", () => {
  const result = assess(trades(25, { pnl: 200, r: 2 }));
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.sizeMultiplier, 1);
  assert.match(result.reasons.join(" "), /EDGE_ALLOW/);
});

test("a positive but thin edge is halved rather than blocked", () => {
  // Alternating +1R / -0.9R: expectancy lands between the soft and hard
  // thresholds, so size is reduced instead of refused.
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push(
      i % 2 === 0
        ? { status: "closed", realizedPnl: 100, rMultiple: 1, signalSource: "alpha", symbol: "BTCUSDT", confidenceScore: 82 }
        : { status: "closed", realizedPnl: -90, rMultiple: -0.9, signalSource: "alpha", symbol: "BTCUSDT", confidenceScore: 82 },
    );
  }
  const result = assess(history);
  assert.equal(result.decision, "REDUCE");
  assert.equal(result.sizeMultiplier, 0.5);
  assert.match(result.reasons.join(" "), /EDGE_REDUCE/);
});

test("a weak profit factor blocks even when expectancy clears the floor", () => {
  const result = assess(trades(25, { pnl: 1, r: 0.2 }).concat(
    // One big loss drags the profit factor under 1.10 while expectancy in R
    // terms stays positive, because R and dollars need not agree.
    Array.from({ length: 5 }, () => ({
      status: "closed", realizedPnl: -100, rMultiple: 0.2, signalSource: "alpha", symbol: "BTCUSDT", confidenceScore: 82,
    })),
  ));
  assert.equal(result.decision, "BLOCK");
  assert.match(result.reasons.join(" "), /profit factor below/);
});

test("the most specific evidence wins: strategy history outranks the summary", () => {
  // The account overall is profitable, but this strategy is not — and the
  // strategy's own record is what gates the trade.
  const history = [
    ...trades(25, { pnl: -100, r: -1, strategy: "alpha" }),
    ...trades(40, { pnl: 500, r: 5, strategy: "beta", symbol: "SOLUSDT", score: 91 }),
  ];
  const result = assess(history);
  assert.equal(result.decision, "BLOCK");
  assert.match(result.reasons[0], /^EDGE_STRATEGY: alpha \| 25 trades/);
});

test("with no history for this strategy it falls back to symbol evidence", () => {
  const history = trades(25, { pnl: -100, r: -1, strategy: "someone-else", symbol: "BTCUSDT" });
  const result = assess(history, { strategy: "brand-new" });
  assert.match(result.reasons[0], /^EDGE_SYMBOL: BTCUSDT/);
  assert.equal(result.decision, "BLOCK");
});

test("excessive drawdown blocks a record that is otherwise profitable", () => {
  // A long profitable run to a 20000 peak, then a 4800 giveback — a 24%
  // drawdown past the 15% limit, even though expectancy stays at +0.7R and
  // the profit factor at 2.08.
  const history = [
    ...trades(25, { pnl: 400, r: 2 }),
    ...trades(12, { pnl: -400, r: -2 }),
  ];
  const result = assess(history);
  assert.equal(result.decision, "BLOCK");
  assert.match(result.reasons.join(" "), /drawdown above/);
});
