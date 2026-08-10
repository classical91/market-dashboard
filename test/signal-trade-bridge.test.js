"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SignalTradeBridge } = require("../src/services/trading/signal-bridge");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");

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

function makeLab({ configOverrides = {}, priceFeed = null, decisionEngineService = null } = {}) {
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

test("dry run is the default: transitions are scored but nothing is opened", async () => {
  const { bridge, lab } = makeBridge();

  const actions = await bridge.handleTransitions([transition()]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "dry-run");
  assert.equal(actions[0].opened, null);
  // The reasoning still has to be produced — the point of the dry run is the
  // decision trail, not silence.
  assert.equal(actions[0].decision, "TAKE_QUARTER");
  assert.ok(actions[0].confidenceScore > 0);
  assert.equal(lab.book("main").getOpenPositions().length, 0, "dry run must not touch the ledger");
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

test("when enabled, an allowed setup opens a sized paper position", async () => {
  const { bridge, lab } = makeBridge({ paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition()]);

  assert.equal(action.status, "opened");
  assert.ok(action.opened, "an opened position is returned");

  const open = lab.book("main").getOpenPositions();
  assert.equal(open.length, 1);
  assert.equal(open[0].symbol, "BTCUSDT");
  assert.equal(open[0].direction, "LONG");
  assert.equal(open[0].entryPrice, 100, "entry is the price the signal confirmed at");
  assert.equal(open[0].signalSource, "signal-bot:4h");
  // ATR 1 × SL_ATR_MULTIPLE 1.5 below a $100 entry — sizing came from the
  // candles, not from the ATR_FALLBACK_PCT guess.
  assert.equal(open[0].stopLoss, 98.5);
  assert.ok(open[0].size > 0);
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
  assert.match(action.reason, /Checklist skipped/);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("a symbol already open is not doubled up, even within one cycle", async () => {
  const { bridge, lab } = makeBridge({ paperTradeEnabled: true });

  // Same symbol flipping on both watched timeframes in the same scan.
  const actions = await bridge.handleTransitions([
    transition({ interval: "4h" }),
    transition({ interval: "1D" }),
  ]);

  assert.equal(actions[0].status, "opened");
  assert.equal(actions[1].status, "skipped");
  assert.match(actions[1].reason, /already open/);
  assert.equal(lab.book("main").getOpenPositions().length, 1);

  // And again on the next cycle, while the position is still open.
  const [later] = await bridge.handleTransitions([transition()]);
  assert.equal(later.status, "skipped");
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

test("a transition without a price is skipped rather than sized off a guess", async () => {
  const { bridge, lab } = makeBridge({ paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition({ price: null })]);

  assert.equal(action.status, "skipped");
  assert.match(action.reason, /No price/);
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

test("the max-open-positions refusal is reported, not thrown", async () => {
  const lab = makeLab({ configOverrides: { maxOpenPositions: 1 } });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });

  await bridge.handleTransitions([transition({ symbol: "BTCUSDT" })]);
  const [second] = await bridge.handleTransitions([transition({ symbol: "ETHUSDT" })]);

  assert.equal(second.status, "blocked");
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

test("auto-marking resolves take-profits on the bot's interval, with no page open", async () => {
  let price = 100;
  const lab = makeLab({ priceFeed: async () => price });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });

  await bridge.handleTransitions([transition()]);
  const position = lab.book("main").getOpenPositions()[0];

  // TP2 sits at 2.5R above a $1.50 stop distance.
  price = position.tp2 + 1;
  const marks = await bridge.markOpenPositions();

  assert.equal(marks.length, 1);
  assert.equal(marks[0].book, "main");
  assert.deepEqual(marks[0].events.map((e) => e.type), ["TP1_HIT", "TP2_HIT"]);
  assert.equal(lab.book("main").getOpenPositions().length, 0, "the position closed itself");

  const [closed] = lab.book("main").getHistory();
  assert.equal(closed.closeReason, "TP2");
  assert.ok(closed.pnl > 0);
});

test("auto-marking can be switched off, and marks every book when on", async () => {
  let price = 100;
  const lab = makeLab({ priceFeed: async () => price });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true, autoMarkEnabled: false });

  await bridge.handleTransitions([transition()]);
  const position = lab.book("main").getOpenPositions()[0];
  price = position.tp2 + 1;

  assert.deepEqual(await bridge.markOpenPositions(), []);
  assert.equal(lab.book("main").getOpenPositions().length, 1, "nothing is marked while disabled");

  // A hand-opened position in another book is managed too, once marking is on.
  lab.book("shadow").openPosition({
    symbol: "ETHUSDT", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 98.5, tp1: 102.25, tp2: 103.75, riskUsd: 25,
  });
  bridge.autoMarkEnabled = true;
  const marks = await bridge.markOpenPositions();
  assert.deepEqual(marks.map((m) => m.book).sort(), ["main", "shadow"]);
});

test("an unreachable decision engine degrades to a neutral state instead of failing", async () => {
  const lab = makeLab({
    decisionEngineService: {
      async getDecision() { throw new Error("Binance klines HTTP 403"); },
    },
  });
  const { bridge } = makeBridge({ lab, paperTradeEnabled: true });

  const [action] = await bridge.handleTransitions([transition()]);
  assert.equal(action.status, "opened", "a missing macro read must not block evaluation entirely");
});

test("candle failures fall back to the configured ATR assumption", async () => {
  const { bridge, lab } = makeBridge({
    paperTradeEnabled: true,
    signalScreenerService: { async getCandles() { throw new Error("Binance klines HTTP 500"); } },
  });

  const [action] = await bridge.handleTransitions([transition()]);
  assert.equal(action.status, "opened");
  // ATR_FALLBACK_PCT 1% of 100 = 1.0, × SL_ATR_MULTIPLE 1.5.
  assert.equal(lab.book("main").getOpenPositions()[0].stopLoss, 98.5);
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
