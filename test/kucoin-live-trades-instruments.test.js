"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { KucoinInstrumentRegistry, resolveInstruments, INSTRUMENT_PATH } = require("../src/services/kucoin-live-trades/instruments");

// Shapes copied from GET /api/ua/v2/market/instrument (trimmed to the fields used).
const SPOT = [
  { symbol: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT", tradingStatus: "TradingEnabled", tickSize: "0.1", baseOrderStep: "0.00000001" },
  { symbol: "BTC-USDC", baseCurrency: "BTC", quoteCurrency: "USDC", tradingStatus: "TradingEnabled", tickSize: "0.1" },
  { symbol: "ETH-USDT", baseCurrency: "ETH", quoteCurrency: "USDT", tradingStatus: "TradingEnabled", tickSize: "0.01" },
  { symbol: "SOL-USDT", baseCurrency: "SOL", quoteCurrency: "USDT", tradingStatus: "TradingEnabled", tickSize: "0.01" },
];
const FUT = [
  { symbol: "XBTMZ26", baseCurrency: "XBT", quoteCurrency: "USD", settlementCurrency: "XBT", isInverse: true, contractType: "1", unitSize: "1.0", tradingStatus: "Open" },
  { symbol: "XBTUSDCM", baseCurrency: "XBT", quoteCurrency: "USDC", settlementCurrency: "USDC", isInverse: false, contractType: "0", unitSize: "0.00010", tradingStatus: "Open" },
  { symbol: "XBTUSDTM", baseCurrency: "XBT", quoteCurrency: "USDT", settlementCurrency: "USDT", isInverse: false, contractType: "0", unitSize: "0.001", lotSize: "1", tickSize: "0.1", tradingStatus: "Open" },
  { symbol: "XBTUSDM", baseCurrency: "XBT", quoteCurrency: "USD", settlementCurrency: "XBT", isInverse: true, contractType: "0", unitSize: "1.0", tradingStatus: "Open" },
  { symbol: "ETHUSDTM", baseCurrency: "ETH", quoteCurrency: "USDT", settlementCurrency: "USDT", isInverse: false, contractType: "0", unitSize: "0.01", tradingStatus: "Open" },
  { symbol: "SOLUSDTM", baseCurrency: "SOL", quoteCurrency: "USDT", settlementCurrency: "USDT", isInverse: false, contractType: "0", unitSize: "0.1", tradingStatus: "Open" },
];

test("spot and futures symbols are resolved from listings, not assumed to match", () => {
  const r = resolveInstruments({ spotList: SPOT, futuresList: FUT, fetchedAt: 42 });
  assert.equal(r.spot.BTC.symbol, "BTC-USDT");
  assert.equal(r.futures.BTC.symbol, "XBTUSDTM", "bitcoin futures are listed as XBT");
  assert.equal(r.futures.BTC.multiplier, 0.001);
  assert.equal(r.futures.BTC.multiplierText, "0.001");
  assert.equal(r.futures.BTC.quantityUnit, "contracts");
  assert.equal(r.futures.ETH.symbol, "ETHUSDTM");
  assert.equal(r.futures.ETH.multiplier, 0.01);
  assert.equal(r.futures.SOL.symbol, "SOLUSDTM");
  assert.equal(r.futures.SOL.multiplier, 0.1, "SOL contracts are 0.1 SOL, not 1");
  assert.equal(r.spot.SOL.quantityUnit, "SOL");
  assert.equal(r.fetchedAt, 42);
  assert.deepEqual(r.missing, []);
});

test("inverse, USDC-margined, delivery and halted contracts are never chosen", () => {
  const halted = FUT.map((item) => (item.symbol === "XBTUSDTM" ? { ...item, tradingStatus: "Paused" } : item));
  const r = resolveInstruments({ spotList: SPOT, futuresList: halted });
  assert.equal(r.futures.BTC, undefined);
  assert.deepEqual(r.missing, [{ marketType: "futures", asset: "BTC" }]);
  const noSol = resolveInstruments({ spotList: SPOT.filter((s) => s.baseCurrency !== "SOL"), futuresList: FUT });
  assert.deepEqual(noSol.missing, [{ marketType: "spot", asset: "SOL" }]);
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return handler(url);
  };
  fn.calls = calls;
  return fn;
}

const ok = (list) => ({ ok: true, status: 200, json: async () => ({ code: "200000", data: { list } }) });

test("the registry fetches both instrument lists, caches them and keeps the last good copy", async () => {
  let now = 1000;
  let fail = false;
  const fetchImpl = fakeFetch((url) => {
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return ok(url.includes("tradeType=SPOT") ? SPOT : FUT);
  });
  const registry = new KucoinInstrumentRegistry({ fetchImpl, baseUrl: "https://api.kucoin.com/", ttlMs: 60000, now: () => now });

  const btc = await registry.get("futures", "BTC");
  assert.equal(btc.symbol, "XBTUSDTM");
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.every((u) => u.startsWith(`https://api.kucoin.com${INSTRUMENT_PATH}?tradeType=`)));

  await registry.get("spot", "ETH");
  assert.equal(fetchImpl.calls.length, 2, "served from cache inside the TTL");

  now += 120000;
  fail = true;
  const stale = await registry.get("spot", "BTC");
  assert.equal(stale.symbol, "BTC-USDT", "a stale copy answers while refreshing");
  await new Promise((r) => setImmediate(r));
  assert.match(registry.status().lastError, /HTTP 503/);
  assert.equal((await registry.get("futures", "SOL")).multiplier, 0.1, "the last good copy survives a failed refresh");

  await assert.rejects(registry.get("futures", "DOGE"), (err) => err.statusCode === 404);
});

test("a registry that never loaded reports the upstream failure", async () => {
  const registry = new KucoinInstrumentRegistry({ fetchImpl: fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ code: "400100" }) })) });
  await assert.rejects(registry.get("spot", "BTC"), /code 400100/);
  assert.equal(registry.status().loaded, false);
});
