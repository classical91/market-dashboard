"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TradingLabService, marketStateFromDecision } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");

function makeLab({ decisionEngineService = null, configOverrides = {} } = {}) {
  return new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-lab-")),
    config: makeTradingConfig(configOverrides),
    decisionEngineService,
  });
}

// Conditions under which the checklist scores a long at full size.
const GOOD_LONG_STATE = {
  regime: "TREND_UP",
  dailyBias: "BULLISH",
  usdtDominanceSignal: "RISK_ON",
  macdBullish: true,
  stochSignal: "OVERSOLD_CROSS",
  volumeRatio: 1.8,
  atrRatio: 1.1,
  fundingRate: 0.0001,
};

function candidate(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 1000,
    atr: 100,
    state: GOOD_LONG_STATE,
    ...overrides,
  };
}

test("a good setup with no history is allowed at full size", () => {
  const lab = makeLab();
  const result = lab.evaluate(candidate());
  assert.equal(result.decision, "TAKE_FULL");
  assert.equal(result.edge.decision, "ALLOW");
  assert.equal(result.sizeMultiplier, 1);
  assert.equal(result.trade.ok, true);
  assert.equal(result.trade.stopLoss, 850);
  assert.equal(result.trade.riskUsd, 100);
});

test("the checklist and edge multipliers compound", () => {
  const lab = makeLab();
  // Neutral bias and one dead trigger take the checklist to half size; a long
  // record of thin-but-positive trades takes the edge gate to REDUCE.
  const trader = lab.book("main");
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push({
      status: "closed",
      realizedPnl: i % 2 === 0 ? 100 : -90,
      rMultiple: i % 2 === 0 ? 1 : -0.9,
      signalSource: "main:LONG",
      symbol: "BTCUSDT",
      confidenceScore: 70,
    });
  }
  trader.save(trader.historyFile, history);

  const result = lab.evaluate(candidate({ state: { ...GOOD_LONG_STATE, dailyBias: "NEUTRAL", stochSignal: "NEUTRAL" } }));
  assert.equal(result.checklist.sizeMultiplier, 0.5);
  assert.equal(result.edge.decision, "REDUCE");
  assert.equal(result.sizeMultiplier, 0.25);
  assert.equal(result.trade.riskUsd, 25);
});

test("an edge-gate block overrides a perfect checklist score", () => {
  const lab = makeLab();
  const trader = lab.book("main");
  trader.save(
    trader.historyFile,
    Array.from({ length: 25 }, () => ({
      status: "closed",
      realizedPnl: -100,
      rMultiple: -1,
      signalSource: "main:LONG",
      symbol: "BTCUSDT",
      confidenceScore: 100,
    })),
  );

  const result = lab.evaluate(candidate());
  assert.equal(result.checklist.decision, "TAKE_FULL");
  assert.equal(result.edge.decision, "BLOCK");
  assert.equal(result.decision, "SKIP");
  assert.equal(result.trade.ok, false);
});

test("live account risk overrides whatever state the caller passed", async () => {
  const lab = makeLab();
  const trader = lab.book("main");
  // Three real losses in a row — a caller claiming a clean slate cannot trade
  // through the consecutive-loss kill switch.
  for (let i = 0; i < 3; i += 1) {
    trader.openPosition({
      symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
      stopLoss: 90, tp1: 115, tp2: 125, riskUsd: 10, signalSource: "test",
    });
    await trader.updatePositions({ BTCUSDT: 90 });
  }

  const result = lab.evaluate(candidate({ state: { ...GOOD_LONG_STATE, consecutiveLosses: 0 } }));
  assert.equal(result.decision, "SKIP");
  assert.equal(result.checklist.killSwitch, true);
  assert.match(result.checklist.killReason, /CONSECUTIVE_LOSSES: 3/);
});

test("execute opens the position that evaluate planned", async () => {
  const lab = makeLab();
  const result = await lab.execute({ ...candidate(), signalSource: "decision-engine" });
  assert.ok(result.opened);
  assert.equal(result.opened.entryPrice, 1000);
  assert.equal(result.opened.stopLoss, 850);
  assert.equal(result.opened.signalSource, "decision-engine");
  assert.equal(result.opened.confidenceScore, result.checklist.confidenceScore);
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

test("execute opens nothing when the gates refuse", async () => {
  const lab = makeLab();
  const result = await lab.execute(candidate({ state: { ...GOOD_LONG_STATE, regime: "TREND_DOWN" } }));
  assert.equal(result.opened, null);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("books are addressable by name and unknown books 404", () => {
  const lab = makeLab();
  assert.deepEqual(lab.listBooks().map((b) => b.id), ["main", "shadow", "alts"]);
  assert.equal(lab.book("shadow").book, "shadow");
  assert.throws(() => lab.book("nope"), (err) => err.statusCode === 404);
});

test("trading in one book leaves the others untouched", async () => {
  const lab = makeLab();
  await lab.execute({ ...candidate(), book: "shadow" });
  assert.equal(lab.book("shadow").getOpenPositions().length, 1);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("overview reports every book and never claims live mode by default", async () => {
  const lab = makeLab();
  const overview = await lab.overview();
  assert.equal(overview.mode, "paper");
  assert.deepEqual(overview.books.map((b) => b.id), ["main", "shadow", "alts"]);
  assert.equal(overview.config.accountSize, 10000);
});

/* ── Decision engine bridge ───────────────────────────────── */

function fakeDecisionEngine(decision) {
  return { getDecision: async () => decision };
}

const DECISION = {
  regime: { label: "Risk-On", score: 72, modifiers: [] },
  newsRisk: { level: "low" },
  execution: [
    { symbol: "BTCUSDT", signal: "LONG", trigger: 1000, atr: 100, setupScore: 88, riskReward: 2.2 },
    { symbol: "ETHUSDT", signal: "SHORT", trigger: 3000, atr: 200, setupScore: 71, riskReward: 1.8 },
    { symbol: "SOLUSDT", signal: "LONG", error: "Not enough candle history for levels" },
  ],
};

test("decision plans are scored at their own trigger price, not spot", async () => {
  const lab = makeLab({ decisionEngineService: fakeDecisionEngine(DECISION) });
  const result = await lab.evaluateDecisionPlans({ interval: "4h" });

  // The errored plan is dropped; the two real ones are scored.
  assert.deepEqual(result.candidates.map((c) => c.symbol), ["BTCUSDT", "ETHUSDT"]);
  const btc = result.candidates[0];
  assert.equal(btc.trade.entryPrice, 1000);
  assert.equal(btc.trade.stopLoss, 850);
  assert.equal(btc.setupScore, 88);
});

test("a risk-on regime blocks the shorts it disagrees with", async () => {
  const lab = makeLab({ decisionEngineService: fakeDecisionEngine(DECISION) });
  const result = await lab.evaluateDecisionPlans({});
  const eth = result.candidates.find((c) => c.symbol === "ETHUSDT");
  assert.equal(eth.decision, "SKIP");
  assert.match(eth.reasons.join(" "), /TREND_UP — shorts forbidden/);
});

test("evaluating decision plans opens nothing", async () => {
  const lab = makeLab({ decisionEngineService: fakeDecisionEngine(DECISION) });
  await lab.evaluateDecisionPlans({});
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("the bridge reports clearly when no decision engine is wired up", async () => {
  const lab = makeLab();
  await assert.rejects(() => lab.evaluateDecisionPlans({}), (err) => err.statusCode === 503);
});

test("regime scores translate into trend regimes and daily bias", () => {
  const riskOn = marketStateFromDecision({ regime: { label: "Risk-On", score: 72 }, newsRisk: { level: "low" } });
  assert.equal(riskOn.regime, "TREND_UP");
  assert.equal(riskOn.dailyBias, "BULLISH");
  assert.equal(riskOn.newsBlackout, false);

  const riskOff = marketStateFromDecision({ regime: { label: "Risk-Off", score: 30 }, newsRisk: { level: "high" } });
  assert.equal(riskOff.regime, "TREND_DOWN");
  assert.equal(riskOff.dailyBias, "BEARISH");
  assert.equal(riskOff.bearMarket, true);
  assert.equal(riskOff.newsBlackout, true);

  const volatile = marketStateFromDecision({ regime: { label: "Volatile", score: 70 }, newsRisk: { level: "low" } });
  assert.equal(volatile.regime, "VOLATILE_EXPANSION");

  const neutral = marketStateFromDecision({ regime: { label: "Neutral", score: 50 }, newsRisk: { level: "low" } });
  assert.equal(neutral.regime, "RANGE");
  assert.equal(neutral.dailyBias, "NEUTRAL");
});

test("a missing regime degrades to neutral instead of throwing", () => {
  const state = marketStateFromDecision({});
  assert.equal(state.regime, "RANGE");
  assert.equal(state.dailyBias, "NEUTRAL");
});

test("strategyMetrics reports grouped edge for a book", async () => {
  const lab = makeLab();
  const trader = lab.book("main");
  trader.save(trader.historyFile, [
    { status: "closed", realizedPnl: 200, rMultiple: 2, signalSource: "decision:4h", symbol: "BTCUSDT", confidenceScore: 85 },
    { status: "closed", realizedPnl: -100, rMultiple: -1, signalSource: "decision:4h", symbol: "ETHUSDT", confidenceScore: 62 },
  ]);

  const metrics = lab.strategyMetrics({ book: "main" });
  assert.equal(metrics.book, "main");
  assert.equal(metrics.summary.closedTrades, 2);
  assert.equal(metrics.summary.expectancyR, 0.5);
  assert.deepEqual(metrics.groups.symbol.map((r) => r.key), ["BTCUSDT", "ETHUSDT"]);
});
