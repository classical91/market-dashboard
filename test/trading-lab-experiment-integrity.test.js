"use strict";

// The live demo accounts are experiments, and an experiment with two writers is
// not an experiment. These tests hold the boundary over HTTP: the dashboard may
// observe a running demo account, and may not participate in it.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTradingLabRouter } = require("../src/routes/trading-lab");
const { createRequireAdmin } = require("../src/middleware/admin-auth");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");
const { EXECUTION_OWNERS } = require("../src/services/trading/execution-owner");

const ADMIN_KEY = "experiment-integrity-key";

let server;
let base;
let lab;

// A stand-in for the live research loop: it only has to answer "do I own this
// strategy?" and "can you restart it?", which is the whole surface the guards
// consult.
function fakeResearchService({ enabled = true, owns = ["mindset_v1"], resettable = true } = {}) {
  const reset = [];
  return {
    enabled,
    resetCalls: reset,
    ownsStrategy(id) { return owns.includes(String(id)); },
    // The accounts read renders runner state beside each account.
    statusFor(id) {
      return { strategyId: id, enabled, runnerStatus: owns.includes(String(id)) ? "WAITING_FOR_NEXT_CANDLE" : "PAUSED", activity: [] };
    },
    status() { return { enabled, running: enabled, runners: owns.slice() }; },
    ...(resettable
      ? { resetExperiment(id) { reset.push(String(id)); return owns.includes(String(id)); } }
      : {}),
  };
}

function openOwnedPosition(strategyId, owner, overrides = {}) {
  return lab.strategyLedger(strategyId).openPosition({
    symbol: "BTCUSDT",
    direction: "LONG",
    size: 1,
    entryPrice: 100,
    stopLoss: 95,
    tp1: 110,
    tp2: 120,
    riskUsd: 50,
    executionOwner: owner,
    signalSource: `${owner}:1h`,
    ...overrides,
  });
}

async function post(pathname, body, { key = ADMIN_KEY } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-admin-key": key } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  lab = new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-integrity-")),
    config: makeTradingConfig({ takerFeeRate: 0, slippageRate: 0, fundingRate8h: 0 }),
    priceFeed: async () => 105,
  });
  app.use(
    "/api/trading-lab",
    createTradingLabRouter({
      tradingLabService: lab,
      backtestService: null,
      requireAdmin: createRequireAdmin({ adminKey: ADMIN_KEY }),
    }),
  );
  // The same error shape src/app.js produces, so a thrown 409 is asserted in the
  // form a real client actually receives.
  app.use((err, req, res, _next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.expose || status < 500 ? err.message : "Internal server error" });
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

test.beforeEach(() => {
  // Each test starts from an idle lab with no autonomous owner.
  lab.attachLiveResearchService(null);
  for (const id of ["mindset_v1", "smc_v1", "donchian_breakout_v1"]) {
    lab.strategyLedger(id).reset();
  }
});

/* ── Mark to market ───────────────────────────────────────── */

test("/mark refuses to touch a Live Research position", async () => {
  openOwnedPosition("mindset_v1", EXECUTION_OWNERS.LIVE_RESEARCH);

  const res = await post("/api/trading-lab/mark", { strategyId: "mindset_v1" });

  assert.equal(res.status, 409);
  assert.equal(res.body.refused, true, "refused explicitly, never silently ignored");
  assert.match(res.body.error, /managed by Live Research/i);
  assert.match(res.body.error, /experiment integrity/i);
  // Marking fires stops and targets, so the position must be untouched.
  const [position] = lab.strategyLedger("mindset_v1").getOpenPositions();
  assert.ok(position, "the position was closed by a refused mark");
  assert.equal(position.tp1Hit, false);
});

test("/mark refuses to touch a Live Scanner position", async () => {
  openOwnedPosition("mindset_v1", EXECUTION_OWNERS.LIVE_SCANNER);

  const res = await post("/api/trading-lab/mark", { strategyId: "mindset_v1" });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /managed by Live Scanner/i);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);
});

test("/mark still works for an account with no autonomous position", async () => {
  // The guard is about ownership, not about disabling the button everywhere.
  openOwnedPosition("smc_v1", EXECUTION_OWNERS.TRADING_LAB);

  const res = await post("/api/trading-lab/mark", { strategyId: "smc_v1" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.events));
});

/* ── Manual close ─────────────────────────────────────────── */

test("a manual close cannot close a runner-owned position", async () => {
  for (const owner of [EXECUTION_OWNERS.LIVE_RESEARCH, EXECUTION_OWNERS.LIVE_SCANNER]) {
    lab.strategyLedger("mindset_v1").reset();
    const position = openOwnedPosition("mindset_v1", owner);

    const res = await post(`/api/trading-lab/positions/${position.id}/close`, {
      strategyId: "mindset_v1",
      exitPrice: 150,
    });

    assert.equal(res.status, 409, owner);
    assert.equal(res.body.refused, true, owner);
    assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1, owner);
    assert.equal(lab.strategyLedger("mindset_v1").getHistory().length, 0, owner);
  }
});

test("a manual close still works on a manually owned position", async () => {
  const position = openOwnedPosition("smc_v1", EXECUTION_OWNERS.TRADING_LAB);

  const res = await post(`/api/trading-lab/positions/${position.id}/close`, {
    strategyId: "smc_v1",
    exitPrice: 150,
  });

  assert.equal(res.status, 200);
  assert.equal(lab.strategyLedger("smc_v1").getOpenPositions().length, 0);
});

/* ── Manual entry ─────────────────────────────────────────── */

test("a manual trade cannot contaminate an active autonomous account", async () => {
  lab.attachLiveResearchService(fakeResearchService({ owns: ["mindset_v1"] }));

  const res = await post("/api/trading-lab/positions", {
    strategyId: "mindset_v1",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    atr: 2,
    state: { regime: "TREND_UP", dailyBias: "BULLISH", volumeRatio: 1.6, macdBullish: true, stochSignal: "OVERSOLD_CROSS" },
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.refused, true);
  assert.match(res.body.error, /Manual trade entry is disabled/i);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
  // Refused outright rather than redirected: writing it to another ledger would
  // just move the contamination.
  assert.equal(lab.strategyLedger("smc_v1").getOpenPositions().length, 0);
});

test("eligibility is not ownership — a disabled loop owns nothing", async () => {
  // mindset_v1 is live-research eligible, but the loop is off, so no experiment
  // is running and the account is not protected on those grounds.
  lab.attachLiveResearchService(fakeResearchService({ enabled: false, owns: ["mindset_v1"] }));
  assert.equal(lab.autonomousOwnerOf("mindset_v1"), null);
});

/* ── Reset ────────────────────────────────────────────────── */

test("resetting an autonomous account restarts ledger and runner together", async () => {
  const service = fakeResearchService({ owns: ["mindset_v1"] });
  lab.attachLiveResearchService(service);
  openOwnedPosition("mindset_v1", EXECUTION_OWNERS.LIVE_RESEARCH);

  const res = await post("/api/trading-lab/reset", { strategyId: "mindset_v1" });

  assert.equal(res.status, 200);
  assert.equal(res.body.runnerReset, true);
  assert.equal(res.body.autonomous, true);
  assert.deepEqual(service.resetCalls, ["mindset_v1"], "the runner was restarted with the ledger");
  assert.equal(res.body.account.balance, res.body.account.startingBalance);
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 0);
});

test("a reset that cannot restart the runner is refused, not half-done", async () => {
  // A service that owns the account but exposes no restart: resetting only the
  // ledger would leave a fresh balance with a runner mid-experiment.
  lab.attachLiveResearchService(fakeResearchService({ owns: ["mindset_v1"], resettable: false }));
  const ledger = lab.strategyLedger("mindset_v1");
  ledger.addToHistory({ status: "closed", symbol: "BTCUSDT", realizedPnl: 25, rMultiple: 0.25 });

  const res = await post("/api/trading-lab/reset", { strategyId: "mindset_v1" });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /disagreeing|Stop Live Research/i);
  assert.equal(ledger.getHistory().length, 1, "the ledger was left intact");
});

test("resetting an idle account still works", async () => {
  const res = await post("/api/trading-lab/reset", { strategyId: "donchian_breakout_v1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.autonomous, false);
  assert.equal(res.body.runnerReset, false);
});

/* ── Reads stay reads ─────────────────────────────────────── */

test("reading a protected account over HTTP changes nothing", async () => {
  lab.attachLiveResearchService(fakeResearchService({ owns: ["mindset_v1"] }));
  openOwnedPosition("mindset_v1", EXECUTION_OWNERS.LIVE_RESEARCH);
  const ledger = lab.strategyLedger("mindset_v1");
  const before = JSON.stringify({ p: ledger.getOpenPositions(), h: ledger.getHistory(), a: ledger.getAccount() });

  for (const url of [
    "/api/trading-lab/strategy-accounts",
    "/api/trading-lab/strategy-accounts/mindset_v1",
    "/api/trading-lab/positions?strategyId=mindset_v1",
    "/api/trading-lab/history?strategyId=mindset_v1",
    "/api/trading-lab/metrics?strategyId=mindset_v1",
  ]) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200, url);
  }

  assert.equal(
    JSON.stringify({ p: ledger.getOpenPositions(), h: ledger.getHistory(), a: ledger.getAccount() }),
    before,
    "a dashboard read mutated the experiment",
  );
});

test("the guards sit behind the admin gate, not in front of it", async () => {
  openOwnedPosition("mindset_v1", EXECUTION_OWNERS.LIVE_RESEARCH);
  const res = await post("/api/trading-lab/mark", { strategyId: "mindset_v1" }, { key: null });
  assert.equal(res.status, 401, "an anonymous caller is rejected before ownership is even considered");
});

/* ── One ledger, one writer ───────────────────────────────── */

const TRADEABLE = {
  regime: "TREND_UP",
  dailyBias: "BULLISH",
  volumeRatio: 1.6,
  macdBullish: true,
  stochSignal: "OVERSOLD_CROSS",
};

function scannerWrite(strategyId) {
  return lab.execute({
    strategyId,
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    atr: 2,
    state: { ...TRADEABLE },
    signalSource: "live-scanner:15m",
    executionOwner: "live-scanner",
  });
}

test("the Live Scanner cannot write into a ledger a demo runner owns", async () => {
  // The live production configuration: ENABLE_LIVE_SCANNER on with paper
  // trading defaulting to enabled, and Demo Trading also defaulting on. Both
  // targeted mindset_v1's single $10,000 ledger — the scanner at 15m on one
  // symbol through the full gauntlet, the demo runner at 1h across twenty
  // markets with the strategy authoritative. Two experiments, one balance, and
  // no way to separate them afterwards.
  //
  // Reporting the conflict was never enforcement. This is.
  lab.attachLiveResearchService(fakeResearchService({ owns: ["mindset_v1"] }));

  await assert.rejects(() => scannerWrite("mindset_v1"), /autonomous demo experiment/i);
  assert.equal(
    lab.strategyLedger("mindset_v1").getOpenPositions().length,
    0,
    "the refused write must leave no position behind",
  );
});

test("the guard costs nothing when no demo runner owns the ledger", async () => {
  // Ownership is FACT, not eligibility: with the loop detached or disabled,
  // nothing owns the ledger and the ordinary forward-paper path is unchanged.
  lab.attachLiveResearchService(null);
  const detached = await scannerWrite("mindset_v1");
  assert.ok(detached.opened, "a write with no autonomous owner must still succeed");

  lab.strategyLedger("mindset_v1").reset();
  lab.attachLiveResearchService(fakeResearchService({ enabled: false, owns: ["mindset_v1"] }));
  const disabled = await scannerWrite("mindset_v1");
  assert.ok(disabled.opened, "a disabled loop owns nothing and must not block a write");
});

test("the refusal is scoped to the contested account, not to every strategy", async () => {
  // A guard that refused writes to accounts nothing owns would be a different
  // bug in the same place.
  lab.attachLiveResearchService(fakeResearchService({ owns: ["mindset_v1"] }));
  await assert.rejects(() => scannerWrite("mindset_v1"));
  const other = await scannerWrite("smc_v1").catch((err) => ({ error: err.message }));
  assert.ok(!other.error || !/autonomous demo experiment/i.test(other.error), other.error);
});

test("the demo runner itself still writes to the ledger it owns", async () => {
  // The guard must stop the SECOND writer, not the owner. If it blocked the
  // runner too, every demo account would go permanently flat and the fix would
  // be worse than the defect.
  lab.attachLiveResearchService(fakeResearchService({ owns: ["mindset_v1"] }));
  const opened = await lab.executeLiveResearch({
    strategyId: "mindset_v1",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    atr: 2,
    state: { ...TRADEABLE },
    signalSource: "live-research:1h",
  });
  assert.ok(opened.opened, "the owning runner must still be able to trade its own account");
});
