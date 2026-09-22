"use strict";

// Open Interest Intelligence: the Price x OI classification, the rule that a
// missing number never becomes zero, the provider fallback chain, and the
// guarantee that one venue failing never takes the page down.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const {
  classifyPriceOi,
  oiChanges,
  priceChanges,
  detectSpike,
  summarizeMarket,
  confluenceNotes,
  pctChange,
} = require("../src/services/open-interest/classify");
const {
  BinanceFuturesProvider,
  BybitProvider,
  OkxProvider,
  BitgetProvider,
  createProviders,
} = require("../src/services/open-interest/providers");
const { OpenInterestService } = require("../src/services/open-interest/service");
const { createOpenInterestRouter } = require("../src/routes/open-interest");
const { MemoryCache } = require("../src/services/cache");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const quiet = { log() {}, warn() {}, error() {} };

// ── classification ─────────────────────────────────────────

test("the four Price x OI states are classified from direction", () => {
  assert.equal(classifyPriceOi(2, 3, "1h"), "LONG_BUILDUP");
  assert.equal(classifyPriceOi(-2, 3, "1h"), "SHORT_BUILDUP");
  assert.equal(classifyPriceOi(2, -3, "1h"), "SHORT_COVERING");
  assert.equal(classifyPriceOi(-2, -3, "1h"), "LONG_UNWIND");
});

test("OI below the horizon's noise floor is FLAT whatever price did", () => {
  assert.equal(classifyPriceOi(5, 0.2, "1h"), "FLAT");
  // The same OI move is meaningful on 15m and noise on 24h.
  assert.equal(classifyPriceOi(1, 0.4, "15m"), "LONG_BUILDUP");
  assert.equal(classifyPriceOi(1.5, 1.5, "24h"), "FLAT");
});

test("OI moving while price is flat is leverage building or leaving, not a direction", () => {
  assert.equal(classifyPriceOi(0.05, 2, "1h"), "LEVERAGE_BUILDING");
  assert.equal(classifyPriceOi(-0.05, -2, "1h"), "LEVERAGE_LEAVING");
});

test("a missing price or OI change is UNKNOWN, never a zero-change reading", () => {
  assert.equal(classifyPriceOi(null, 3, "1h"), "UNKNOWN");
  assert.equal(classifyPriceOi(2, null, "1h"), "UNKNOWN");
  assert.equal(classifyPriceOi(undefined, undefined, "1h"), "UNKNOWN");
  assert.equal(pctChange(100, null), null);
  assert.equal(pctChange(100, 0), null);
});

function series(count, { stepMs = 15 * MIN, start = 1000, step = 0, end = NOW } = {}) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    points.push({ t: end - (count - 1 - i) * stepMs, oi: start + i * step });
  }
  return points;
}

test("OI changes are computed per horizon and left null when history is too short", () => {
  // 10 hours of 15m points: 15m, 1h and 4h exist, 24h does not.
  const points = series(41, { start: 1000, step: 1 });
  const changes = oiChanges(points, 15 * MIN);
  assert.ok(Math.abs(changes["15m"] - (1 / 1039) * 100) < 1e-9);
  assert.ok(Math.abs(changes["1h"] - (4 / 1036) * 100) < 1e-9);
  assert.ok(Math.abs(changes["4h"] - (16 / 1024) * 100) < 1e-9);
  assert.equal(changes["24h"], null);
});

test("a gap in the OI history leaves that horizon null rather than bridging it", () => {
  const points = series(100, { start: 1000, step: 1 });
  // Remove everything around t-4h.
  const gapped = points.filter((p) => Math.abs(p.t - (NOW - 4 * 60 * MIN)) > 40 * MIN);
  assert.equal(oiChanges(gapped, 15 * MIN)["4h"], null);
  assert.notEqual(oiChanges(gapped, 15 * MIN)["1h"], null);
});

test("price changes read the close of the candle that had closed by the horizon", () => {
  const candles = [];
  for (let i = 0; i < 200; i += 1) {
    const closeTime = NOW - (199 - i) * 15 * MIN;
    candles.push({ openTime: closeTime - 15 * MIN, closeTime, close: 100 + i });
  }
  const changes = priceChanges(candles, NOW);
  assert.ok(Math.abs(changes["1h"] - ((299 - 295) / 295) * 100) < 1e-9);
  assert.ok(Math.abs(changes["24h"] - ((299 - 203) / 203) * 100) < 1e-9);
});

test("a spike is judged against the asset's own recent 1h changes", () => {
  const calm = [];
  for (let i = 0; i < 120; i += 1) calm.push({ t: NOW - (119 - i) * 15 * MIN, oi: 1000 * (1 + 0.002 * Math.sin(i)) });
  const quietResult = detectSpike(calm, 15 * MIN);
  assert.equal(quietResult.isSpike, false);

  const spiking = calm.slice(0, -1).concat([{ t: NOW, oi: 1080 }]);
  const spike = detectSpike(spiking, 15 * MIN);
  assert.equal(spike.isSpike, true);
  assert.equal(spike.direction, "UP");
  assert.ok(spike.zScore > 2.5);

  assert.equal(detectSpike(calm.slice(-10), 15 * MIN), null, "too little history is no verdict at all");
});

test("the market summary weights by OI, reports coverage, and ignores missing rows", () => {
  const rows = [
    { symbol: "BTCUSDT", oiUsd: 900, oiChange: { "15m": null, "1h": 10, "4h": null, "24h": null } },
    { symbol: "ETHUSDT", oiUsd: 100, oiChange: { "15m": null, "1h": -10, "4h": null, "24h": null } },
    { symbol: "SOLUSDT", oiUsd: null, oiChange: { "15m": null, "1h": 50, "4h": null, "24h": null } },
  ];
  const summary = summarizeMarket(rows);
  assert.equal(summary.totalOiUsd, 1000);
  assert.equal(summary.assetsWithOi, 2);
  assert.equal(summary.assetsTracked, 3);
  const h1 = summary.horizons["1h"];
  const expected = (1000 / (900 / 1.1 + 100 / 0.9) - 1) * 100;
  assert.ok(Math.abs(h1.changePct - expected) < 1e-3);
  assert.equal(h1.covered, 2);
  assert.equal(h1.breadthPct, 50);
  // No row had a 4h change: the horizon is unknown, not 0%.
  assert.equal(summary.horizons["4h"].changePct, null);
  assert.equal(summary.horizons["4h"].state, "UNKNOWN");
});

test("summary with no data at all has a null total, not zero", () => {
  const summary = summarizeMarket([]);
  assert.equal(summary.totalOiUsd, null);
  assert.equal(summary.horizons["1h"].breadthPct, null);
});

test("confluence flags rising leverage near a confirmed top and agreement with bias", () => {
  const notes = confluenceNotes({
    oiState: "LONG_BUILDUP",
    bias: "BULLISH",
    extreme: { dominant: "top", state: "CONFIRMED" },
  });
  assert.deepEqual(notes.map((n) => n.tone), ["warn", "aligned"]);
  assert.match(notes[0].text, /Rising leverage near a confirmed local top/);

  const against = confluenceNotes({ oiState: "SHORT_COVERING", bias: "BEARISH", extreme: null });
  assert.equal(against[0].tone, "caution");
  assert.deepEqual(confluenceNotes({ oiState: "UNKNOWN", bias: "BULLISH", extreme: null }), []);
});

// ── providers ──────────────────────────────────────────────

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function router(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        const result = typeof handler === "function" ? handler(url) : handler;
        if (result instanceof Error) throw result;
        return result;
      }
    }
    return jsonResponse(404, { msg: "no route" });
  };
  return { fetchImpl, calls };
}

test("Binance history maps 1000-unit aliases and sorts oldest first", async () => {
  const { fetchImpl, calls } = router([["openInterestHist", jsonResponse(200, [
    { symbol: "1000PEPEUSDT", sumOpenInterest: "20", sumOpenInterestValue: "300", timestamp: 2000 },
    { symbol: "1000PEPEUSDT", sumOpenInterest: "10", sumOpenInterestValue: "150", timestamp: 1000 },
  ])]]);
  const provider = new BinanceFuturesProvider({ fetchImpl });
  const result = await provider.history("PEPEUSDT", { period: "15m", limit: 500 });
  assert.match(calls[0], /symbol=1000PEPEUSDT&period=15m&limit=500/);
  assert.equal(result.multiplier, 1000);
  assert.deepEqual(result.points.map((p) => p.t), [1000, 2000]);
  assert.equal(result.points[1].oiUsd, 300);
});

test("Bybit, OKX and Bitget normalise to the same point shape", async () => {
  const bybit = new BybitProvider({ fetchImpl: router([["open-interest", jsonResponse(200, {
    retCode: 0, result: { list: [{ openInterest: "5", timestamp: "2000" }, { openInterest: "4", timestamp: "1000" }] },
  })]]).fetchImpl });
  const b = await bybit.history("BTCUSDT", { period: "15m", limit: 500 });
  assert.deepEqual(b.points, [{ t: 1000, oi: 4, oiUsd: null }, { t: 2000, oi: 5, oiUsd: null }]);

  const okx = new OkxProvider({ fetchImpl: router([["open-interest-history", jsonResponse(200, {
    code: "0", data: [["2000", "900", "9", "90000"], ["1000", "800", "8", "80000"]],
  })]]).fetchImpl });
  const o = await okx.history("BTCUSDT", { period: "15m" });
  assert.equal(o.venueSymbol, "BTC-USDT-SWAP");
  assert.deepEqual(o.points, [{ t: 1000, oi: 8, oiUsd: 80000 }, { t: 2000, oi: 9, oiUsd: 90000 }]);

  const bitget = new BitgetProvider({ fetchImpl: router([["open-interest", jsonResponse(200, {
    code: "00000", data: { openInterestList: [{ symbol: "BTCUSDT", size: "12.5" }], ts: "3000" },
  })]]).fetchImpl });
  const g = await bitget.history("BTCUSDT");
  assert.deepEqual(g.points, [{ t: 3000, oi: 12.5, oiUsd: null }]);
  assert.equal(bitget.supportsHistory, false);
});

test("venue errors are scoped: a geo-block benches the venue, a bad symbol does not", async () => {
  const blocked = new BinanceFuturesProvider({ fetchImpl: router([["openInterestHist", jsonResponse(451, { msg: "restricted location" })]]).fetchImpl });
  await assert.rejects(blocked.history("BTCUSDT"), (err) => err.scope === "venue" && /451/.test(err.message));
  const unknown = new BinanceFuturesProvider({ fetchImpl: router([["openInterestHist", jsonResponse(400, { code: -1121, msg: "Invalid symbol." })]]).fetchImpl });
  await assert.rejects(unknown.history("FOOUSDT"), (err) => err.scope === "symbol");
  const bybitUnknown = new BybitProvider({ fetchImpl: router([["open-interest", jsonResponse(200, { retCode: 10001, retMsg: "symbol invalid" })]]).fetchImpl });
  await assert.rejects(bybitUnknown.history("FOOUSDT"), (err) => err.scope === "symbol");
  const timedOut = new OkxProvider({ fetchImpl: async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }, timeoutMs: 50 });
  await assert.rejects(timedOut.history("BTCUSDT"), (err) => err.scope === "venue" && /timed out/.test(err.message));
});

test("createProviders rejects unknown ids and de-duplicates", () => {
  assert.deepEqual(createProviders(["okx", "OKX", "bitget"]).map((p) => p.id), ["okx", "bitget"]);
  assert.throws(() => createProviders(["coinglass"]), /Unknown open-interest provider/);
});

// ── service ────────────────────────────────────────────────

function fakeProvider(id, { supportsHistory = true, history, funding, longShort } = {}) {
  const calls = [];
  return {
    id,
    label: id.toUpperCase(),
    supportsHistory,
    calls,
    async history(symbol, opts) {
      calls.push(symbol);
      return history(symbol, opts);
    },
    async funding(symbol) {
      if (!funding) throw Object.assign(new Error("no funding"), { scope: "symbol" });
      return funding(symbol);
    },
    async longShort(symbol) {
      if (!longShort) throw Object.assign(new Error("no ratio"), { scope: "symbol" });
      return longShort(symbol);
    },
  };
}

function venueError(message) {
  return Object.assign(new Error(message), { scope: "venue" });
}

function candles(count, { end = NOW, stepMs = 15 * MIN, start = 100, step = 0.1 } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const closeTime = end - (count - 1 - i) * stepMs;
    out.push({ openTime: closeTime - stepMs, closeTime, open: start + i * step, high: start + i * step, low: start + i * step, close: start + i * step, volume: 1 });
  }
  return out;
}

function fakeScreener({ failCandles = false, failConfluence = false } = {}) {
  return {
    async getCandles(symbol) {
      if (failCandles) throw new Error("binance spot down");
      return candles(200);
    },
    async scanDirectionalBias(interval, minChecks, { symbols }) {
      if (failConfluence) throw new Error("scan failed");
      return symbols.map((symbol) => ({ symbol, bias: "BULLISH", score: 83 }));
    },
    async scanLocalExtremes(interval, minChecks, { symbols }) {
      if (failConfluence) throw new Error("scan failed");
      return symbols.map((symbol) => ({ symbol, dominant: "top", state: "CONFIRMED", topScore: 90, bottomScore: 10 }));
    },
  };
}

function makeService({ providers, screener = fakeScreener(), universe = ["ETHUSDT", "BTCUSDT", "SOLUSDT"], clock } = {}) {
  let now = NOW;
  const service = new OpenInterestService({
    providers,
    signalScreenerService: screener,
    screenerSettingsService: { getUniverse: () => universe.slice(), catalog: () => universe.concat(["DOGEUSDT"]) },
    cache: new MemoryCache(),
    cacheTtlMs: 60 * 1000,
    now: clock || (() => now),
    logger: quiet,
  });
  return { service, advance: (ms) => { now += ms; } };
}

const rising = () => ({ venueSymbol: "X", multiplier: 1, points: series(120, { start: 1000, step: 2 }).map((p) => ({ ...p, oiUsd: p.oi * 10 })) });

test("rows are served BTC first, classified, and carry their source and freshness", async () => {
  const { service } = makeService({ providers: [fakeProvider("binance", { history: rising })] });
  const snap = await service.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.symbol), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const btc = snap.rows[0];
  assert.equal(btc.source.id, "binance");
  assert.equal(btc.freshness.state, "FRESH");
  assert.equal(btc.states["1h"].state, "LONG_BUILDUP");
  assert.equal(btc.oiUsdBasis, "venue");
  assert.equal(snap.summary.btc.symbol, "BTCUSDT");
  assert.equal(snap.summary.assetsWithOi, 3);
  assert.equal(snap.sources[0].status, "ok");
  // Confluence came from the screener projections and produced the warning.
  assert.equal(btc.confluence.bias, "BULLISH");
  assert.match(btc.confluence.notes["1h"][0].text, /Rising leverage near a confirmed local top/);
});

test("a blocked venue is benched and the next one serves every asset", async () => {
  const binance = fakeProvider("binance", { history: () => { throw venueError("HTTP 451 — restricted location"); } });
  const bybit = fakeProvider("bybit", { history: rising });
  const { service } = makeService({ providers: [binance, bybit] });
  const snap = await service.snapshot();
  assert.ok(snap.rows.every((r) => r.source && r.source.id === "bybit"));
  // Rows load in parallel, so the first wave may each ask once; after that
  // the venue is benched and a forced rescan does not touch it at all.
  const firstWave = binance.calls.length;
  assert.ok(firstWave >= 1 && firstWave <= 3);
  await service.snapshot({ force: true });
  assert.equal(binance.calls.length, firstWave);
  const binanceStatus = snap.sources.find((s) => s.id === "binance");
  assert.equal(binanceStatus.status, "down");
  assert.match(binanceStatus.error, /451/);
});

test("an asset one venue doesn't list falls through to the next without benching it", async () => {
  const binance = fakeProvider("binance", {
    history: (symbol) => {
      if (symbol === "SOLUSDT") throw Object.assign(new Error("Invalid symbol"), { scope: "symbol" });
      return rising();
    },
  });
  const okx = fakeProvider("okx", { history: rising });
  const { service } = makeService({ providers: [binance, okx] });
  const snap = await service.snapshot();
  assert.equal(snap.rows.find((r) => r.symbol === "SOLUSDT").source.id, "okx");
  assert.equal(snap.rows.find((r) => r.symbol === "BTCUSDT").source.id, "binance");
});

test("every venue failing yields error rows with nulls, never zeros, and the page still answers", async () => {
  const { service } = makeService({
    providers: [fakeProvider("binance", { history: () => { throw venueError("down"); } })],
  });
  const snap = await service.snapshot();
  assert.equal(snap.rows.length, 3);
  for (const row of snap.rows) {
    assert.ok(row.error);
    assert.equal(row.oiUsd, null);
    assert.deepEqual(Object.values(row.oiChange), [null, null, null, null]);
    assert.equal(row.states["1h"].state, "UNKNOWN");
    assert.equal(row.freshness.state, "UNKNOWN");
  }
  assert.equal(snap.summary.totalOiUsd, null);
  assert.equal(snap.summary.errorRows, 3);
});

test("a current-only venue shows the OI level with every change unavailable", async () => {
  const bitget = fakeProvider("bitget", {
    supportsHistory: false,
    history: () => ({ venueSymbol: "BTCUSDT", multiplier: 1, points: [{ t: NOW, oi: 50, oiUsd: null }] }),
  });
  const { service } = makeService({ providers: [bitget], universe: ["BTCUSDT"] });
  const [row] = (await service.snapshot()).rows;
  assert.equal(row.error, null);
  assert.deepEqual(Object.values(row.oiChange), [null, null, null, null]);
  assert.equal(row.states["4h"].state, "UNKNOWN");
  assert.equal(row.oiUsdBasis, "estimated");
  assert.ok(row.oiUsd > 0);
  assert.match(row.notes[0], /current OI only/);
});

test("a refresh that fails after a good one serves the last good row marked STALE", async () => {
  let fail = false;
  const provider = fakeProvider("binance", { history: () => { if (fail) throw venueError("HTTP 503"); return rising(); } });
  const { service, advance } = makeService({ providers: [provider], universe: ["BTCUSDT"] });
  const first = await service.row("BTCUSDT");
  assert.equal(first.freshness.state, "FRESH");
  fail = true;
  advance(2 * 60 * 1000);
  const second = await service.row("BTCUSDT", { force: true });
  assert.equal(second.error, null);
  assert.equal(second.freshness.state, "STALE");
  assert.match(second.freshness.reason, /Refresh failed/);
  assert.equal(second.oiUsd, first.oiUsd);
});

test("an old OI timestamp is STALE even when the fetch itself succeeded", async () => {
  const old = () => ({ venueSymbol: "X", multiplier: 1, points: series(120, { start: 1000, step: 1, end: NOW - 3 * 60 * MIN }) });
  const { service } = makeService({ providers: [fakeProvider("binance", { history: old })], universe: ["BTCUSDT"] });
  const [row] = (await service.snapshot()).rows;
  assert.equal(row.freshness.state, "STALE");
});

test("spot price failing keeps the OI row and marks the classification unknown", async () => {
  const { service } = makeService({
    providers: [fakeProvider("binance", { history: rising })],
    screener: fakeScreener({ failCandles: true }),
    universe: ["BTCUSDT"],
  });
  const [row] = (await service.snapshot()).rows;
  assert.equal(row.error, null);
  assert.equal(row.price, null);
  assert.notEqual(row.oiChange["1h"], null);
  assert.equal(row.states["1h"].state, "UNKNOWN");
  assert.match(row.notes.join(" "), /Spot price unavailable/);
});

test("the confluence scan failing degrades only the confluence column", async () => {
  const { service } = makeService({
    providers: [fakeProvider("binance", { history: rising })],
    screener: fakeScreener({ failConfluence: true }),
  });
  const snap = await service.snapshot();
  assert.equal(snap.confluence.available, false);
  assert.equal(snap.rows[0].error, null);
  assert.equal(snap.rows[0].confluence.bias, null);
});

test("detail returns aligned series, funding and an honest liquidation gap", async () => {
  const provider = fakeProvider("binance", {
    history: rising,
    funding: () => ({ rate: 0.0001, nextFundingTime: NOW + 60 * MIN }),
  });
  const { service } = makeService({ providers: [provider] });
  const detail = await service.detail("btcusdt", { interval: "1h" });
  assert.equal(detail.symbol, "BTCUSDT");
  assert.ok(detail.series.oi.points.length > 0);
  assert.ok(detail.series.price.candles.length > 0);
  assert.equal(detail.funding.rate, 0.0001);
  assert.equal(detail.funding.source.id, "binance");
  assert.equal(detail.longShort, null);
  assert.ok(detail.errors.some((e) => /Long\/short/.test(e)));
  assert.equal(detail.liquidations.available, false);

  await assert.rejects(service.detail("BTCUSDT", { interval: "3m" }), (err) => err.statusCode === 400);
  await assert.rejects(service.detail("XYZUSDT"), (err) => err.statusCode === 404);
  await assert.rejects(service.detail("BTC-PERP"), (err) => err.statusCode === 400);
});

test("the API serves the snapshot and detail with no-store and proper errors", async () => {
  const { service } = makeService({ providers: [fakeProvider("binance", { history: rising })] });
  const app = express();
  app.use("/api/open-interest", createOpenInterestRouter({ openInterestService: service }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const snap = await fetch(`${base}/api/open-interest?confluence=1h`);
    assert.equal(snap.status, 200);
    assert.equal(snap.headers.get("cache-control"), "no-store");
    const body = await snap.json();
    assert.equal(body.rows[0].symbol, "BTCUSDT");
    assert.equal(body.confluence.interval, "1h");

    const detail = await fetch(`${base}/api/open-interest/ETHUSDT?interval=4h`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).interval, "4h");

    const missing = await fetch(`${base}/api/open-interest/NOPEUSDT`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
