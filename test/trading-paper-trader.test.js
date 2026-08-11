"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PaperTradingService } = require("../src/services/trading/paper-trader");
const { makeTradingConfig } = require("../src/services/trading/config");

function makeTrader(configOverrides = {}) {
  return new PaperTradingService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-lab-")),
    book: "main",
    config: makeTradingConfig(configOverrides),
  });
}

// A 1 BTC long at 100 risking $10: stop 90, TP1 115, TP2 125.
function openLong(trader, overrides = {}) {
  return trader.openPosition({
    symbol: "BTCUSDT",
    direction: "LONG",
    size: 1,
    entryPrice: 100,
    stopLoss: 90,
    tp1: 115,
    tp2: 125,
    riskUsd: 10,
    confidenceScore: 82,
    signalSource: "test",
    ...overrides,
  });
}

test("a new account starts at the configured balance", () => {
  const trader = makeTrader({ accountSize: 25000 });
  const account = trader.getAccount();
  assert.equal(account.balance, 25000);
  assert.equal(account.startingBalance, 25000);
  assert.equal(account.totalTrades, 0);
});

test("opening a position records the full scale-out schema", () => {
  const trader = makeTrader();
  const pos = openLong(trader);
  assert.equal(pos.initialSize, 1);
  assert.equal(pos.remainingSize, 1);
  assert.deepEqual(pos.exits, []);
  assert.equal(pos.realizedPnl, 0);
  assert.equal(pos.status, "open");
  assert.equal(trader.getOpenPositions().length, 1);
});

test("open positions are capped at the configured maximum", () => {
  const trader = makeTrader({ maxOpenPositions: 2 });
  openLong(trader);
  openLong(trader);
  assert.throws(() => openLong(trader), /Max open positions/);
});

test("TP1 closes half the position, banks the P&L and moves the stop to breakeven", async () => {
  const trader = makeTrader();
  const pos = openLong(trader);

  const events = await trader.updatePositions({ BTCUSDT: 116 });
  assert.deepEqual(events.map((e) => e.type), ["TP1_HIT"]);

  const [updated] = trader.getOpenPositions();
  assert.equal(updated.tp1Hit, true);
  assert.equal(updated.remainingSize, 0.5);
  // Filled at the target itself, not the overshoot: (115 - 100) * 0.5.
  assert.equal(updated.realizedPnl, 7.5);
  assert.equal(updated.stopLoss, 100);
  assert.equal(updated.status, "open");
  assert.equal(trader.getAccount().balance, 10007.5);
  assert.equal(updated.exits.length, 1);
  assert.equal(updated.exits[0].reason, "TP1_PARTIAL");
  assert.equal(pos.id, updated.id);
});

test("TP2 closes the remainder and archives the trade with summed P&L", async () => {
  const trader = makeTrader();
  openLong(trader);

  await trader.updatePositions({ BTCUSDT: 116 });
  const events = await trader.updatePositions({ BTCUSDT: 126 });
  assert.deepEqual(events.map((e) => e.type), ["TP2_HIT"]);

  const [closed] = trader.getHistory();
  // 7.5 from the TP1 half plus (125 - 100) * 0.5 from the TP2 half.
  assert.equal(closed.pnl, 20);
  assert.equal(closed.rMultiple, 2); // 20 / 10 risk
  assert.equal(closed.closeReason, "TP2");
  assert.equal(closed.exits.length, 2);
  assert.equal(trader.getOpenPositions().length, 0);

  const account = trader.getAccount();
  assert.equal(account.balance, 10020);
  assert.equal(account.wins, 1);
  assert.equal(account.totalTrades, 1);
});

test("a stop after TP1 is a breakeven exit, not a loss", async () => {
  const trader = makeTrader();
  openLong(trader);

  await trader.updatePositions({ BTCUSDT: 116 }); // TP1, stop moves to 100
  const events = await trader.updatePositions({ BTCUSDT: 100 });
  assert.deepEqual(events.map((e) => e.type), ["STOP_HIT"]);

  const [closed] = trader.getHistory();
  assert.equal(closed.closeReason, "TRAILING_STOP");
  assert.equal(closed.pnl, 7.5); // the TP1 profit is kept; the rest exits flat
  assert.equal(trader.getAccount().wins, 1);
});

test("a stop fills at the worse of its level and the observed price", async () => {
  const trader = makeTrader();
  openLong(trader);

  // Price gapped through the 90 stop down to 85 — crediting a fill at 90
  // would flatter the result, so the gap is taken.
  await trader.updatePositions({ BTCUSDT: 85 });
  const [closed] = trader.getHistory();
  assert.equal(closed.exitPrice, 85);
  assert.equal(closed.pnl, -15);
  assert.equal(closed.rMultiple, -1.5);
  assert.equal(closed.closeReason, "STOP_LOSS");
});

test("targets do not credit a favourable overshoot", async () => {
  const trader = makeTrader();
  openLong(trader);
  // Straight through both targets in one tick: each fills at its own level.
  await trader.updatePositions({ BTCUSDT: 200 });
  const [closed] = trader.getHistory();
  assert.equal(closed.pnl, 20);
  assert.deepEqual(closed.exits.map((e) => e.price), [115, 125]);
});

test("a short mirrors the long's P&L arithmetic", async () => {
  const trader = makeTrader();
  trader.openPosition({
    symbol: "ETHUSDT",
    direction: "SHORT",
    size: 2,
    entryPrice: 100,
    stopLoss: 110,
    tp1: 85,
    tp2: 75,
    riskUsd: 20,
    signalSource: "test",
  });

  await trader.updatePositions({ ETHUSDT: 84 });
  const [open] = trader.getOpenPositions();
  assert.equal(open.remainingSize, 1);
  assert.equal(open.realizedPnl, 15); // (100 - 85) * 1
  assert.equal(open.stopLoss, 100);

  await trader.updatePositions({ ETHUSDT: 74 });
  const [closed] = trader.getHistory();
  assert.equal(closed.pnl, 40); // 15 + (100 - 75) * 1
  assert.equal(closed.rMultiple, 2);
});

test("a losing trade increments the loss streak, a win resets it", async () => {
  const trader = makeTrader();
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 90 });
  assert.equal(trader.getAccount().consecutiveLosses, 1);

  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 90 });
  assert.equal(trader.getAccount().consecutiveLosses, 2);

  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 116 });
  await trader.updatePositions({ BTCUSDT: 126 });
  assert.equal(trader.getAccount().consecutiveLosses, 0);
  assert.equal(trader.getAccount().wins, 1);
  assert.equal(trader.getAccount().losses, 2);
});

test("a win is counted once per trade, not once per partial fill", async () => {
  const trader = makeTrader();
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 116 });
  await trader.updatePositions({ BTCUSDT: 126 });
  const account = trader.getAccount();
  assert.equal(account.totalTrades, 1);
  assert.equal(account.wins, 1);
});

test("a manual close exits the remainder at the given price", async () => {
  const trader = makeTrader();
  const pos = openLong(trader);
  const closed = await trader.closePosition(pos.id, { reason: "MANUAL", exitPrice: 108 });
  assert.equal(closed.pnl, undefined); // pnl lives on the archived copy
  assert.equal(closed.realizedPnl, 8);
  assert.equal(trader.getHistory()[0].pnl, 8);
  assert.equal(await trader.closePosition(pos.id, { exitPrice: 108 }), null);
});

test("execution costs are recorded on entry and exits", async () => {
  const trader = makeTrader({ takerFeeRate: 0.001, slippageRate: 0.001, fundingRate8h: 0.0008 });
  openLong(trader, { openedAt: 0 });

  const [open] = trader.getOpenPositions();
  assert.equal(open.entryPrice, 100.1);
  assert.equal(open.costs.entryFee, 0.1);
  assert.equal(trader.getAccount().balance, 9999.9);

  await trader.updatePositions({ BTCUSDT: 116 }, { at: 8 * 60 * 60 * 1000 });
  const [updated] = trader.getOpenPositions();
  assert.equal(updated.exits[0].requestedPrice, 115);
  assert.equal(updated.exits[0].price, 114.885);
  assert.equal(updated.exits[0].fee, 0.06);
  assert.equal(updated.exits[0].funding, 0.04);
  assert.ok(updated.realizedPnl < 7.5);
});

test("daily and weekly P&L reset when the UTC day rolls over", () => {
  const trader = makeTrader();
  const account = trader.getAccount();
  account.dailyPnl = -250;
  account.weeklyPnl = -250;
  account.dailyDate = "1999-01-01";
  account.weekStart = "1999-W01";
  trader.saveAccount(account);

  const rolled = trader.getAccount();
  assert.equal(rolled.dailyPnl, 0);
  assert.equal(rolled.weeklyPnl, 0);
  assert.notEqual(rolled.dailyDate, "1999-01-01");
});

test("risk state reports live losses as positive percentages for the kill switches", async () => {
  const trader = makeTrader();
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 90 }); // -$10 realized

  const state = trader.getRiskState();
  assert.equal(state.dailyLossPct, 0.1); // $10 on a $10k account
  assert.equal(state.weeklyLossPct, 0.1);
  assert.equal(state.consecutiveLosses, 1);
  assert.equal(state.openPositions, 0);
});

test("open risk is summed into totalRiskPct", () => {
  const trader = makeTrader();
  openLong(trader);
  openLong(trader);
  const state = trader.getRiskState();
  assert.equal(state.openPositions, 2);
  assert.equal(state.totalRiskPct, 0.2); // two $10 risks on $10k
});

test("stats fold the risk metrics in and mark open positions to market", async () => {
  const trader = makeTrader();
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 116 });
  await trader.updatePositions({ BTCUSDT: 126 });
  openLong(trader);

  const stats = await trader.getStats({});
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.winRate, 100);
  assert.equal(stats.realizedPnl, 20);
  assert.equal(stats.openPositions, 1);
  assert.equal(stats.riskMetrics.closedTrades, 1);
  assert.equal(stats.riskMetrics.expectancyR, 2);
});

test("books are isolated from one another", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-lab-"));
  const config = makeTradingConfig();
  const main = new PaperTradingService({ dataDir, book: "main", config });
  const shadow = new PaperTradingService({ dataDir, book: "shadow", config });

  openLong(main);
  assert.equal(main.getOpenPositions().length, 1);
  assert.equal(shadow.getOpenPositions().length, 0);
});

test("reset wipes positions and history and restores the starting balance", async () => {
  const trader = makeTrader();
  openLong(trader);
  await trader.updatePositions({ BTCUSDT: 90 });

  const account = trader.reset();
  assert.equal(account.balance, 10000);
  assert.equal(trader.getHistory().length, 0);
  assert.equal(trader.getPositions().length, 0);
});

test("legacy positions without scale-out fields are migrated on read", () => {
  const trader = makeTrader();
  trader.save(trader.positionsFile, [
    { id: "OLD1", symbol: "BTCUSDT", direction: "LONG", size: 2, entryPrice: 100, status: "open" },
  ]);
  const [pos] = trader.getPositions();
  assert.equal(pos.initialSize, 2);
  assert.equal(pos.remainingSize, 2);
  assert.deepEqual(pos.exits, []);
  assert.equal(pos.realizedPnl, 0);
});

test("a corrupted ledger falls back to empty rather than throwing", () => {
  const trader = makeTrader();
  fs.mkdirSync(trader.dir, { recursive: true });
  fs.writeFileSync(trader.positionsFile, "{not json");
  assert.deepEqual(trader.getPositions(), []);
});
