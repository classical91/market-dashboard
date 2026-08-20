"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TradingLabService } = require("../src/services/trading/trading-lab");
const {
  listStrategyAccounts,
  describeStrategyAccount,
  acceptsForwardTrades,
  acceptsLiveResearchTrades,
  ledgerKey,
} = require("../src/services/trading/strategy-accounts");
const { listStrategies } = require("../src/services/trading/strategies");
const { BacktestService } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");

function tempLab() {
  return new TradingLabService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "strategy-accounts-")) });
}

// A market state good enough to clear the checklist, so these tests are about
// where a trade lands rather than whether one happens.
const TRADEABLE_STATE = {
  regime: "TREND_UP",
  dailyBias: "BULLISH",
  volumeRatio: 1.6,
  macdBullish: true,
  stochSignal: "OVERSOLD_CROSS",
};

function entry(overrides = {}) {
  return {
    book: "main",
    symbol: "BTCUSDT",
    direction: "LONG",
    entryPrice: 100,
    atr: 2,
    state: TRADEABLE_STATE,
    signalSource: "live-scanner:15m",
    ...overrides,
  };
}

/* ── Derived from the registry ────────────────────────────── */

test("every registered strategy has an account, derived from the registry", () => {
  const accounts = listStrategyAccounts().map((a) => a.id).sort();
  const registered = listStrategies().map((s) => s.id).sort();
  assert.deepEqual(accounts, registered);
  assert.equal(accounts.length, 6);
});

test("another strategy would not need a second list updating", () => {
  // The guard against the failure this design exists to prevent: a
  // hand-maintained mirror of the registry that silently loses an entry.
  // listStrategyAccounts() reads the registry, so this holds by construction —
  // asserted rather than assumed so a future refactor to a literal array fails
  // here instead of in production.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "trading", "strategy-accounts.js"),
    "utf8",
  );
  assert.ok(
    source.includes("listStrategies()"),
    "accounts must be derived from the registry, not enumerated",
  );
  for (const id of listStrategies().map((s) => s.id)) {
    assert.ok(!source.includes(`"${id}"`), `strategy-accounts.js must not hard-code ${id}`);
  }
});

test("each account reports why it is or is not forward enabled", () => {
  const byId = new Map(listStrategyAccounts().map((a) => [a.id, a]));

  assert.equal(byId.get("mindset_v1").label, "Forward Paper");
  assert.equal(byId.get("mindset_v1").active, true);

  for (const id of ["smc_v1", "donchian_breakout_v1", "vwap_reversion_v1"]) {
    assert.equal(byId.get(id).label, "Backtest Only", id);
    assert.equal(byId.get(id).active, false, id);
  }

  // Cannot even be replayed on candles, so "backtest only" would overstate it.
  assert.equal(byId.get("shadow_bananagun_v1").label, "Experimental · Event Replay Only");
  assert.equal(byId.get("shadow_bananagun_v1").active, false);
});

test("an account is not a permission", () => {
  // Four of five accounts exist for strategies that may not run forward, and
  // the account must never be the thing that changes that.
  for (const account of listStrategyAccounts()) {
    if (account.active) continue;
    assert.equal(account.scannerEligible, false, `${account.id} must not be scanner eligible`);
    assert.equal(acceptsForwardTrades(account.id), false, `${account.id} must not accept forward trades`);
  }
  assert.equal(describeStrategyAccount("not_a_strategy"), null);
  assert.equal(acceptsForwardTrades("not_a_strategy"), false);
});

/* ── Isolation ────────────────────────────────────────────── */

test("a forward-paper strategy's trades go to its own ledger", async () => {
  const lab = tempLab();
  const result = await lab.execute(entry({ strategyId: "mindset_v1", strategyVersion: "1.0.0", timeframe: "15m" }));

  assert.ok(result.opened, "the trade opened");
  assert.equal(result.ledger, ledgerKey("mindset_v1"));
  assert.equal(lab.strategyLedger("mindset_v1").getOpenPositions().length, 1);
  assert.equal(lab.book("main").getOpenPositions().length, 0, "and not into the portfolio book");
});

test("a backtest-only strategy is refused instead of falling back to legacy", async () => {
  const lab = tempLab();
  await assert.rejects(
    () => lab.execute(entry({ strategyId: "vwap_reversion_v1" })),
    (err) => err.statusCode === 409 && /cannot forward-paper trade/.test(err.message),
  );
  assert.equal(lab.strategyLedger("vwap_reversion_v1").getOpenPositions().length, 0);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("a Donchian trade cannot alter VWAP equity or history", async () => {
  const lab = tempLab();
  const donchian = lab.strategyLedger("donchian_breakout_v1");
  const vwap = lab.strategyLedger("vwap_reversion_v1");
  const vwapBefore = vwap.getAccount().balance;

  const position = donchian.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 95, tp1: 110, tp2: 120, riskUsd: 50,
  });
  // Closed at a profit, so there is realised P&L to leak if the ledgers were
  // sharing anything.
  await donchian.closePosition(position.id, { reason: "MANUAL", exitPrice: 150 });

  assert.equal(donchian.getHistory().length, 1);
  assert.ok(donchian.getAccount().balance > 10000, "Donchian booked the gain");

  assert.equal(vwap.getOpenPositions().length, 0);
  assert.equal(vwap.getHistory().length, 0);
  assert.equal(vwap.getAccount().balance, vwapBefore, "VWAP equity is untouched");
});

test("balances cannot leak between any two strategy accounts", () => {
  const lab = tempLab();
  const ids = listStrategyAccounts().map((a) => a.id);

  lab.strategyLedger(ids[0]).openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 5, entryPrice: 100,
    stopLoss: 95, tp1: 110, tp2: 120, riskUsd: 50,
  });

  for (const id of ids.slice(1)) {
    const account = lab.strategyLedger(id).getAccount();
    assert.equal(account.balance, account.startingBalance, `${id} was touched`);
    assert.equal(lab.strategyLedger(id).getOpenPositions().length, 0, `${id} has a position`);
  }
});

test("each account gets its own ledger directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-dirs-"));
  const lab = new TradingLabService({ dataDir: dir });

  for (const account of listStrategyAccounts()) {
    lab.strategyLedger(account.id).getAccount();
  }

  const dirs = fs.readdirSync(path.join(dir, "trading-lab")).sort();
  for (const account of listStrategyAccounts()) {
    assert.ok(dirs.includes(ledgerKey(account.id)), `${account.id} has no ledger directory`);
  }
  // The namespace must survive PaperTradingService's [a-z0-9_-] sanitiser — a
  // separator that gets stripped would flatten the namespace silently.
  assert.ok(ledgerKey("mindset_v1").startsWith("strategy-"));
  assert.equal(ledgerKey("mindset_v1"), ledgerKey("mindset_v1").replace(/[^a-z0-9_-]/gi, ""));
});

/* ── The gauntlet reads the ledger it writes ──────────────── */

test("risk state is read from the ledger the trade will be written to", async () => {
  const lab = tempLab();
  const account = lab.strategyLedger("mindset_v1");

  // Fill the strategy account to its position cap. The portfolio book is empty,
  // so a resolver that scored against Main would wave this through.
  const config = makeTradingConfig();
  for (let i = 0; i < config.maxOpenPositions; i += 1) {
    account.openPosition({
      symbol: `SYM${i}`, direction: "LONG", size: 1, entryPrice: 100,
      stopLoss: 95, tp1: 110, tp2: 120, riskUsd: 1,
    });
  }

  const result = await lab.execute(entry({ strategyId: "mindset_v1", symbol: "NEWUSDT" }));
  assert.equal(result.opened, null, "the strategy account's own position cap must bind");
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

/* ── Backtests never touch persistent accounts ────────────── */

test("a backtest leaves every persistent ledger untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-isolation-"));
  const lab = new TradingLabService({ dataDir: dir });
  for (const account of listStrategyAccounts()) lab.strategyLedger(account.id).getAccount();

  const candles = [];
  for (let i = 0; i < 300; i += 1) {
    const close = 100 + i * 0.8;
    candles.push({
      openTime: i * 14400000, closeTime: (i + 1) * 14400000,
      open: close - 0.4, high: close + 0.6, low: close - 0.8, close,
      volume: 1000 + (i % 5) * 200,
    });
  }

  const service = new BacktestService({ config: makeTradingConfig() });
  const run = await service.run({ symbol: "BTCUSDT", candles, marketContext: { htfTrendUp: true } });
  assert.ok(run.trades.length > 0, "the run needs trades to prove anything");

  for (const account of listStrategyAccounts()) {
    const ledger = lab.strategyLedger(account.id);
    assert.equal(ledger.getHistory().length, 0, `${account.id} history was written`);
    assert.equal(ledger.getAccount().balance, ledger.getAccount().startingBalance, `${account.id} balance moved`);
  }
  for (const book of lab.listBooks()) {
    assert.equal(lab.book(book.id).getHistory().length, 0, `${book.id} history was written`);
  }
});

/* ── Books survive ────────────────────────────────────────── */

test("the three legacy ledgers stay readable, unattributed and read-only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-readonly-"));
  const shadowDir = path.join(dir, "trading-lab", "shadow");
  fs.mkdirSync(shadowDir, { recursive: true });
  fs.writeFileSync(path.join(shadowDir, "history.json"), JSON.stringify([
    { id: "old-1", symbol: "BTCUSDT", realizedPnl: 25, signalSource: "legacy-import" },
  ]));
  const lab = new TradingLabService({ dataDir: dir });
  assert.deepEqual(lab.listBooks().map((b) => b.id), ["main", "shadow", "alts"]);
  assert.ok(lab.listBooks().every((b) => b.archived === true));

  const shadow = lab.book("shadow");
  assert.equal(shadow.getHistory().length, 1);
  assert.equal(shadow.getHistory()[0].meta, undefined, "unknown attribution stays unknown");
  for (const mutate of [
    () => shadow.openPosition({}),
    () => shadow.closePosition("old-1"),
    () => shadow.updatePositions(),
    () => shadow.addToHistory({}),
    () => shadow.reset(),
  ]) {
    assert.throws(mutate, /archived and read-only/);
  }
});

test("live research may run in an isolated account without promoting it", () => {
  for (const id of ["smc_v1", "donchian_breakout_v1", "vwap_reversion_v1"]) {
    const account = describeStrategyAccount(id);
    assert.equal(account.status, "backtest");
    assert.equal(account.scannerEligible, false);
    assert.equal(acceptsForwardTrades(id), false);
    assert.equal(account.liveResearchEligible, true);
    assert.equal(acceptsLiveResearchTrades(id), true);
  }
  assert.equal(acceptsLiveResearchTrades("shadow_bananagun_v1"), false);
});

test("a trade with no strategy attribution is refused and touches no legacy ledger", async () => {
  const lab = tempLab();
  await assert.rejects(
    () => lab.execute(entry({ signalSource: "signal-bot:4h" })),
    /requires a registered strategy identity/,
  );
  assert.equal(lab.book("main").getHistory().length, 0);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

/* ── Reporting ────────────────────────────────────────────── */

test("the accounts overview reports equity and lifecycle for every registered strategy", async () => {
  const lab = tempLab();
  const overview = await lab.strategyAccounts();

  assert.equal(overview.accounts.length, 6);
  assert.equal(overview.mode, "paper");
  assert.equal(
    new Set(overview.accounts.map((account) => account.stats.startingBalance)).size,
    1,
    "all strategy accounts must begin with the same fair starting balance",
  );
  for (const account of overview.accounts) {
    assert.ok(account.stats, `${account.id} has no stats`);
    assert.equal(account.stats.balance, account.stats.startingBalance);
    assert.ok(typeof account.label === "string" && account.label.length);
  }
});

test("one account reports its own metrics, regime breakdown and history", async () => {
  const lab = tempLab();
  await lab.execute(entry({ strategyId: "mindset_v1", strategyVersion: "1.0.0", timeframe: "15m", regime: "TREND_UP", regimeConfidence: 88 }));

  const detail = await lab.strategyAccount("mindset_v1");
  assert.equal(detail.id, "mindset_v1");
  assert.equal(detail.status, "forward-paper");
  assert.equal(detail.openPositions.length, 1);
  assert.equal(detail.openPositions[0].meta.regime, "TREND_UP");
  assert.ok(detail.metrics.groups);
  assert.ok(detail.regimeMetrics);

  await assert.rejects(() => lab.strategyAccount("nope"), (err) => err.statusCode === 404);
});

test("regime evidence attributes trades to the strategy, not the book", async () => {
  const lab = tempLab();
  const ledger = lab.strategyLedger("mindset_v1");

  ledger.addToHistory({
    status: "closed", symbol: "BTCUSDT", realizedPnl: 100, rMultiple: 0.5,
    signalSource: "live-scanner:15m",
    meta: { strategy: "mindset_v1", regime: "TREND_UP", regimeConfidence: 80 },
  });

  const detail = await lab.strategyAccount("mindset_v1");
  const row = detail.regimeMetrics.rows.find((r) => r.strategy === "mindset_v1");
  assert.ok(row, "the row is keyed by strategy identity, not by signalSource");
  assert.equal(row.cells.TREND_UP.closedTrades, 1);
});
