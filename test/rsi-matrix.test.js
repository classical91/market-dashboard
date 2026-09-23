"use strict";

// The RSI Matrix engine: RSI parity with the screener, closed-bar semantics,
// the AVG rule, per-cell failure isolation, caching, and provider parsing.
// No test here touches the network — every provider gets a fake fetch.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { rsi, INTERVAL_MAP } = require("../src/services/signal-screener");
const { MemoryCache } = require("../src/services/cache");
const {
  RsiMatrixService,
  classifyRsi,
  classifyAverage,
  averageOf,
  rsiFromCandles,
} = require("../src/services/rsi-matrix/service");
const {
  TIMEFRAMES,
  TIMEFRAME_MS,
  aggregateCandles,
  bucketStart,
  candlesFromPoints,
  contiguousTail,
  ttlUntilNextClose,
} = require("../src/services/rsi-matrix/candles");
const { normalizeProviderSymbol, createVerifier } = require("../src/services/rsi-matrix/providers");
const { BinanceSpotProvider } = require("../src/services/rsi-matrix/providers/binance");
const {
  MexcProvider,
  KucoinProvider,
  CoinbaseProvider,
  KrakenProvider,
  PoloniexProvider,
} = require("../src/services/rsi-matrix/providers/exchanges");
const { YahooChartProvider } = require("../src/services/rsi-matrix/providers/yahoo");
const { DominanceHistoryProvider } = require("../src/services/rsi-matrix/providers/dominance");
const { DEFAULT_INSTRUMENTS } = require("../src/services/rsi-matrix/registry");

const HOUR = 60 * 60 * 1000;
// A fixed "now" on an hour boundary + 30 minutes, so closed/unclosed is exact.
const NOW = Date.UTC(2026, 8, 23, 12, 30);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsi-matrix-"));
}

// Deterministic, wiggly closes so RSI lands mid-range rather than at 0/100.
function closesSeries(n, seed = 1) {
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i * 0.7 + seed) * 2 + Math.cos(i * 0.31 + seed) * 1.3;
    out.push(Number(price.toFixed(4)));
  }
  return out;
}

// Hourly candles ending with a still-open bar at NOW.
function hourlyCandles(n, { seed = 1, tf = "1h" } = {}) {
  const ms = TIMEFRAME_MS[tf];
  const closes = closesSeries(n, seed);
  const lastOpen = bucketStart(NOW, tf);
  return closes.map((close, i) => {
    const openTime = lastOpen - (n - 1 - i) * ms;
    return { openTime, closeTime: openTime + ms - 1, open: close, high: close + 1, low: close - 1, close, volume: 1 };
  });
}

function fakeSettings(instruments, timeframes = TIMEFRAMES) {
  return {
    snapshot() {
      return {
        groups: [
          { id: "cross-market", label: "Cross-Market" },
          { id: "crypto-stables", label: "Crypto / Dominance / Stablecoins" },
        ],
        timeframes: TIMEFRAMES.map((key) => ({ key, enabled: timeframes.includes(key) })),
        instruments: instruments.map((row) => ({ enabled: true, group: "cross-market", ...row })),
      };
    },
  };
}

function fakeProvider(impl) {
  const calls = [];
  return {
    calls,
    async fetchCandles(symbol, tf) {
      calls.push(`${symbol}:${tf}`);
      return impl(symbol, tf);
    },
  };
}

function jsonFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) {
        const payload = typeof body === "function" ? body(url) : body;
        const status = payload && payload.__status ? payload.__status : 200;
        return { ok: status < 400, status, json: async () => payload };
      }
    }
    return { ok: false, status: 404, json: async () => ({ msg: "not found" }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ── RSI parity and closed bars ──────────────────────────────────────────

test("RSI is the signal screener's own rsi(), last value, on closed bars only", () => {
  const candles = hourlyCandles(120);
  const result = rsiFromCandles(candles, { tf: "1h", now: NOW });
  const closed = candles.slice(0, -1).map((c) => c.close);
  const expected = rsi(closed, 14)[closed.length - 1];
  assert.equal(result.value, Math.round(expected * 100) / 100);
  assert.equal(result.bars, 119);
});

test("the last unfinished candle is excluded, so a live bar never moves the value", () => {
  const candles = hourlyCandles(80);
  const before = rsiFromCandles(candles, { tf: "1h", now: NOW }).value;
  const spiked = candles.map((c, i) => (i === candles.length - 1 ? { ...c, close: c.close * 3 } : c));
  assert.equal(rsiFromCandles(spiked, { tf: "1h", now: NOW }).value, before);
});

test("too little history is a reason, never RSI 0", () => {
  const result = rsiFromCandles(hourlyCandles(10), { tf: "4h", now: NOW });
  assert.equal(result.value, null);
  assert.match(result.error, /Only 9 closed 4H bars — RSI 14 needs 15/);
  assert.equal(rsiFromCandles([], { tf: "1h", now: NOW }).value, null);
});

test("timeframe keys map straight onto Binance intervals", () => {
  assert.deepEqual(TIMEFRAMES, ["1W", "1D", "4h", "1h"]);
  assert.equal(INTERVAL_MAP["1W"], "1w");
  assert.equal(INTERVAL_MAP["1D"], "1d");
  assert.equal(INTERVAL_MAP["4h"], "4h");
  assert.equal(INTERVAL_MAP["1h"], "1h");
});

// ── Thresholds and AVG ──────────────────────────────────────────────────

test("cell bands follow the reference indicator's thresholds", () => {
  assert.equal(classifyRsi(80), "strong-bullish");
  assert.equal(classifyRsi(75), "strong-bullish");
  assert.equal(classifyRsi(74.99), "bullish");
  assert.equal(classifyRsi(65), "bullish");
  assert.equal(classifyRsi(64.99), "weak-bullish");
  assert.equal(classifyRsi(55), "weak-bullish");
  assert.equal(classifyRsi(50), "neutral");
  assert.equal(classifyRsi(45), "neutral");
  assert.equal(classifyRsi(44.99), "weak-bearish");
  assert.equal(classifyRsi(35), "weak-bearish");
  assert.equal(classifyRsi(30), "bearish");
  assert.equal(classifyRsi(25), "strong-bearish");
  assert.equal(classifyRsi(10), "strong-bearish");
  assert.equal(classifyRsi(null), null);
});

test("AVG is the mean of every enabled timeframe, and missing ones are never zero", () => {
  const tfs = ["1W", "1D", "4h", "1h"];
  assert.deepEqual(averageOf({ "1W": 60, "1D": 55, "4h": 50, "1h": 35 }, tfs), { average: 50, available: 4, required: 4 });
  // 60, 55, null, 40: not (60+55+0+40)/4, and not silently (60+55+40)/3 —
  // a missing timeframe leaves the multi-timeframe average unreported.
  assert.deepEqual(averageOf({ "1W": 60, "1D": 55, "4h": null, "1h": 40 }, tfs), { average: null, available: 3, required: 4 });
  // Disabling a timeframe in Settings changes what "every" means.
  assert.deepEqual(averageOf({ "1W": 60, "1D": 55, "1h": 40 }, ["1W", "1D", "1h"]).average, 51.67);
});

test("the AVG row flags MTF extremes at 70 / 30", () => {
  assert.equal(classifyAverage(70), "mtf-overbought");
  assert.equal(classifyAverage(69.99), "normal");
  assert.equal(classifyAverage(30), "mtf-oversold");
  assert.equal(classifyAverage(null), null);
});

// ── Service behaviour ───────────────────────────────────────────────────

test("one failed provider/timeframe never fails the matrix", async () => {
  const binance = fakeProvider(() => hourlyCandles(60));
  const yahoo = fakeProvider((symbol, tf) => {
    if (tf === "1h") throw Object.assign(new Error("Yahoo Finance HTTP 429"), { scope: "venue" });
    return hourlyCandles(60, { tf });
  });
  const service = new RsiMatrixService({
    settingsService: fakeSettings([
      { id: "btc", label: "BTCUSD", provider: "binance", providerSymbol: "BTCUSDT" },
      { id: "gold", label: "GOLD", provider: "yahoo", providerSymbol: "GC=F" },
    ]),
    providers: { binance, yahoo },
    cache: new MemoryCache(),
    now: () => NOW,
  });
  const matrix = await service.getMatrix();
  const btc = matrix.instruments.find((r) => r.id === "btc");
  const gold = matrix.instruments.find((r) => r.id === "gold");
  for (const tf of TIMEFRAMES) assert.equal(typeof btc.values[tf], "number", `BTC ${tf}`);
  assert.equal(gold.values["1h"], null);
  assert.match(gold.errors["1h"], /429/);
  assert.equal(typeof gold.values["4h"], "number");
  assert.equal(gold.average, null);
  assert.equal(gold.averageAvailable, 3);
  assert.equal(gold.error, null, "a partly failing row is not a dead row");
  assert.equal(typeof btc.average, "number");
});

test("an unknown provider is a per-row error, not a crash", async () => {
  const service = new RsiMatrixService({
    settingsService: fakeSettings([{ id: "x", label: "X", provider: "nowhere", providerSymbol: "X" }]),
    providers: {},
    cache: new MemoryCache(),
    now: () => NOW,
  });
  const matrix = await service.getMatrix();
  assert.match(matrix.instruments[0].error, /Data unavailable/);
  for (const tf of TIMEFRAMES) assert.equal(matrix.instruments[0].values[tf], null);
});

test("candles are cached by provider + symbol + timeframe, shared across rows and callers", async () => {
  const binance = fakeProvider((symbol, tf) => hourlyCandles(60, { tf }));
  const service = new RsiMatrixService({
    settingsService: fakeSettings([
      { id: "btc-a", label: "BTCUSD", provider: "binance", providerSymbol: "BTCUSDT" },
      { id: "btc-b", label: "BTCUSD", group: "crypto-stables", provider: "binance", providerSymbol: "BTCUSDT" },
    ]),
    providers: { binance },
    cache: new MemoryCache(),
    now: () => NOW,
  });
  await Promise.all([service.getMatrix(), service.getMatrix()]);
  await service.getMatrix();
  assert.equal(binance.calls.length, 4, "one upstream call per timeframe, however many rows and requests");
});

test("failures are cached briefly so a dead venue can't be hammered", async () => {
  const kraken = fakeProvider(() => {
    throw Object.assign(new Error("Kraken: EService:Unavailable"), { scope: "venue" });
  });
  const service = new RsiMatrixService({
    settingsService: fakeSettings([{ id: "p", label: "PYUSDEUR", provider: "kraken", providerSymbol: "PYUSDEUR" }], ["1D"]),
    providers: { kraken },
    cache: new MemoryCache(),
    now: () => NOW,
  });
  await service.getMatrix();
  await service.getMatrix();
  assert.equal(kraken.calls.length, 1);
});

test("manual refresh re-reads at most once per cooldown window", async () => {
  let now = NOW;
  const binance = fakeProvider(() => hourlyCandles(60));
  const service = new RsiMatrixService({
    settingsService: fakeSettings([{ id: "btc", label: "BTC", provider: "binance", providerSymbol: "BTCUSDT" }], ["1h"]),
    providers: { binance },
    cache: new MemoryCache(),
    now: () => now,
  });
  await service.getMatrix();
  assert.equal(binance.calls.length, 1);
  now += 61_000;
  const first = await service.getMatrix({ force: true });
  assert.equal(first.refresh.forced, true);
  assert.equal(binance.calls.length, 2);
  now += 5_000;
  const second = await service.getMatrix({ force: true });
  assert.equal(second.refresh.forced, false, "a second click inside the window is served from cache");
  assert.equal(binance.calls.length, 2);
});

test("synthetic indices are never routed to Binance", async () => {
  const binance = fakeProvider(() => hourlyCandles(60));
  const dominance = fakeProvider(() => hourlyCandles(5));
  const service = new RsiMatrixService({
    settingsService: fakeSettings(DEFAULT_INSTRUMENTS.filter((r) => r.provider === "dominance")),
    providers: { binance, dominance },
    cache: new MemoryCache(),
    now: () => NOW,
  });
  const matrix = await service.getMatrix();
  assert.equal(binance.calls.length, 0);
  assert.ok(dominance.calls.length > 0);
  const usdt = matrix.instruments.find((r) => r.label === "USDT.D");
  assert.match(usdt.errors["1h"], /Building history: 4\/15/);

  // And the registry itself agrees: every dominance/TOTAL/CRYPTOCAP row uses
  // a derived provider.
  for (const row of DEFAULT_INSTRUMENTS) {
    if (/\.D$|^TOTAL|MCAP/.test(row.label)) {
      assert.ok(["dominance", "coingecko-mcap"].includes(row.provider), `${row.label} must use a derived provider`);
    }
  }
  for (const [provider, symbol] of [
    ["binance", "USDT.D"],
    ["binance", "TOTAL3"],
    ["binance-futures", "BTC.D"],
    ["mexc", "MEXC:MXUSDT"],
    ["yahoo", "CRYPTOCAP:USDT"],
    ["kucoin", "USDC.D"],
  ]) {
    assert.throws(() => normalizeProviderSymbol(provider, symbol), (err) => err.statusCode === 400, `${provider} ${symbol}`);
  }
});

test("the response carries the documented contract and group summaries", async () => {
  const binance = fakeProvider((symbol, tf) => hourlyCandles(60, { seed: symbol.length, tf }));
  const service = new RsiMatrixService({
    settingsService: fakeSettings([
      { id: "btc", label: "BTCUSD", provider: "binance", providerSymbol: "BTCUSDT" },
      { id: "eth", label: "ETHUSD", provider: "binance", providerSymbol: "ETHUSD" },
    ]),
    providers: { binance },
    cache: new MemoryCache(),
    now: () => NOW,
  });
  const matrix = await service.getMatrix();
  assert.equal(matrix.rsiLength, 14);
  assert.deepEqual(matrix.timeframes, ["1W", "1D", "4h", "1h"]);
  assert.equal(matrix.groups[0].id, "cross-market");
  assert.deepEqual(matrix.groups[0].rows, ["btc", "eth"]);
  const row = matrix.instruments[0];
  for (const key of ["id", "symbol", "source", "values", "average", "freshness", "error"]) assert.ok(key in row, key);
  const summary = matrix.groups[0].summary;
  assert.ok(summary.mostOverbought && summary.mostOversold && summary.strongestAverage && summary.weakestAverage);
  assert.ok(summary.mostOverbought.value >= summary.mostOversold.value);
  assert.equal(matrix.groups[1].rows.length, 0);
});

test("disabled timeframes and instruments are left out", async () => {
  const binance = fakeProvider(() => hourlyCandles(60));
  const service = new RsiMatrixService({
    settingsService: fakeSettings(
      [
        { id: "btc", label: "BTC", provider: "binance", providerSymbol: "BTCUSDT" },
        { id: "off", label: "OFF", provider: "binance", providerSymbol: "ETHUSDT", enabled: false },
      ],
      ["1D", "1h"],
    ),
    providers: { binance },
    cache: new MemoryCache(),
    now: () => NOW,
  });
  const matrix = await service.getMatrix();
  assert.deepEqual(matrix.timeframes, ["1D", "1h"]);
  assert.deepEqual(matrix.instruments.map((r) => r.id), ["btc"]);
  assert.equal(matrix.instruments[0].averageRequired, 2);
});

test("cache lifetime follows the next bar close", () => {
  // 12:30 → next 1h close at 13:00, plus grace.
  assert.equal(ttlUntilNextClose("1h", NOW), 30 * 60 * 1000 + 90 * 1000);
  assert.ok(ttlUntilNextClose("1W", NOW) <= 12 * HOUR);
  assert.ok(ttlUntilNextClose("4h", NOW) <= 2 * HOUR);
});

// ── Candle helpers ──────────────────────────────────────────────────────

test("1h bars roll up into UTC 4h bars and Monday-anchored weeks", () => {
  const start = Date.UTC(2026, 8, 21, 0); // a Monday
  const hourly = Array.from({ length: 8 }, (_, i) => ({
    openTime: start + i * HOUR,
    closeTime: start + (i + 1) * HOUR - 1,
    open: i,
    high: i + 10,
    low: i - 1,
    close: i + 0.5,
    volume: 1,
  }));
  const fourH = aggregateCandles(hourly, "4h");
  assert.equal(fourH.length, 2);
  assert.deepEqual(
    { open: fourH[0].open, high: fourH[0].high, low: fourH[0].low, close: fourH[0].close, volume: fourH[0].volume },
    { open: 0, high: 13, low: -1, close: 3.5, volume: 4 },
  );
  assert.equal(fourH[1].closeTime, start + 8 * HOUR - 1);
  assert.equal(bucketStart(Date.UTC(2026, 8, 24, 15), "1W"), start, "Thursday belongs to the week that opened Monday");
  assert.equal(new Date(bucketStart(NOW, "1W")).getUTCDay(), 1);
});

test("point series become bars, and only an unbroken tail is used", () => {
  const base = Date.UTC(2026, 8, 23, 0);
  const points = [
    { t: base + 5 * 60e3, value: 5 },
    { t: base + 50 * 60e3, value: 6 },
    // 01:00 hour missing — nobody sampled it.
    { t: base + 2 * HOUR + 1, value: 7 },
    { t: base + 3 * HOUR + 1, value: 8 },
  ];
  const bars = candlesFromPoints(points, "1h");
  assert.equal(bars.length, 3);
  assert.equal(bars[0].close, 6);
  const tail = contiguousTail(bars, "1h");
  assert.deepEqual(tail.map((b) => b.close), [7, 8]);
});

// ── Providers (fake fetch, real parsing) ────────────────────────────────

test("Binance spot reuses the screener's getCandles", async () => {
  const seen = [];
  const provider = new BinanceSpotProvider({
    signalScreenerService: {
      async getCandles(symbol, tf) {
        seen.push(`${symbol}:${tf}`);
        return hourlyCandles(3);
      },
    },
  });
  const candles = await provider.fetchCandles("BTCUSDT", "1W");
  assert.deepEqual(seen, ["BTCUSDT:1W"]);
  assert.equal(candles.length, 3);

  const bad = new BinanceSpotProvider({
    signalScreenerService: {
      async getCandles() {
        throw new Error("Binance klines HTTP 400 for NOPEUSDT 1d");
      },
    },
  });
  await assert.rejects(bad.fetchCandles("NOPEUSDT", "1D"), (err) => err.scope === "symbol");
});

test("MEXC, KuCoin, Kraken and Poloniex rows parse into the shared shape, oldest first", async () => {
  const t0 = Date.UTC(2026, 8, 22, 0);
  const mexc = new MexcProvider({
    fetchImpl: jsonFetch([["/api/v3/klines", [[t0, "1", "2", "0.5", "1.5", "10", t0 + HOUR - 1, "0"]]]]),
  });
  const m = await mexc.fetchCandles("MXUSDT", "1h");
  assert.deepEqual(m[0], { openTime: t0, closeTime: t0 + HOUR - 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

  const kucoinFetch = jsonFetch([
    [
      "type=4hour",
      { code: "200000", data: [[String((t0 + 4 * HOUR) / 1000), "2", "3", "4", "1", "5", "0"], [String(t0 / 1000), "1", "2", "3", "0.5", "5", "0"]] },
    ],
  ]);
  const k = await new KucoinProvider({ fetchImpl: kucoinFetch }).fetchCandles("KCS-USDT", "4h");
  assert.deepEqual(k.map((c) => c.close), [2, 3], "newest-first rows come back oldest first");
  assert.equal(k[0].high, 3);
  await assert.rejects(
    new KucoinProvider({ fetchImpl: jsonFetch([["candles", { code: "400100", msg: "This pair is not provided at present" }]]) }).fetchCandles("NO-PE", "1h"),
    (err) => err.scope === "symbol",
  );

  const kraken = new KrakenProvider({
    fetchImpl: jsonFetch([["OHLC", { error: [], result: { PYUSDEUR: [[t0 / 1000, "1", "2", "0.5", "1.1", "1", "9", 3]], last: 1 } }]]),
  });
  const kr = await kraken.fetchCandles("PYUSDEUR", "1D");
  assert.equal(kr[0].close, 1.1);
  assert.equal(kr[0].volume, 9);
  await assert.rejects(
    new KrakenProvider({ fetchImpl: jsonFetch([["OHLC", { error: ["EQuery:Unknown asset pair"] }]]) }).fetchCandles("NOPE", "1h"),
    (err) => err.scope === "symbol",
  );

  const polo = new PoloniexProvider({
    fetchImpl: jsonFetch([["/candles", [["0.9", "1.1", "1", "1.05", "0", "7", "0", "0", 1, t0, "1", "DAY_1", t0, t0 + 86400000 - 1]]]]),
  });
  const p = await polo.fetchCandles("FRAX_USDT", "1D");
  assert.deepEqual(p[0], { openTime: t0, closeTime: t0 + 86400000 - 1, open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 7 });
});

test("Coinbase has no 4h bar, so 4h is rolled up from real 1h candles", async () => {
  const t0 = Date.UTC(2026, 8, 22, 0) / 1000;
  const rows = Array.from({ length: 8 }, (_, i) => [t0 + (7 - i) * 3600, 0, 10, 1, 8 - i, 1]); // newest first
  const fetchImpl = jsonFetch([["granularity=3600", rows]]);
  const candles = await new CoinbaseProvider({ fetchImpl }).fetchCandles("TUSD-USD", "4h");
  assert.equal(candles.length, 2);
  assert.deepEqual(candles.map((c) => c.close), [4, 8]);
  assert.match(fetchImpl.calls[0], /granularity=3600/);
});

test("Yahoo chart history maps to candles; 4h is built from 1h; errors say unavailable", async () => {
  const t0 = Date.UTC(2026, 8, 22, 13, 30) / 1000;
  const body = {
    chart: {
      result: [
        {
          timestamp: [t0, t0 + 3600, t0 + 7200],
          indicators: { quote: [{ open: [1, 2, 3], high: [2, 3, 4], low: [0, 1, 2], close: [1.5, null, 3.5], volume: [1, 1, 1] }] },
        },
      ],
      error: null,
    },
  };
  const fetchImpl = jsonFetch([["/v8/finance/chart/", body]]);
  const provider = new YahooChartProvider({ fetchImpl });
  const hourly = await provider.fetchCandles("^GSPC", "1h");
  assert.equal(hourly.length, 2, "a bar with no close is dropped, not zeroed");
  assert.match(fetchImpl.calls[0], /%5EGSPC\?interval=1h/);
  const daily = await provider.fetchCandles("^GSPC", "1D");
  assert.equal(daily[0].closeTime, Date.UTC(2026, 8, 23) - 1, "a session bar closes at the end of its UTC day");
  await provider.fetchCandles("^GSPC", "4h");
  assert.match(fetchImpl.calls[2], /interval=1h&range=180d/);

  const missing = new YahooChartProvider({
    fetchImpl: jsonFetch([["/v8/", { __status: 404, chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }]]),
  });
  await assert.rejects(missing.fetchCandles("NOPE", "1D"), (err) => err.scope === "symbol" && /delisted/.test(err.message));
});

test("the verifier separates a bad symbol (400) from an unreachable venue (503)", async () => {
  const verify = createVerifier({
    mexc: { fetchCandles: async () => { throw Object.assign(new Error("HTTP 400"), { scope: "symbol" }); } },
    yahoo: { fetchCandles: async () => { throw Object.assign(new Error("timed out"), { scope: "venue" }); } },
    kraken: { fetchCandles: async () => [] },
    binance: { fetchCandles: async () => hourlyCandles(3) },
    dominance: { knownCoins: () => ["BTC", "ETH", "USDT", "USDC"] },
  });
  await assert.rejects(verify({ provider: "mexc", providerSymbol: "NOPEUSDT" }), (err) => err.statusCode === 400);
  await assert.rejects(verify({ provider: "yahoo", providerSymbol: "^GSPC" }), (err) => err.statusCode === 503);
  await assert.rejects(verify({ provider: "kraken", providerSymbol: "XBTUSD" }), (err) => err.statusCode === 400);
  await verify({ provider: "binance", providerSymbol: "BTCUSDT" });
  await verify({ provider: "dominance", providerSymbol: "USDC.D" });
  await verify({ provider: "dominance", providerSymbol: "TOTAL3" });
  await assert.rejects(verify({ provider: "dominance", providerSymbol: "DOGE.D" }), (err) => err.statusCode === 400);
});

// ── Sampled dominance history ───────────────────────────────────────────

test("dominance history records only live readings and builds bars from them", async () => {
  const dir = tmpDir();
  let now = Date.UTC(2026, 8, 23, 0, 5);
  let live = true;
  const marketDataService = {
    async getGlobalDominance() {
      return {
        live,
        totalMcap: 3_000_000_000_000,
        dominance: [
          { symbol: "BTC", percent: 55 + (now % 7) / 10 },
          { symbol: "ETH", percent: 12 },
          { symbol: "USDT", percent: 5 },
          { symbol: "USDC", percent: 2 },
        ],
      };
    },
  };
  const provider = new DominanceHistoryProvider({ marketDataService, dataDir: dir, now: () => now, logger: { error() {}, warn() {} } });
  await assert.rejects(provider.fetchCandles("USDT.D", "1h"), /No USDT\.D history recorded yet/);

  for (let i = 0; i < 20 * 4; i++) {
    await provider.sample();
    now += 15 * 60 * 1000;
  }
  live = false;
  assert.equal(await provider.sample(), false, "a fallback reading is never recorded");

  const btc = await provider.fetchCandles("BTC.D", "1h");
  assert.equal(btc.length, 20);
  const total3 = await provider.fetchCandles("TOTAL3", "1h");
  assert.ok(Math.abs(total3[0].close - 3_000_000_000_000 * (1 - (btc[0].close + 12) / 100)) < 1e6);
  assert.deepEqual(provider.knownCoins().sort(), ["BTC", "ETH", "USDC", "USDT"]);

  // USDT.D also reads what UsdtDominanceService has already accumulated.
  fs.writeFileSync(
    path.join(dir, "usdt-dominance-history.json"),
    JSON.stringify([{ t: Date.UTC(2026, 8, 22, 23, 10), percent: 4.9 }]),
  );
  const usdt = await provider.fetchCandles("USDT.D", "1h");
  assert.equal(usdt.length, 21);
  assert.equal(usdt[0].close, 4.9);
});
