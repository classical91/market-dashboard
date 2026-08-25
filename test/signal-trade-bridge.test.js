"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SignalTradeBridge } = require("../src/services/trading/signal-bridge");
const { SignalActionStore } = require("../src/services/trading/signal-action-store");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");
const { listStrategyAccounts } = require("../src/services/trading/strategy-accounts");

const QUIET = { log() {}, warn() {}, error() {} };

// Candles flat enough that Wilder ATR lands on a known, small number: a $1
// range on every bar means ATR = 1 regardless of the smoothing window.
function flatCandles(close = 100, count = 60) {
  return Array.from({ length: count }, (_, i) => ({
    openTime: i * 3600000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 10,
    closeTime: (i + 1) * 3600000 - 1,
  }));
}

// The decision-engine reading production runs behind the bridge. Tests here
// are about BRIDGE behaviour — dry run, attribution refusal, and auto-marking —
// so the lab needs a market state that scores. An absent feed now scores as
// absent rather than as a favourable observation, so a lab with no engine
// refuses every entry; tests that want that refusal pass their own engine (or
// none) explicitly.
const BULLISH_DECISION = {
  regime: { score: 70, label: "Trending", modifiers: [] },
  newsRisk: { level: "low" },
};

function makeLab({
  configOverrides = {},
  priceFeed = null,
  decisionEngineService = { getDecision: async () => BULLISH_DECISION },
} = {}) {
  return new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-bridge-")),
    config: makeTradingConfig(configOverrides),
    priceFeed,
    decisionEngineService,
  });
}

function makeBridge({ lab = makeLab(), candles = flatCandles(), ...options } = {}) {
  const bridge = new SignalTradeBridge({
    tradingLabService: lab,
    signalScreenerService: { async getCandles() { return candles; } },
    logger: QUIET,
    ...options,
  });
  return { bridge, lab };
}

function transition(overrides = {}) {
  return { symbol: "BTCUSDT", interval: "4h", from: "FLAT", to: "LONG", score: 83, price: 100, ...overrides };
}

function setOpenedAt(trader, iso) {
  const positions = trader.getPositions();
  positions.forEach((pos) => {
    if (pos.status === "open") pos.openedAt = iso;
  });
  trader.savePositions(positions);
}

function closedCandle(overrides = {}) {
  const closeTime = Date.now() - 1000;
  return {
    openTime: closeTime - 3600000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    closeTime,
    ...overrides,
  };
}

test("dry run is the default: transitions are scored but nothing is opened", async () => {
  const { bridge, lab } = makeBridge();

  const actions = await bridge.handleTransitions([transition()]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "dry-run");
  assert.equal(actions[0].opened, null);
  // The reasoning still has to be produced — the point of the dry run is the
  // decision trail, not silence.
  assert.equal(actions[0].decision, "TAKE_HALF");
  assert.ok(actions[0].confidenceScore > 0);
  assert.ok(
    listStrategyAccounts().every((account) => lab.strategyLedger(account.id).getOpenPositions().length === 0),
    "dry run must not touch a persistent strategy ledger",
  );
});

// The Aug-21 symptom was an empty journal, not a bad strategy: the question a
// log has to answer is "was this setup evaluated and rejected, or never seen at
// all?". These three pin the properties that make that answerable.
test("every scored transition records its strategy and the regime it was scored in", async () => {
  const { bridge } = makeBridge();

  const [action] = await bridge.handleTransitions([transition({ interval: "1h" })]);

  assert.equal(action.strategy, "signal-bot:1h", "the edge gate's grouping key must survive into the log");
  assert.equal(action.regime, "TREND_UP", "a bullish decision state must be readable off the row");
  assert.equal(action.direction, "LONG");
  assert.ok(Number.isFinite(action.confidenceScore), "setup score must be recorded");
  assert.ok(action.reason, "and the row must say why it ended where it did");
});

test("a scoring failure is recorded as an outcome, not dropped", async () => {
  const lab = makeLab();
  lab.evaluate = () => { throw new Error("ledger unavailable"); };
  const { bridge } = makeBridge({ lab });

  const [action] = await bridge.handleTransitions([transition()]);

  assert.equal(action.status, "failed");
  assert.match(action.reason, /ledger unavailable/);
  assert.equal(action.strategy, "signal-bot:4h");
  assert.equal(action.opened, null);
});

// The count is the reconciliation: one row per entry transition processed,
// whatever happened to it. A mid-batch throw used to abandon the loop and
// return nothing, so the store and the caller disagreed about what ran.
test("one symbol's failure does not erase the rest of the batch's audit trail", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-reconcile-"));
  const store = new SignalActionStore({ dataDir, logger: QUIET });
  const lab = makeLab();
  const realEvaluate = lab.evaluate.bind(lab);
  lab.evaluate = (input) => {
    if (input.symbol === "ETHUSDT") throw new Error("boom");
    return realEvaluate(input);
  };
  const { bridge } = makeBridge({ lab, signalActionStore: store });

  const actions = await bridge.handleTransitions([
    transition({ symbol: "BTCUSDT" }),
    transition({ symbol: "ETHUSDT" }),
    transition({ symbol: "SOLUSDT" }),
  ]);

  assert.equal(actions.length, 3, "every processed transition must produce exactly one action");
  assert.equal(store.count(), 3, "and the persisted log must reconcile with the batch");
  assert.deepEqual(
    actions.map((a) => `${a.symbol}:${a.status}`),
    ["BTCUSDT:dry-run", "ETHUSDT:failed", "SOLUSDT:dry-run"],
  );
  assert.ok(actions.every((a) => a.reason), "no row may be silent about its outcome");
});

test("signal bridge actions persist newest-first with every outcome status", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-actions-"));
  const signalActionStore = new SignalActionStore({ dataDir, logger: QUIET });

  await makeBridge({ signalActionStore }).bridge.handleTransitions([transition({ symbol: "BTCUSDT" })]);
  await makeBridge({ signalActionStore, paperTradeEnabled: true }).bridge.handleTransitions([
    transition({ symbol: "ETHUSDT" }),
  ]);
  await makeBridge({ signalActionStore, paperTradeEnabled: true }).bridge.handleTransitions([
    transition({ symbol: "SOLUSDT", price: null }),
  ]);

  const lab = makeLab({ configOverrides: { maxOpenPositions: 1 } });
  const { bridge } = makeBridge({ lab, signalActionStore, paperTradeEnabled: true });
  await bridge.handleTransitions([transition({ symbol: "AVAXUSDT" })]);
  await bridge.handleTransitions([transition({ symbol: "LINKUSDT" })]);

  const actions = signalActionStore.recent(10);
  assert.deepEqual(new Set(actions.map((a) => a.status)), new Set(["dry-run", "skipped", "blocked"]));
  assert.ok(actions.every((a) => a.timestamp), "each persisted action has a timestamp");
  assert.ok(actions.every((a) => a.entryPrice === null || a.entryPrice > 0), "entry price is persisted when known");
  assert.equal(actions[0].status, "blocked", "newest entries are returned first");
});

test("signal bridge action log is capped", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-actions-cap-"));
  const signalActionStore = new SignalActionStore({ dataDir, logger: QUIET, cap: 3 });

  for (let i = 0; i < 5; i += 1) {
    signalActionStore.record({ symbol: `T${i}`, interval: "4h", direction: "LONG", status: "dry-run" });
  }

  assert.deepEqual(signalActionStore.recent(10).map((a) => a.symbol), ["T4", "T3", "T2"]);
});

test("a signal action write failure is caught and the scan action still returns", async () => {
  const { bridge } = makeBridge({
    signalActionStore: {
      record() { throw new Error("disk full"); },
    },
  });

  const [action] = await bridge.handleTransitions([transition()]);
  assert.equal(action.status, "dry-run");
  assert.equal(action.symbol, "BTCUSDT");
});

test("only FLAT -> LONG/SHORT transitions are considered", async () => {
  const { bridge } = makeBridge({ paperTradeEnabled: true });

  const actions = await bridge.handleTransitions([
    transition({ from: "LONG", to: "FLAT" }),
    transition({ from: "LONG", to: "SHORT" }),
    transition({ from: "FLAT", to: "FLAT" }),
  ]);

  assert.deepEqual(actions, [], "exits and flips are not entries");
});

test("when enabled, an allowed unattributed setup is refused without persistent mutation", async () => {
  const { bridge, lab } = makeBridge({ paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition()]);

  assert.equal(action.status, "blocked");
  assert.equal(action.book, "UNATTRIBUTED");
  assert.match(action.reason, /no registered strategy identity/i);
  assert.ok(listStrategyAccounts().every(
    (account) => lab.strategyLedger(account.id).getOpenPositions().length === 0,
  ));
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("a blocked setup is recorded with its reason and opens nothing", async () => {
  // A high-impact news window trips the checklist's kill switch before any
  // score can be earned.
  const lab = makeLab({
    decisionEngineService: {
      async getDecision() {
        return { regime: { label: "Neutral", score: 50 }, newsRisk: { level: "high" } };
      },
    },
  });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition()]);

  assert.equal(action.status, "blocked");
  assert.equal(action.decision, "SKIP");
  assert.match(action.reason, /no registered strategy identity/i);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("every unattributed transition is refused, even within one cycle", async () => {
  const { bridge, lab } = makeBridge({ paperTradeEnabled: true });

  // Same symbol flipping on both watched timeframes in the same scan.
  const actions = await bridge.handleTransitions([
    transition({ interval: "4h" }),
    transition({ interval: "1D" }),
  ]);

  assert.ok(actions.every((action) => action.status === "blocked"));
  assert.ok(actions.every((action) => /no registered strategy identity/i.test(action.reason)));
  assert.equal(lab.book("main").getOpenPositions().length, 0);

  // And again on the next cycle, while the position is still open.
  const [later] = await bridge.handleTransitions([transition()]);
  assert.equal(later.status, "blocked");
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("a transition without a price is skipped rather than sized off a guess", async () => {
  const { bridge, lab } = makeBridge({ paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition({ price: null })]);

  assert.equal(action.status, "skipped");
  assert.match(action.reason, /No price/);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("unattributed refusal is reported, not thrown", async () => {
  const lab = makeLab({ configOverrides: { maxOpenPositions: 1 } });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });

  await bridge.handleTransitions([transition({ symbol: "BTCUSDT" })]);
  const [second] = await bridge.handleTransitions([transition({ symbol: "ETHUSDT" })]);

  assert.equal(second.status, "blocked");
  assert.match(second.reason, /no registered strategy identity/i);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("auto-marking resolves take-profits on the bot's interval, with no page open", async () => {
  let price = 100;
  const lab = makeLab({ priceFeed: async () => price });
  const trader = lab.strategyLedger("mindset_v1");
  trader.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 98.5, tp1: 102.25, tp2: 103.75, riskUsd: 1.5, signalSource: "signal-bot:4h",
  });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });
  const position = trader.getOpenPositions()[0];

  // TP2 sits at 2.5R above a $1.50 stop distance. Delivered as a closed bar,
  // so this exercises the replay path the bot actually runs — backdated, since
  // only bars that closed after the entry are replayed.
  price = position.tp2 + 1;
  setOpenedAt(trader, new Date(Date.now() - 86_400_000).toISOString());
  bridge._screener = { async getCandles() { return [closedCandle({ high: position.tp2 + 1 })]; } };
  const marks = await bridge.markOpenPositions();

  assert.equal(marks.length, 1);
  assert.equal(marks[0].strategyId, "mindset_v1");
  assert.deepEqual(marks[0].events.map((e) => e.type), ["TP1_HIT", "TP2_HIT"]);
  assert.equal(trader.getOpenPositions().length, 0, "the position closed itself");

  const [closed] = trader.getHistory();
  assert.equal(closed.closeReason, "TP2");
  assert.ok(closed.pnl > 0);
});

test("candle replay marks a LONG stop even when the candle closes back above it", async () => {
  const candle = closedCandle({ open: 100, low: 94, high: 108, close: 101 });
  const lab = makeLab();
  const trader = lab.strategyLedger("mindset_v1");
  trader.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 95, tp1: 110, tp2: 120, riskUsd: 5, signalSource: "signal-bot:4h",
  });
  setOpenedAt(trader, new Date(candle.closeTime - 3600000).toISOString());
  const { bridge } = makeBridge({ lab, candles: [candle] });

  const marks = await bridge.markOpenPositions();

  assert.deepEqual(marks[0].events.map((e) => e.type), ["STOP_HIT"]);
  assert.equal(trader.getOpenPositions().length, 0);
  const [closed] = trader.getHistory();
  assert.equal(closed.closeReason, "STOP_LOSS");
  assert.equal(closed.exitPrice, 94);
});

test("candle replay fills TP1 and TP2 in order on the same bar", async () => {
  const candle = closedCandle({ open: 100, low: 99, high: 112, close: 111 });
  const lab = makeLab();
  const trader = lab.strategyLedger("mindset_v1");
  trader.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 95, tp1: 105, tp2: 110, riskUsd: 5, signalSource: "signal-bot:4h",
  });
  setOpenedAt(trader, new Date(candle.closeTime - 3600000).toISOString());
  const { bridge } = makeBridge({ lab, candles: [candle] });

  const marks = await bridge.markOpenPositions();

  assert.deepEqual(marks[0].events.map((e) => e.type), ["TP1_HIT", "TP2_HIT"]);
  const [closed] = trader.getHistory();
  assert.equal(closed.closeReason, "TP2");
});

test("auto-marking falls back to ticker marking when candles throw", async () => {
  const lab = makeLab({ priceFeed: async () => 94 });
  const trader = lab.strategyLedger("mindset_v1");
  trader.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 95, tp1: 105, tp2: 110, riskUsd: 5, signalSource: "signal-bot:4h",
  });
  const { bridge } = makeBridge({
    lab,
    signalScreenerService: { async getCandles() { throw new Error("Binance klines HTTP 500"); } },
  });

  const marks = await bridge.markOpenPositions();

  assert.deepEqual(marks[0].events.map((e) => e.type), ["STOP_HIT"]);
  assert.equal(trader.getOpenPositions().length, 0);
});

test("Signal Bridge never marks a live-research-owned position", async () => {
  const lab = makeLab({ priceFeed: async () => 90 });
  const trader = lab.strategyLedger("mindset_v1");
  trader.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 95, tp1: 105, tp2: 110, riskUsd: 5,
    signalSource: "live-research:1h", executionOwner: "live-research",
  });
  const { bridge } = makeBridge({
    lab,
    signalScreenerService: { async getCandles() { throw new Error("must not fetch"); } },
  });

  assert.deepEqual(await bridge.markOpenPositions(), []);
  assert.equal(trader.getOpenPositions().length, 1);
  assert.equal(trader.getHistory().length, 0);
  assert.equal(trader.readAccount().realizedPnl, 0);
});

test("auto-marking can be switched off, and marks every strategy account when on", async () => {
  let price = 100;
  const lab = makeLab({ priceFeed: async () => price });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true, autoMarkEnabled: false });
  const mindset = lab.strategyLedger("mindset_v1");
  mindset.openPosition({
    symbol: "BTCUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 98.5, tp1: 102.25, tp2: 103.75, riskUsd: 1.5, signalSource: "signal-bot:4h",
  });
  const position = mindset.getOpenPositions()[0];
  price = position.tp2 + 1;

  assert.deepEqual(await bridge.markOpenPositions(), []);
  assert.equal(mindset.getOpenPositions().length, 1, "nothing is marked while disabled");

  // A seeded position in another strategy account is managed too once marking is on.
  lab.strategyLedger("smc_v1").openPosition({
    symbol: "ETHUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 98.5, tp1: 102.25, tp2: 103.75, riskUsd: 25, signalSource: "signal-bot:4h",
  });
  bridge.autoMarkEnabled = true;
  const marks = await bridge.markOpenPositions();
  assert.deepEqual(marks.map((m) => m.strategyId).sort(), ["mindset_v1", "smc_v1"]);
});

test("replaying one symbol's bars never marks another symbol", async () => {
  let feedCalls = 0;
  // A ticker far below ETH's stop: if ETH is ever marked against it rather
  // than its own bars, it stops out at the wrong price and the wrong moment.
  const lab = makeLab({ priceFeed: async () => { feedCalls += 1; return 50; } });
  const trader = lab.strategyLedger("mindset_v1");
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    trader.openPosition({
      symbol, direction: "LONG", size: 1, entryPrice: 100,
      stopLoss: 98.5, tp1: 102.25, tp2: 103.75, riskUsd: 25,
      signalSource: "signal-bot:4h",
    });
  }
  setOpenedAt(trader, new Date(Date.now() - 86_400_000).toISOString());

  // Quiet bars for both symbols: nothing should fire at all.
  const { bridge } = makeBridge({ lab, candles: [closedCandle()] });
  const marks = await bridge.markOpenPositions();

  assert.deepEqual(marks[0].events, [], "a quiet bar fires nothing for either symbol");
  assert.equal(trader.getOpenPositions().length, 2, "neither position was closed at the ticker price");
  assert.equal(feedCalls, 0, "replay uses the bars, never the live ticker");
});

test("a candle failure for one symbol does not disturb another symbol's replay", async () => {
  const lab = makeLab({ priceFeed: async () => 104 });
  const trader = lab.strategyLedger("mindset_v1");
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    trader.openPosition({
      symbol, direction: "LONG", size: 1, entryPrice: 100,
      stopLoss: 98.5, tp1: 102.25, tp2: 103.75, riskUsd: 25,
      signalSource: "signal-bot:4h",
    });
  }
  setOpenedAt(trader, new Date(Date.now() - 86_400_000).toISOString());

  const { bridge } = makeBridge({
    lab,
    signalScreenerService: {
      async getCandles(symbol) {
        if (symbol === "ETHUSDT") throw new Error("Binance klines HTTP 500");
        return [closedCandle()]; // quiet bar: BTC should not move
      },
    },
  });

  const marks = await bridge.markOpenPositions();

  // ETH falls back to the ticker at 104 and takes both targets; BTC keeps its
  // bar-replayed result rather than being dragged along to the ticker.
  const eth = trader.getHistory().filter((t) => t.symbol === "ETHUSDT");
  assert.equal(eth.length, 1, "the failing symbol still gets a ticker mark");
  assert.ok(marks[0].events.length >= 1, "events from the fallback are not discarded");
  const btc = trader.getOpenPositions().filter((p) => p.symbol === "BTCUSDT");
  assert.equal(btc.length, 1, "the healthy symbol stays open on its quiet bar");
  assert.equal(btc[0].currentPrice, 100, "and was never marked at the other symbol's ticker price");
});

test("an unreachable decision engine degrades gracefully — and refuses to trade blind", async () => {
  const lab = makeLab({
    decisionEngineService: {
      async getDecision() { throw new Error("Binance klines HTTP 403"); },
    },
  });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition()]);

  // Degrading gracefully means the pipeline keeps running and keeps
  // explaining itself: no throw, an action, a decision, a reason.
  assert.ok(action, "an outage must not take the bridge down with it");
  assert.equal(action.decision, "SKIP");
  assert.ok(action.reason, "a refusal has to say why");

  // It does NOT mean trading anyway. With the macro feed down every macro
  // input is unmeasured, and unmeasured no longer reads as favourable — so the
  // setup cannot reach the 50-point floor and nothing opens.
  //
  // This assertion is the reverse of what it used to be, deliberately. The old
  // behaviour was that an outage still opened positions, because the
  // checklist's macro defaults ("dominance flat, not a bear market") scored a
  // long at 57 out of thin air. A bot that keeps trading longs precisely when
  // it has lost sight of the market is not degrading gracefully, it is
  // degrading silently.
  assert.notEqual(action.status, "opened");
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("candle failures still produce a safe attribution refusal", async () => {
  const { bridge, lab } = makeBridge({
    paperTradeEnabled: true,
    signalScreenerService: { async getCandles() { throw new Error("Binance klines HTTP 500"); } },
  });

  const [action] = await bridge.handleTransitions([transition()]);
  assert.equal(action.status, "blocked");
  assert.match(action.reason, /no registered strategy identity/i);
  assert.ok(listStrategyAccounts().every(
    (account) => lab.strategyLedger(account.id).getOpenPositions().length === 0,
  ));
});

test("the bridge only justifies its own schedule when paper trading is enabled", () => {
  const lab = makeLab();
  const marking = new SignalTradeBridge({ tradingLabService: lab, logger: QUIET });
  assert.equal(marking.active, true, "auto-marking is work worth doing inside a cycle");
  assert.equal(marking.requiresSchedule, false, "but not a reason to start scanning");

  const trading = new SignalTradeBridge({ tradingLabService: lab, paperTradeEnabled: true, logger: QUIET });
  assert.equal(trading.requiresSchedule, true);

  const off = new SignalTradeBridge({ tradingLabService: lab, autoMarkEnabled: false, logger: QUIET });
  assert.equal(off.active, false);
});
