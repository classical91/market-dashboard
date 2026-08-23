"use strict";

// The question the Aug-21 triage could not answer: can a paper-only setup
// travel decision -> evaluation -> outcome -> persistent record with nothing
// disappearing, and can one view prove it?
//
// Two halves here. First the end-to-end walk, including a reload from disk —
// a record that only exists in a live object is not a journal. Then the
// reconciliation view that has to notice when something *is* missing; a
// consistency check that cannot fail is not a check.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TradingLabService } = require("../src/services/trading/trading-lab");
const { SignalTradeBridge } = require("../src/services/trading/signal-bridge");
const { SignalActionStore } = require("../src/services/trading/signal-action-store");
const { TradeJournalService } = require("../src/services/trade-journal");
const { reconcilePaperPipeline } = require("../src/services/trading/pipeline-reconciliation");
const { makeTradingConfig } = require("../src/services/trading/config");
const { listStrategyAccounts } = require("../src/services/trading/strategy-accounts");

const QUIET = { log() {}, warn() {}, error() {} };

const BULLISH_DECISION = {
  regime: { score: 70, label: "Trending", modifiers: [] },
  newsRisk: { level: "low" },
};

const TRADEABLE_STATE = {
  regime: "TREND_UP",
  dailyBias: "BULLISH",
  volumeRatio: 1.6,
  macdBullish: true,
  stochSignal: "OVERSOLD_CROSS",
};

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeLab(dataDir) {
  return new TradingLabService({
    dataDir,
    config: makeTradingConfig(),
    decisionEngineService: { getDecision: async () => BULLISH_DECISION },
  });
}

function transition(overrides = {}) {
  return { symbol: "BTCUSDT", interval: "4h", from: "FLAT", to: "LONG", score: 83, price: 100, ...overrides };
}

// ── End to end ──────────────────────────────────────────────────────────────

test("a qualifying paper-only setup persists a record that survives a reload", async () => {
  const dataDir = tempDir("md-e2e-paper-");
  const lab = makeLab(dataDir);

  const result = await lab.execute({
    book: "main",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    atr: 2,
    state: TRADEABLE_STATE,
    strategyId: "mindset_v1",
    strategyVersion: "1.0.0",
    timeframe: "15m",
    signalSource: "live-scanner:15m",
  });

  assert.ok(result.opened, `a qualifying setup must open a paper position: ${result.trade && result.trade.reason}`);
  assert.equal(result.opened.status, "open");
  assert.equal(result.opened.symbol, "BTCUSDT");

  // The record has to outlive the object that made it. A fresh service over the
  // same directory is what the next process actually sees.
  const reopened = makeLab(dataDir).strategyLedger("mindset_v1");
  const persisted = reopened.getOpenPositions().find((p) => p.id === result.opened.id);
  assert.ok(persisted, "the position must be readable after the service is reconstructed");
  assert.equal(persisted.symbol, "BTCUSDT");
  assert.equal(persisted.direction, "LONG");
  assert.ok(Number.isFinite(Number(persisted.entryPrice)), "entry price must be recorded");
  assert.ok(persisted.stopLoss != null, "the risk plan must be recorded with the fill");

  // Paper only: this must never have reached a live-order path.
  assert.notEqual(lab.config.liveEnabled, true);
});

test("a blocked setup persists its refusal and opens nothing", async () => {
  const dataDir = tempDir("md-e2e-blocked-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab(dataDir);
  const bridge = new SignalTradeBridge({
    tradingLabService: lab,
    signalScreenerService: { async getCandles() { return []; } },
    signalActionStore: store,
    paperTradeEnabled: true,
    logger: QUIET,
  });

  const [action] = await bridge.handleTransitions([transition()]);

  assert.equal(action.status, "blocked");
  assert.ok(action.reason, "a refusal has to say why");
  assert.equal(action.opened, null);

  // Readable from a new store over the same directory.
  const persisted = new SignalActionStore({ dataDir, logger: QUIET }).recent(10);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, "blocked");
  assert.equal(persisted[0].strategy, "signal-bot:4h");

  assert.ok(
    listStrategyAccounts().every((a) => lab.strategyLedger(a.id).getOpenPositions().length === 0),
    "a blocked setup must not touch any persistent ledger",
  );
});

// ── Reconciliation ──────────────────────────────────────────────────────────

test("the reconciliation view accounts for every evaluated setup", async () => {
  const dataDir = tempDir("md-reconcile-view-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab(dataDir);
  const realEvaluate = lab.evaluate.bind(lab);
  lab.evaluate = (input) => {
    if (input.symbol === "ETHUSDT") throw new Error("boom");
    return realEvaluate(input);
  };
  const bridge = new SignalTradeBridge({
    tradingLabService: lab,
    signalScreenerService: { async getCandles() { return []; } },
    signalActionStore: store,
    logger: QUIET,
  });

  await bridge.handleTransitions([
    transition({ symbol: "BTCUSDT" }),
    transition({ symbol: "ETHUSDT" }),
    transition({ symbol: "SOLUSDT" }),
    transition({ symbol: "ADAUSDT", price: 0 }),
  ]);

  const report = reconcilePaperPipeline({
    signalActionStore: store,
    tradingLabService: lab,
    tradeJournalService: new TradeJournalService({ dataDir }),
  });

  assert.equal(report.evaluation.total, 4);
  assert.equal(report.evaluation.unaccounted, 0, "every row must reach a terminal status");
  assert.equal(report.evaluation.accounted, 4);
  assert.equal(report.evaluation.withReason, 4, "every row must explain itself");
  assert.equal(report.evaluation.byStatus["dry-run"], 2);
  assert.equal(report.evaluation.byStatus.failed, 1);
  assert.equal(report.evaluation.byStatus.skipped, 1);
  assert.equal(report.reconciled, true);
  assert.deepEqual(report.discrepancies, []);
  assert.match(report.summary, /^4 evaluated,/);
});

test("the human trade journal is reported alongside, never written by the pipeline", async () => {
  const dataDir = tempDir("md-reconcile-journal-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab(dataDir);
  const journal = new TradeJournalService({ dataDir });
  const bridge = new SignalTradeBridge({
    tradingLabService: lab,
    signalScreenerService: { async getCandles() { return []; } },
    signalActionStore: store,
    logger: QUIET,
  });

  await bridge.handleTransitions([transition(), transition({ symbol: "SOLUSDT" })]);
  const report = reconcilePaperPipeline({ signalActionStore: store, tradingLabService: lab, tradeJournalService: journal });

  assert.equal(report.evaluation.total, 2);
  // Its win-rate and expectancy are only meaningful because a person vouched
  // for each row, so two evaluated setups must not become two journal entries.
  assert.equal(report.manualJournal.entries, 0);
  assert.equal(report.manualJournal.maintainedBy, "human");
  assert.equal(journal.list().length, 0, "the pipeline must not write the human journal");
  assert.equal(report.reconciled, true);
});

test("an unexplained outcome is reported as a discrepancy, not smoothed over", () => {
  const dataDir = tempDir("md-reconcile-bad-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  store.record({ symbol: "BTCUSDT", interval: "4h", direction: "LONG", strategy: "signal-bot:4h", status: "teleported", reason: "?" });
  store.record({ symbol: "ETHUSDT", interval: "4h", direction: "LONG", strategy: "signal-bot:4h", status: "dry-run", reason: "" });

  const report = reconcilePaperPipeline({ signalActionStore: store });

  assert.equal(report.reconciled, false);
  assert.equal(report.evaluation.unaccounted, 1);
  const kinds = report.discrepancies.map((d) => d.kind);
  assert.ok(kinds.includes("unknown-status"), `expected unknown-status, got ${kinds}`);
  assert.ok(kinds.includes("missing-reason"), `expected missing-reason, got ${kinds}`);
  assert.match(report.discrepancies.find((d) => d.kind === "unknown-status").detail, /teleported/);
});

test("a paper fill with no evaluation row behind it is reported as unlogged", async () => {
  const dataDir = tempDir("md-reconcile-unlogged-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab(dataDir);

  // A bridge-owned fill that no evaluation row explains — exactly the silent
  // disappearance this view exists to catch, in reverse.
  const opened = await lab.execute({
    book: "main",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    atr: 2,
    state: TRADEABLE_STATE,
    strategyId: "mindset_v1",
    strategyVersion: "1.0.0",
    timeframe: "15m",
    signalSource: "signal-bot:4h",
  });
  assert.ok(opened.opened, "the fixture needs a real persisted fill");

  const report = reconcilePaperPipeline({ signalActionStore: store, tradingLabService: lab });

  assert.equal(report.reconciled, false);
  const unlogged = report.discrepancies.find((d) => d.kind === "unlogged-fill");
  assert.ok(unlogged, `expected an unlogged-fill discrepancy, got ${JSON.stringify(report.discrepancies)}`);
  assert.match(unlogged.detail, /BTCUSDT/);
  assert.equal(report.execution.bridgeOwnedOpen, 1);
});

test("GET /api/trading-lab/pipeline serves the reconciliation view read-only", async () => {
  const express = require("express");
  const http = require("node:http");
  const { createTradingLabRouter } = require("../src/routes/trading-lab");
  const { BacktestService } = require("../src/services/trading/backtest");

  const dataDir = tempDir("md-pipeline-route-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab(dataDir);
  const journal = new TradeJournalService({ dataDir });
  const bridge = new SignalTradeBridge({
    tradingLabService: lab,
    signalScreenerService: { async getCandles() { return []; } },
    signalActionStore: store,
    logger: QUIET,
  });
  await bridge.handleTransitions([transition(), transition({ symbol: "SOLUSDT" })]);

  const app = express();
  app.use(express.json());
  app.use(
    "/api/trading-lab",
    createTradingLabRouter({
      tradingLabService: lab,
      backtestService: new BacktestService({ dataDir }),
      signalActionStore: store,
      tradeJournalService: journal,
      requireAdmin: (req, res) => res.status(503).json({ error: "disabled" }),
    }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/trading-lab/pipeline`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.evaluation.total, 2);
    assert.equal(body.evaluation.unaccounted, 0);
    assert.equal(body.reconciled, true);
    assert.equal(body.manualJournal.entries, 0);

    // Read-only: serving the view must not have written anything.
    assert.equal(journal.list().length, 0);
    assert.equal(store.count(), 2);
  } finally {
    server.close();
  }
});

test("zero bridge fills reads as a design outcome rather than a missing pipeline", async () => {
  const dataDir = tempDir("md-reconcile-note-");
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab(dataDir);
  const bridge = new SignalTradeBridge({
    tradingLabService: lab,
    signalScreenerService: { async getCandles() { return []; } },
    signalActionStore: store,
    paperTradeEnabled: true,
    logger: QUIET,
  });

  await bridge.handleTransitions([transition()]);
  const report = reconcilePaperPipeline({ signalActionStore: store, tradingLabService: lab });

  assert.equal(report.execution.bridgeOwnedOpen, 0);
  assert.equal(report.evaluation.refusedByAttribution, 1);
  assert.match(report.execution.note, /no registered strategy identity/i);
  assert.equal(report.reconciled, true, "a refusal by design is not a discrepancy");
});
