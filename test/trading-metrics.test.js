"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { calculateTradeMetrics, buildStrategyMetrics, scoreBucket } = require("../src/services/trading/metrics");

function trade(overrides = {}) {
  return { status: "closed", realizedPnl: 0, rMultiple: 0, symbol: "BTCUSDT", signalSource: "main", ...overrides };
}

test("calculateTradeMetrics computes expectancy, profit factor and drawdown", () => {
  const history = [
    trade({ realizedPnl: 200, rMultiple: 2 }),
    trade({ realizedPnl: -100, rMultiple: -1 }),
    trade({ realizedPnl: 150, rMultiple: 1.5 }),
    trade({ realizedPnl: -100, rMultiple: -1 }),
  ];

  const m = calculateTradeMetrics(history, 10000);
  assert.equal(m.closedTrades, 4);
  assert.equal(m.netReturnUsd, 150);
  assert.equal(m.netReturnPct, 1.5);
  assert.equal(m.expectancyUsd, 37.5);
  assert.equal(m.expectancyR, 0.375);
  assert.equal(m.profitFactor, 1.75); // 350 gross profit / 200 gross loss
  assert.equal(m.avgWin, 175);
  assert.equal(m.avgLoss, -100);
  assert.equal(m.worstConsecutiveLosses, 1);
});

test("drawdown is measured from the running equity peak, not the start", () => {
  // +500 to a 10500 peak, then two losses to 10100 — a 3.81% drawdown from
  // peak even though the account is still up on the starting balance.
  const history = [
    trade({ realizedPnl: 500 }),
    trade({ realizedPnl: -200 }),
    trade({ realizedPnl: -200 }),
  ];
  const m = calculateTradeMetrics(history, 10000);
  assert.equal(m.netReturnUsd, 100);
  assert.equal(m.maxDrawdownPct, 3.81);
  assert.equal(m.worstConsecutiveLosses, 2);
});

test("profit factor is null when there are wins but no losses", () => {
  const m = calculateTradeMetrics([trade({ realizedPnl: 100 })], 10000);
  assert.equal(m.profitFactor, null);
});

test("profit factor is zero when there is no closed P&L at all", () => {
  const m = calculateTradeMetrics([], 10000);
  assert.equal(m.profitFactor, 0);
  assert.equal(m.closedTrades, 0);
  assert.equal(m.expectancyR, 0);
});

test("exact ties round half-to-even, symmetrically for wins and losses", () => {
  // Matches Python's round(), so the parity check against TraderClaw agrees to
  // the cent, and so a long history is not biased upward by rounding.
  const m = calculateTradeMetrics([trade({ realizedPnl: -0.125 }), trade({ realizedPnl: 0.125 })], 10000);
  assert.equal(m.avgLoss, -0.12);
  assert.equal(m.avgWin, 0.12);

  const up = calculateTradeMetrics([trade({ realizedPnl: -0.135 }), trade({ realizedPnl: 0.135 })], 10000);
  assert.equal(up.avgLoss, -0.14);
  assert.equal(up.avgWin, 0.14);
});

test("scoreBucket groups scores into decades and caps at 100", () => {
  assert.equal(scoreBucket(0), "0-9");
  assert.equal(scoreBucket(74), "70-79");
  assert.equal(scoreBucket(100), "100-100");
  assert.equal(scoreBucket(null), "unscored");
  assert.equal(scoreBucket("nonsense"), "unscored");
});

test("buildStrategyMetrics groups by strategy, symbol and score bucket", () => {
  const history = [
    trade({ signalSource: "alpha", symbol: "BTCUSDT", confidenceScore: 82, realizedPnl: 300, rMultiple: 3 }),
    trade({ signalSource: "alpha", symbol: "ETHUSDT", confidenceScore: 81, realizedPnl: 100, rMultiple: 1 }),
    trade({ signalSource: "beta", symbol: "BTCUSDT", confidenceScore: 55, realizedPnl: -100, rMultiple: -1 }),
  ];

  const result = buildStrategyMetrics(history, 10000);
  assert.equal(result.summary.closedTrades, 3);

  const strategies = result.groups.strategy;
  assert.deepEqual(strategies.map((r) => r.key), ["alpha", "beta"]);
  assert.equal(strategies[0].closedTrades, 2);
  assert.equal(strategies[0].expectancyR, 2);
  assert.equal(strategies[1].expectancyR, -1);

  assert.deepEqual(
    result.groups.scoreBucket.map((r) => r.key).sort(),
    ["50-59", "80-89"],
  );
});

test("buildStrategyMetrics drops groups below minTrades", () => {
  const history = [
    trade({ signalSource: "alpha", realizedPnl: 10 }),
    trade({ signalSource: "beta", realizedPnl: 10 }),
    trade({ signalSource: "beta", realizedPnl: 10 }),
  ];
  const result = buildStrategyMetrics(history, 10000, 2);
  assert.deepEqual(result.groups.strategy.map((r) => r.key), ["beta"]);
});

test("ranking prefers expectancy first", () => {
  const history = [
    trade({ signalSource: "weak", realizedPnl: 50, rMultiple: 0.5 }),
    trade({ signalSource: "weak", realizedPnl: -50, rMultiple: -0.5 }),
    trade({ signalSource: "strong", realizedPnl: -100, rMultiple: -1 }),
    trade({ signalSource: "strong", realizedPnl: 300, rMultiple: 3 }),
  ];
  const rows = buildStrategyMetrics(history, 10000).groups.strategy;
  assert.deepEqual(rows.map((r) => r.key), ["strong", "weak"]);
});

test("on equal expectancy a lossless record outranks one that gave money back", () => {
  // Both average +1R. "steady" has no losing trade at all, so its profit
  // factor is null — the ranking treats that as the strongest possible, which
  // is why the edge gate only trusts it once the sample is large enough.
  const history = [
    trade({ signalSource: "steady", realizedPnl: 100, rMultiple: 1 }),
    trade({ signalSource: "steady", realizedPnl: 100, rMultiple: 1 }),
    trade({ signalSource: "choppy", realizedPnl: -100, rMultiple: -1 }),
    trade({ signalSource: "choppy", realizedPnl: 300, rMultiple: 3 }),
  ];
  const rows = buildStrategyMetrics(history, 10000).groups.strategy;
  assert.equal(rows[0].expectancyR, rows[1].expectancyR);
  assert.deepEqual(rows.map((r) => r.key), ["steady", "choppy"]);
  assert.equal(rows[0].profitFactor, null);
});

test("on equal expectancy and profit factor, the smaller drawdown ranks higher", () => {
  const history = [
    // Same two trades, opposite order. Drawdown is measured off the running
    // peak, so banking the win first raises the peak the loss is measured
    // against — the identical $100 loss costs 0.97% there but 1.00% when it
    // lands first, against the untouched starting balance.
    trade({ signalSource: "lossFirst", realizedPnl: -100, rMultiple: -1 }),
    trade({ signalSource: "lossFirst", realizedPnl: 300, rMultiple: 3 }),
    trade({ signalSource: "winFirst", realizedPnl: 300, rMultiple: 3 }),
    trade({ signalSource: "winFirst", realizedPnl: -100, rMultiple: -1 }),
  ];
  const rows = buildStrategyMetrics(history, 10000).groups.strategy;
  assert.equal(rows[0].expectancyR, rows[1].expectancyR);
  assert.equal(rows[0].profitFactor, rows[1].profitFactor);
  assert.deepEqual(rows.map((r) => r.key), ["winFirst", "lossFirst"]);
  assert.ok(rows[0].maxDrawdownPct < rows[1].maxDrawdownPct);
});
