"use strict";

// The architecture rule, made enforceable: a strategy emits raw intent only.
// Sizing, levels and scoring belong to the Trading Lab, and these tests fail if
// a future edit moves any of that back into the scanner.
//
// Also covers the deliberate asymmetry at the handler boundary: entries pass
// through every gate, exits pass through none.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LiveScannerService,
  buildTradeIntent,
  TradeIntentHandler,
  parseBitgetCandles,
  evaluateMindsetV1,
  resolveTimeframe,
  TIMEFRAMES,
} = require("../src/services/trading/live-scanner");
const { RISK_FIELDS } = require("../src/services/trading/trade-intent");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");

const QUIET = { log() {}, warn() {}, error() {} };
const TF_MS = 900_000;

function candleRows(priceFn, { count = 200, ms = TF_MS } = {}) {
  const formingOpenTime = Math.floor(Date.now() / ms) * ms;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const openTime = formingOpenTime - (count - 1 - i) * ms;
    const close = priceFn(i);
    const open = priceFn(Math.max(0, i - 1));
    rows.push([
      String(openTime), String(open), String(Math.max(open, close) + 1),
      String(Math.min(open, close) - 1), String(close), String(100 + (i % 5) * 20), "0",
    ]);
  }
  return rows;
}

const payload = (rows) => ({ code: "00000", msg: "success", data: rows });
const UP = (i) => 100 + i * 0.5 + 3 * Math.sin(i / 2);
const DOWN = (i) => 200 - i * 0.5 - 3 * Math.sin(i / 2);

function memoryCache() {
  const map = new Map();
  return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v) };
}

// The decision-engine reading production runs behind the intent handler. These
// tests are about the ENTRY/EXIT boundary, not about scoring, so the lab needs
// a market state that actually scores — an absent feed now scores as absent
// rather than as a favourable observation, so an engineless lab refuses
// entries outright.
const BULLISH_DECISION = {
  regime: { score: 70, label: "Trending", modifiers: [] },
  newsRisk: { level: "low" },
};

// The scanner runs mindset_v1, which is forward-paper and therefore keeps its
// own strategy account. Its positions live there, not in the portfolio book —
// so these tests resolve the ledger the same way the handler does rather than
// hard-coding a book name.
function scannerLedger(lab) {
  return lab.ledgerFor({ book: "main", strategyId: "mindset_v1" });
}

function makeLab(configOverrides = {}) {
  return new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-intent-")),
    config: makeTradingConfig(configOverrides),
    priceFeed: null,
    decisionEngineService: { getDecision: async () => BULLISH_DECISION },
  });
}

function makeScanner({ rows = candleRows(UP), lab = makeLab(), ...options } = {}) {
  const scanner = new LiveScannerService({
    tradingLabService: lab,
    stateCache: memoryCache(),
    enabled: true,
    logger: QUIET,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload(rows) }),
    ...options,
  });
  return { scanner, lab };
}

function intentsFrom(rows) {
  const scanner = makeScanner({ rows }).scanner;
  const candles = parseBitgetCandles(payload(rows), "15m");
  const evaluation = evaluateMindsetV1(candles);
  return scanner.intentsFor(evaluation, candles[candles.length - 1]);
}

// ── Rule 1 / 5: the intent carries no risk fields ───────────────────────────

test("a scanner intent has exactly the raw-intent shape", () => {
  const [, entry] = intentsFrom(candleRows(UP));
  // `strategyVersion`, `regime` and `regimeConfidence` are attribution and
  // observation respectively — identity of the rules that fired, and the
  // environment they fired in. Neither is a sizing, level or scoring decision,
  // which is what this shape guard exists to keep out.
  assert.deepEqual(Object.keys(entry).sort(), [
    "candleTs", "indicators", "price", "regime", "regimeConfidence",
    "signal", "source", "strategy", "strategyVersion", "symbol", "tf",
  ]);
  assert.equal(entry.signal, "LONG");
  assert.equal(entry.symbol, "BTCUSDT.P");
  assert.equal(entry.tf, "15m");
  assert.equal(entry.source, "live_scanner");
  assert.equal(entry.strategy, "mindset_v1");
  assert.equal(entry.strategyVersion, "1.0.0");
  assert.ok(entry.price > 0);
  assert.ok(!Number.isNaN(Date.parse(entry.candleTs)));
});

test("an intent built without candles carries a null regime rather than a guess", () => {
  // intentsFor() is given the closed candles by the scanner; a caller that has
  // none must not produce a fabricated environment tag.
  const [, entry] = intentsFrom(candleRows(UP));
  assert.equal(entry.regime, null);
  assert.equal(entry.regimeConfidence, null);
});

test("no scanner intent carries a sizing, level or scoring field", () => {
  for (const rows of [candleRows(UP), candleRows(DOWN)]) {
    for (const intent of intentsFrom(rows)) {
      for (const field of RISK_FIELDS) {
        assert.ok(!(field in intent), `intent leaked "${field}"`);
        assert.ok(!(field in (intent.indicators || {})), `indicators leaked "${field}"`);
      }
    }
  }
});

test("indicators are whitelisted observations, so a risk field cannot ride along", () => {
  const intent = buildTradeIntent({
    signal: "LONG", symbol: "BTCUSDT.P", price: 100, tf: "15m", strategy: "mindset_v1",
    candleTs: new Date().toISOString(),
    indicators: { rsi: 60, atr: 5, somethingNew: 1 },
  });
  // atr is a volatility *measurement* and is allowed; unknown keys are dropped.
  assert.equal(intent.indicators.atr, 5);
  assert.equal(intent.indicators.rsi, 60);
  assert.ok(!("somethingNew" in intent.indicators));
});

test("building an intent with a risk field throws rather than passing it on", () => {
  const base = {
    signal: "LONG", symbol: "BTCUSDT.P", price: 100, tf: "15m",
    strategy: "mindset_v1", candleTs: new Date().toISOString(),
  };
  assert.throws(() => buildTradeIntent({ ...base, stopLoss: 95 }), /may not carry "stopLoss"/);
  assert.throws(() => buildTradeIntent({ ...base, size: 2 }), /may not carry "size"/);
  assert.throws(() => buildTradeIntent({ ...base, confidenceScore: 80 }), /may not carry "confidenceScore"/);
  assert.throws(() => buildTradeIntent({ ...base, indicators: { riskUsd: 100 } }), /may not carry "riskUsd"/);
});

test("an intent is frozen, so nothing downstream can bolt a level onto it", () => {
  const [intent] = intentsFrom(candleRows(UP));
  assert.throws(() => {
    "use strict";
    intent.stopLoss = 1;
  }, TypeError);
});

test("an intent is rejected without a valid signal, price or candle timestamp", () => {
  const base = { symbol: "BTCUSDT.P", price: 100, tf: "15m", strategy: "s", candleTs: "t" };
  assert.throws(() => buildTradeIntent({ ...base, signal: "MAYBE" }), /Unknown intent signal/);
  assert.throws(() => buildTradeIntent({ ...base, signal: "LONG", price: 0 }), /positive price/);
  assert.throws(() => buildTradeIntent({ ...base, signal: "LONG", candleTs: "" }), /candle timestamp/);
});

// ── Rule 6: entries flow through checklist -> edge -> plan -> execute ───────

test("an entry intent passes through checklist, edge gate and risk sizing", async () => {
  const lab = makeLab();
  const calls = [];
  const realEvaluate = lab.evaluate.bind(lab);
  lab.evaluate = (input) => {
    calls.push(input);
    return realEvaluate(input);
  };

  const { scanner } = makeScanner({ rows: candleRows(UP), lab });
  const result = await scanner.runOnce();

  assert.equal(result.status, "opened");
  assert.equal(calls.length, 1);

  // The scanner supplied observations only — no levels, size or score.
  const input = calls[0];
  assert.equal(input.direction, "LONG");
  assert.ok(input.entryPrice > 0);
  assert.ok(input.atr > 0, "ATR is passed as a volatility measurement");
  for (const field of ["stopLoss", "tp1", "tp2", "size", "riskUsd", "sizeMultiplier", "confidenceScore"]) {
    assert.ok(!(field in input), `scanner supplied "${field}" to the lab`);
  }

  // Every gate produced its own verdict, and the position's levels came from
  // the risk engine rather than the strategy.
  const position = scannerLedger(lab).getOpenPositions()[0];
  assert.ok(position.confidenceScore > 0);
  assert.ok(position.stopLoss > 0 && position.tp1 > 0 && position.tp2 > 0);
  assert.ok(position.size > 0 && position.riskUsd > 0);
  assert.equal(position.meta.edgeDecision !== undefined, true);
});

test("an entry the checklist skips opens nothing", async () => {
  // A breached daily-loss kill switch makes runChecklist return SKIP before any
  // score is computed, so nothing can be opened however good the setup looks.
  const lab = makeLab();
  const trader = scannerLedger(lab);
  const account = trader.getAccount();
  account.dailyPnl = -account.startingBalance; // far past DAILY_LOSS_LIMIT_PCT
  trader.save(trader.accountFile, account);

  const { scanner } = makeScanner({ rows: candleRows(UP), lab });
  const result = await scanner.runOnce();

  assert.equal(result.status, "blocked");
  assert.equal(trader.getOpenPositions().length, 0);
  assert.match(result.action.reason, /Checklist skipped the setup/);
});

// ── Rule 7: exits bypass the gates ─────────────────────────────────────────

test("an exit closes the position even with every entry gate slammed shut", async () => {
  const lab = makeLab();
  const { scanner } = makeScanner({ rows: candleRows(UP), lab });
  assert.equal((await scanner.runOnce()).status, "opened");

  const trader = scannerLedger(lab);
  assert.equal(trader.getOpenPositions().length, 1);

  // Breach the daily loss limit *after* the position is open. The checklist
  // would now refuse any entry, and the edge gate has a losing history to
  // judge. An exit must not be answerable to either.
  const account = trader.getAccount();
  account.dailyPnl = -account.startingBalance;
  trader.save(trader.accountFile, account);

  // Confirm the entry path really is closed at this point.
  const blockedEntry = lab.evaluate({ symbol: "BTCUSDT.P", direction: "LONG", entryPrice: 100, atr: 1 });
  assert.equal(blockedEntry.decision, "SKIP");

  scanner._fetch = async () => ({ ok: true, status: 200, json: async () => payload(candleRows(DOWN)) });
  const result = await scanner.runOnce();

  assert.equal(result.status, "exited");
  assert.equal(trader.getOpenPositions().length, 0);
  const history = trader.getHistory();
  assert.equal(history[history.length - 1].closeReason, "SCANNER_EXIT");
});

test("the handler never consults checklist or edge gate for an exit", async () => {
  const lab = makeLab();
  const { scanner } = makeScanner({ rows: candleRows(UP), lab });
  await scanner.runOnce();
  assert.equal(scannerLedger(lab).getOpenPositions().length, 1);

  // Any gate consultation would go through evaluate(); an exit must not.
  lab.evaluate = () => {
    throw new Error("exit consulted the entry gates");
  };

  const handler = new TradeIntentHandler({ tradingLabService: lab, logger: QUIET });
  const outcome = await handler.handle(
    buildTradeIntent({
      signal: "EXIT_LONG", symbol: "BTCUSDT.P", price: 150, tf: "15m",
      strategy: "mindset_v1", candleTs: new Date().toISOString(),
    }),
  );

  assert.equal(outcome.status, "exited");
  assert.equal(scannerLedger(lab).getOpenPositions().length, 0);
});

test("an exit closes only the side whose thesis broke", async () => {
  const lab = makeLab();
  const trader = scannerLedger(lab);
  trader.openPosition({
    symbol: "BTCUSDT.P", direction: "LONG", size: 1, entryPrice: 100,
    stopLoss: 95, tp1: 110, tp2: 120, riskUsd: 100,
  });
  trader.openPosition({
    symbol: "ETHUSDT.P", direction: "SHORT", size: 1, entryPrice: 100,
    stopLoss: 105, tp1: 90, tp2: 80, riskUsd: 100,
  });

  const handler = new TradeIntentHandler({ tradingLabService: lab, logger: QUIET });
  const outcome = await handler.handle(
    buildTradeIntent({
      signal: "EXIT_SHORT", symbol: "BTCUSDT.P", price: 105, tf: "15m",
      strategy: "mindset_v1", candleTs: new Date().toISOString(),
    }),
  );

  // No SHORT on BTCUSDT.P — the LONG on it and the SHORT on ETHUSDT.P both stay.
  assert.equal(outcome.status, "noop");
  assert.equal(trader.getOpenPositions().length, 2);
});

test("an exit for a symbol with nothing open is a quiet no-op", async () => {
  const lab = makeLab();
  const handler = new TradeIntentHandler({ tradingLabService: lab, logger: QUIET });
  const outcome = await handler.handle(
    buildTradeIntent({
      signal: "EXIT_LONG", symbol: "BTCUSDT.P", price: 100, tf: "15m",
      strategy: "mindset_v1", candleTs: new Date().toISOString(),
    }),
  );
  assert.equal(outcome.status, "noop");
});

test("an executed exit is not masked by the entry evaluated after it", async () => {
  // One bar can emit EXIT_LONG then SHORT. The cycle must report the exit.
  const lab = makeLab();
  const { scanner } = makeScanner({ rows: candleRows(UP), lab });
  await scanner.runOnce();

  scanner._fetch = async () => ({ ok: true, status: 200, json: async () => payload(candleRows(DOWN)) });
  const result = await scanner.runOnce();

  assert.equal(result.status, "exited");
  assert.ok(result.actions.some((a) => a.direction === "EXIT_LONG" && a.status === "exited"));
});

// ── Rule 8/9: Bitget behaviour unchanged ────────────────────────────────────

test("Bitget granularity casing: minutes lowercase, hours and days uppercase", () => {
  assert.equal(TIMEFRAMES["1m"].granularity, "1m");
  assert.equal(TIMEFRAMES["5m"].granularity, "5m");
  assert.equal(TIMEFRAMES["15m"].granularity, "15m");
  assert.equal(TIMEFRAMES["30m"].granularity, "30m");
  assert.equal(TIMEFRAMES["1h"].granularity, "1H");
  assert.equal(TIMEFRAMES["4h"].granularity, "4H");
  assert.equal(TIMEFRAMES["1d"].granularity, "1D");
  // Input casing is normalised, output casing is not.
  assert.equal(resolveTimeframe("15M").granularity, "15m");
  assert.equal(resolveTimeframe("1H").granularity, "1H");
});

test("the 15m default still requests the same Bitget URL", async () => {
  let requested = null;
  const { scanner } = makeScanner({
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, status: 200, json: async () => payload(candleRows(UP)) };
    },
  });
  await scanner.runOnce();

  assert.match(requested, /^https:\/\/api\.bitget\.com\/api\/v2\/mix\/market\/candles\?/);
  assert.match(requested, /symbol=BTCUSDT&/);
  assert.match(requested, /productType=USDT-FUTURES/);
  assert.match(requested, /granularity=15m/);
});
