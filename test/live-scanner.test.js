"use strict";

// Live scanner: candle parsing, strategy signals, and the safety properties
// that matter most for an unattended loop — closed candles only, one entry per
// candle, one position per symbol, and a graceful degrade when Bitget is down.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LiveScannerService,
  parseBitgetCandles,
  evaluateMindsetV1,
  atrSeries,
  resolveSymbol,
  resolveTimeframe,
} = require("../src/services/trading/live-scanner");
const { TradingLabService } = require("../src/services/trading/trading-lab");
const { makeTradingConfig } = require("../src/services/trading/config");
const { atr } = require("../src/services/decision-engine");

const QUIET = { log() {}, warn() {}, error() {} };
const TF_MS = 900_000; // 15m

// ── Fixtures ────────────────────────────────────────────────────────────────

// Bitget rows, oldest first, with the *last* row being the still-forming
// candle (its open time is the current bar). Values are strings, as the API
// returns them.
function candleRows(priceFn, { count = 200, ms = TF_MS, formingClose = null } = {}) {
  const formingOpenTime = Math.floor(Date.now() / ms) * ms;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const openTime = formingOpenTime - (count - 1 - i) * ms;
    const isForming = i === count - 1;
    const close = isForming && formingClose != null ? formingClose : priceFn(i);
    const open = priceFn(Math.max(0, i - 1));
    rows.push([
      String(openTime),
      String(open),
      String(Math.max(open, close) + 1),
      String(Math.min(open, close) - 1),
      String(close),
      String(100 + (i % 5) * 20),
      "0",
    ]);
  }
  return rows;
}

function payload(rows) {
  return { code: "00000", msg: "success", requestTime: Date.now(), data: rows };
}

// Gentle uptrend with pullbacks: EMA20 > EMA50 while RSI stays inside the
// 50-75 long band. A pure ramp would pin RSI at 100 and be rejected.
const UP = (i) => 100 + i * 0.5 + 3 * Math.sin(i / 2);
const DOWN = (i) => 200 - i * 0.5 - 3 * Math.sin(i / 2);
const RAMP = (i) => 100 + i * 0.5;

function memoryCache() {
  const map = new Map();
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => map.set(k, v),
  };
}

// A bullish decision-engine reading, which is what production has behind the
// scanner. These tests are about scanner MECHANICS — claiming a candle,
// surviving a restart, not stacking positions — so the lab needs a market
// state that actually scores, not the empty one a missing engine produces.
//
// That empty state used to score a long at 57 and open positions anyway,
// because the checklist's macro defaults read as favourable observations. Now
// an absent feed scores as absent, so a scanner with no decision engine
// correctly refuses to trade — see the dedicated test for that below.
const BULLISH_DECISION = {
  regime: { score: 70, label: "Trending", modifiers: [] },
  newsRisk: { level: "low" },
};

function makeLab(configOverrides = {}, { decision = BULLISH_DECISION } = {}) {
  return new TradingLabService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-scanner-")),
    config: makeTradingConfig(configOverrides),
    priceFeed: null,
    decisionEngineService: decision ? { getDecision: async () => decision } : null,
  });
}

function makeScanner({ rows = candleRows(UP), fetchImpl, lab = makeLab(), ...options } = {}) {
  const calls = { count: 0 };
  const scanner = new LiveScannerService({
    tradingLabService: lab,
    stateCache: memoryCache(),
    enabled: true,
    logger: QUIET,
    fetchImpl:
      fetchImpl ||
      (async () => {
        calls.count += 1;
        return { ok: true, status: 200, json: async () => payload(rows) };
      }),
    ...options,
  });
  return { scanner, lab, calls };
}

// ── Candle parsing ──────────────────────────────────────────────────────────

test("parses a Bitget v2 payload into candles and derives close times", () => {
  const rows = [["1700000000000", "100.5", "102", "99", "101", "12.5", "1200"]];
  const [candle] = parseBitgetCandles(payload(rows), "15m");

  assert.deepEqual(candle, {
    openTime: 1700000000000,
    open: 100.5,
    high: 102,
    low: 99,
    close: 101,
    volume: 12.5,
    // Last millisecond inside the bar, matching the Binance convention the
    // shared dropUnclosedCandle() helper assumes.
    closeTime: 1700000000000 + TF_MS - 1,
  });
});

test("candle close time follows the configured timeframe", () => {
  const rows = [["1700000000000", "1", "1", "1", "1", "1", "1"]];
  assert.equal(parseBitgetCandles(payload(rows), "1h")[0].closeTime, 1700000000000 + 3_600_000 - 1);
  assert.equal(parseBitgetCandles(payload(rows), "1d")[0].closeTime, 1700000000000 + 86_400_000 - 1);
});

test("parsing sorts candles oldest-first and drops malformed rows", () => {
  const rows = [
    ["1700000900000", "2", "2", "2", "2", "1", "0"],
    ["1700000000000", "1", "1", "1", "1", "1", "0"],
    ["1700001800000", "x", "3", "3", "3", "1", "0"], // non-numeric price
    ["1700002700000", "4", "4"], // truncated
    "not-a-row",
  ];
  const candles = parseBitgetCandles(payload(rows), "15m");
  assert.deepEqual(candles.map((c) => c.openTime), [1700000000000, 1700000900000]);
});

test("parsing accepts a bare array and defaults a missing volume to zero", () => {
  const candles = parseBitgetCandles([["1700000000000", "1", "1", "1", "1"]], "15m");
  assert.equal(candles.length, 1);
  assert.equal(candles[0].volume, 0);
});

test("parsing surfaces a Bitget error code instead of returning empty candles", () => {
  assert.throws(
    () => parseBitgetCandles({ code: "40034", msg: "Parameter does not exist" }, "15m"),
    /Bitget error 40034: Parameter does not exist/,
  );
});

test("parsing rejects a payload with no candle data", () => {
  assert.throws(() => parseBitgetCandles({ code: "00000" }, "15m"), /no candle data/);
});

test("an unsupported timeframe is rejected rather than silently guessed", () => {
  assert.throws(() => resolveTimeframe("7m"), /Unsupported timeframe "7m"/);
  assert.equal(resolveTimeframe("15M").granularity, "15m");
  assert.equal(resolveTimeframe("1h").granularity, "1H");
});

test("a .P perpetual symbol maps to the Bitget contract but keeps its ledger name", () => {
  assert.deepEqual(resolveSymbol("btcusdt.p"), {
    display: "BTCUSDT.P",
    bitgetSymbol: "BTCUSDT",
    productType: "USDT-FUTURES",
  });
});

// ── Indicators / strategy ───────────────────────────────────────────────────

test("the ATR series agrees with the shared decision-engine ATR", () => {
  const candles = parseBitgetCandles(payload(candleRows(UP)), "15m");
  const series = atrSeries(candles, 14);
  assert.ok(Math.abs(series[series.length - 1] - atr(candles, 14)) < 1e-9);
});

test("mindset_v1 goes LONG on an EMA uptrend with RSI in band", () => {
  const candles = parseBitgetCandles(payload(candleRows(UP)), "15m");
  const result = evaluateMindsetV1(candles);
  assert.equal(result.signal, "LONG");
  assert.equal(result.indicators.trend, "UP");
  assert.ok(result.indicators.ema20 > result.indicators.ema50);
  assert.ok(result.indicators.rsi > 50 && result.indicators.rsi < 75);
});

test("mindset_v1 goes SHORT on an EMA downtrend with RSI in band", () => {
  const candles = parseBitgetCandles(payload(candleRows(DOWN)), "15m");
  const result = evaluateMindsetV1(candles);
  assert.equal(result.signal, "SHORT");
  assert.equal(result.indicators.trend, "DOWN");
  assert.ok(result.indicators.ema20 < result.indicators.ema50);
});

test("mindset_v1 refuses to chase: an overbought ramp is FLAT despite the uptrend", () => {
  const candles = parseBitgetCandles(payload(candleRows(RAMP)), "15m");
  const result = evaluateMindsetV1(candles);
  assert.equal(result.indicators.trend, "UP");
  assert.ok(result.indicators.rsi >= 75);
  assert.equal(result.signal, "FLAT");
});

test("mindset_v1 reports insufficient history instead of signalling on noise", () => {
  const candles = parseBitgetCandles(payload(candleRows(UP, { count: 30 })), "15m");
  const result = evaluateMindsetV1(candles);
  assert.equal(result.signal, "FLAT");
  assert.match(result.error, /Need at least 50 closed candles/);
  assert.equal(result.indicators, null);
});

// ── Closed candles only ─────────────────────────────────────────────────────

test("the still-forming candle is never traded", async () => {
  // The forming bar carries an absurd price. If it were evaluated it would
  // both set the entry price and blow up the indicators.
  const rows = candleRows(UP, { formingClose: 999_999 });
  const { scanner } = makeScanner({ rows });

  const result = await scanner.runOnce();

  assert.equal(result.status, "opened");
  const lastClosedClose = Number(rows[rows.length - 2][4]);
  assert.equal(result.action.entryPrice, lastClosedClose);
  assert.notEqual(result.action.entryPrice, 999_999);
  assert.equal(scanner.status().lastCandle.close, lastClosedClose);
});

test("a scan with no closed candles does nothing", async () => {
  const ms = TF_MS;
  const formingOpenTime = Math.floor(Date.now() / ms) * ms;
  const rows = [[String(formingOpenTime), "100", "101", "99", "100", "10", "0"]];
  const { scanner } = makeScanner({ rows });

  assert.equal((await scanner.runOnce()).status, "no-candles");
});

// ── Signal generation into the Trading Lab ──────────────────────────────────

test("a LONG signal opens exactly one paper position through the Trading Lab", async () => {
  const { scanner, lab } = makeScanner({ rows: candleRows(UP) });

  const result = await scanner.runOnce();

  assert.equal(result.status, "opened");
  const open = lab.book("main").getOpenPositions();
  assert.equal(open.length, 1);
  assert.equal(open[0].symbol, "BTCUSDT.P");
  assert.equal(open[0].direction, "LONG");
  assert.equal(open[0].signalSource, "live-scanner:15m");
  // Sizing and levels come from the shared risk engine, not from the scanner.
  assert.ok(open[0].stopLoss < open[0].entryPrice);
  assert.ok(open[0].tp1 > open[0].entryPrice);
  assert.ok(open[0].size > 0);
  // The confidence score is the checklist's, mapped through the edge gate.
  assert.ok(result.action.confidenceScore > 0);
  assert.ok(result.action.sizeMultiplier > 0);
});

test("a FLAT reading opens nothing", async () => {
  const { scanner, lab } = makeScanner({ rows: candleRows(RAMP) });

  assert.equal((await scanner.runOnce()).status, "flat");
  assert.equal(lab.book("main").getOpenPositions().length, 0);
});

// ── Duplicate prevention ────────────────────────────────────────────────────

test("re-scanning the same candle does not open a second position", async () => {
  const rows = candleRows(UP);
  const { scanner, lab } = makeScanner({ rows });

  const first = await scanner.runOnce();
  const second = await scanner.runOnce();
  const third = await scanner.runOnce();

  assert.equal(first.status, "opened");
  // The 60s loop re-reads the same closed bar until the next one closes.
  assert.equal(second.status, "already-evaluated");
  assert.equal(third.status, "already-evaluated");
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

test("the candle claim survives a restart", async () => {
  const rows = candleRows(UP);
  const stateCache = memoryCache();
  const lab = makeLab();

  const { scanner: first } = makeScanner({ rows, lab, stateCache });
  assert.equal((await first.runOnce()).status, "opened");

  // Close the position so the one-per-symbol rule cannot be what blocks the
  // second entry — the persisted candle claim has to be doing the work.
  const trader = lab.book("main");
  await trader.closePosition(trader.getOpenPositions()[0].id, { reason: "MANUAL", exitPrice: 500 });
  assert.equal(trader.getOpenPositions().length, 0);

  // A fresh process, same persisted state, same still-current candle.
  const { scanner: restarted } = makeScanner({ rows, lab, stateCache });
  const result = await restarted.runOnce();

  assert.equal(result.status, "already-evaluated");
  assert.equal(trader.getOpenPositions().length, 0);
});

test("a new candle with a position already open is skipped, not stacked", async () => {
  // Dropping the last two rows rewinds the feed by one bar: the first scan's
  // newest closed candle is the one *before* the second scan's, so the second
  // scan sees a genuinely new candle rather than re-reading the old one.
  const rows = candleRows(UP, { count: 202 });
  const { scanner, lab } = makeScanner({ rows: rows.slice(0, -2) });
  const first = await scanner.runOnce();
  assert.equal(first.status, "opened");

  scanner._fetch = async () => ({ ok: true, status: 200, json: async () => payload(rows) });

  const result = await scanner.runOnce();
  assert.ok(result.action.candleTs > first.action.candleTs, "expected a newer candle");

  assert.equal(result.status, "skipped");
  assert.match(result.action.reason, /Position already open on BTCUSDT\.P/);
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

test("concurrent scans cannot both act on the same candle", async () => {
  const { scanner, lab } = makeScanner({ rows: candleRows(UP) });

  const [a, b] = await Promise.all([scanner.runOnce(), scanner.runOnce()]);

  assert.ok([a.status, b.status].includes("busy"));
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

// ── Dry run / disabled ──────────────────────────────────────────────────────

test("ENABLE_LIVE_SCANNER defaults to disabled", () => {
  delete require.cache[require.resolve("../src/config/env")];
  const previous = process.env.ENABLE_LIVE_SCANNER;
  delete process.env.ENABLE_LIVE_SCANNER;
  try {
    const { config } = require("../src/config/env");
    assert.equal(config.liveScanner.enabled, false);
    assert.equal(config.liveScanner.symbol, "BTCUSDT.P");
    assert.equal(config.liveScanner.timeframe, "15m");
    assert.equal(config.liveScanner.strategy, "mindset_v1");
  } finally {
    if (previous !== undefined) process.env.ENABLE_LIVE_SCANNER = previous;
    delete require.cache[require.resolve("../src/config/env")];
  }
});

test("only the exact string \"true\" enables the scanner", () => {
  const previous = process.env.ENABLE_LIVE_SCANNER;
  try {
    for (const [value, expected] of [["true", true], ["TRUE", false], ["1", false], ["yes", false]]) {
      delete require.cache[require.resolve("../src/config/env")];
      process.env.ENABLE_LIVE_SCANNER = value;
      const { config } = require("../src/config/env");
      assert.equal(config.liveScanner.enabled, expected, `ENABLE_LIVE_SCANNER=${value}`);
    }
  } finally {
    if (previous === undefined) delete process.env.ENABLE_LIVE_SCANNER;
    else process.env.ENABLE_LIVE_SCANNER = previous;
    delete require.cache[require.resolve("../src/config/env")];
  }
});

test("a disabled scanner never starts a loop and never calls the exchange", async () => {
  const { scanner, calls } = makeScanner({ enabled: false });

  assert.equal(scanner.start(), false);
  assert.equal(scanner.status().enabled, false);
  assert.equal(scanner.status().running, false);
  assert.equal(calls.count, 0);
  scanner.stop();
});

test("paper trading off scores the signal but opens nothing", async () => {
  const { scanner, lab } = makeScanner({ rows: candleRows(UP), paperTradeEnabled: false });

  const result = await scanner.runOnce();

  assert.equal(result.status, "dry-run");
  assert.equal(lab.book("main").getOpenPositions().length, 0);
  // The decision trail still exists even though nothing was opened.
  assert.ok(result.action.confidenceScore > 0);
  assert.equal(result.action.reason, "Would open (paper trading disabled)");
});

// ── Failure handling ────────────────────────────────────────────────────────

test("an unreachable exchange is recorded, not thrown", async () => {
  const { scanner } = makeScanner({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.bitget.com");
    },
  });

  const result = await scanner.runOnce();

  assert.equal(result.status, "error");
  const status = scanner.status();
  assert.match(status.lastError, /ENOTFOUND/);
  assert.equal(status.errorCount, 1);
  assert.ok(status.lastErrorAt);
});

test("an HTTP error from Bitget is recorded, not thrown", async () => {
  const { scanner } = makeScanner({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });

  assert.equal((await scanner.runOnce()).status, "error");
  assert.match(scanner.status().lastError, /HTTP 503/);
});

test("the scanner recovers on the next tick after an outage", async () => {
  const rows = candleRows(UP);
  let fail = true;
  const { scanner, lab } = makeScanner({
    fetchImpl: async () => {
      if (fail) throw new Error("Bitget down");
      return { ok: true, status: 200, json: async () => payload(rows) };
    },
  });

  assert.equal((await scanner.runOnce()).status, "error");
  fail = false;
  assert.equal((await scanner.runOnce()).status, "opened");
  assert.equal(scanner.status().lastError, null);
  assert.equal(lab.book("main").getOpenPositions().length, 1);
});

test("a bad timeframe fails at construction rather than at the first scan", () => {
  assert.throws(() => makeScanner({ timeframe: "13m" }), /Unsupported timeframe/);
  assert.throws(() => makeScanner({ strategy: "smc_v9" }), /Unknown strategy "smc_v9"/);
});

// ── Exits ───────────────────────────────────────────────────────────────────

test("a trend flip against an open position closes it", async () => {
  const lab = makeLab();
  const { scanner } = makeScanner({ rows: candleRows(UP), lab });
  assert.equal((await scanner.runOnce()).status, "opened");
  assert.equal(lab.book("main").getOpenPositions().length, 1);

  // Same symbol, now in a downtrend.
  scanner._fetch = async () => ({ ok: true, status: 200, json: async () => payload(candleRows(DOWN)) });

  const result = await scanner.runOnce();

  assert.equal(result.status, "exited");
  assert.equal(result.action.direction, "EXIT_LONG");
  assert.equal(lab.book("main").getOpenPositions().length, 0);
  const history = lab.book("main").getHistory();
  assert.equal(history[history.length - 1].closeReason, "SCANNER_EXIT");
});

// ── Status reporting ────────────────────────────────────────────────────────

test("status reports the fields the dashboard renders", async () => {
  const { scanner } = makeScanner({ rows: candleRows(UP) });
  await scanner.runOnce();

  const status = scanner.status();
  assert.equal(status.enabled, true);
  assert.equal(status.mode, "paper");
  assert.equal(status.symbol, "BTCUSDT.P");
  assert.equal(status.exchange, "bitget");
  assert.equal(status.timeframe, "15m");
  assert.equal(status.strategy, "mindset_v1");
  assert.equal(status.intervalMs, 60_000);
  assert.equal(status.scanCount, 1);
  assert.ok(status.lastScanAt);
  assert.equal(status.lastSignal.signal, "LONG");
  assert.ok(status.lastCandle.closeTime < Date.now());
  assert.equal(status.lastAction.status, "opened");
  assert.equal(status.lastError, null);
});
