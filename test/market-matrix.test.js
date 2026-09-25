"use strict";

// TradeHunter → Market Matrix: chart feeds, the route, and the page wiring.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const { MarketMatrixService, YahooMatrixProvider, summarize, SAMPLED_STALE_MS } = require("../src/services/market-matrix");
const { createMarketMatrixRouter } = require("../src/routes/market-matrix");
const { DEFAULT_PANELS, DEFAULT_TIMEFRAME, SYMBOLS, SOURCES, getSymbol } = require("../src/config/market-matrix");
const { MemoryCache } = require("../src/services/cache");

const ROOT = path.join(__dirname, "..");
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 24, 12, 30);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function hourly(n, { end = NOW, start = 100 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const openTime = Math.floor(end / HOUR) * HOUR - (n - 1 - i) * HOUR;
    const close = start + i;
    return { openTime, closeTime: openTime + HOUR - 1, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1 };
  });
}

function build({ screener, dominance, yahoo } = {}) {
  const calls = [];
  const service = new MarketMatrixService({
    cache: new MemoryCache(),
    now: () => NOW,
    signalScreenerService: screener || {
      getCandles: async (symbol, tf, opts) => {
        calls.push({ symbol, tf, opts });
        return hourly(48);
      },
    },
    dominanceProvider: dominance || { points: () => [] },
    yahooProvider: yahoo || { fetchCandles: async () => hourly(48, { start: 97 }) },
  });
  return { service, calls };
}

test("defaults are TOTAL / DXY / BTC / USDT.D on 1H, each mapped to a real source", () => {
  assert.deepEqual(DEFAULT_PANELS, ["TOTAL", "DXY", "BTC", "USDT.D"]);
  assert.equal(DEFAULT_TIMEFRAME, "1h");
  assert.deepEqual(
    DEFAULT_PANELS.map((id) => [getSymbol(id).source, getSymbol(id).providerSymbol]),
    [["sampled", "TOTAL"], ["yahoo", "DX-Y.NYB"], ["binance", "BTCUSDT"], ["sampled", "USDT.D"]],
  );
  for (const sym of SYMBOLS) assert.ok(SOURCES[sym.source], `${sym.id} has an unknown source`);
  assert.ok(!SOURCES.sampled.timeframes.includes("5m"), "15-minute samples cannot make 5m bars");
});

test("BTC comes from the screener's Binance klines, forced fresh, with change vs previous close", async () => {
  const { service, calls } = build();
  const chart = await service.getChart({ symbol: "BTC", timeframe: "1h" });
  assert.equal(chart.available, true);
  assert.deepEqual(calls[0], { symbol: "BTCUSDT", tf: "1h", opts: { force: true } });
  assert.equal(chart.source.label, "Binance Spot");
  assert.equal(chart.chartType, "candles");
  assert.equal(chart.candles.length, 48);
  assert.equal(chart.value, 147);
  assert.equal(chart.previousClose, 146);
  assert.equal(chart.changePct, Number(((1 / 146) * 100).toFixed(4)));
  assert.equal(chart.change24hPct, Number(((24 / 123) * 100).toFixed(4)));
  assert.equal(chart.candles[0].time, Math.floor(hourly(48)[0].openTime / 1000));

  // A second read inside the TTL is served from cache.
  await service.getChart({ symbol: "BTC", timeframe: "1h" });
  assert.equal(calls.length, 1);
});

test("a failed feed is unavailable with its reason, never substituted", async () => {
  const { service } = build({ yahoo: { fetchCandles: async () => { throw new Error("Yahoo Finance HTTP 503"); } } });
  const chart = await service.getChart({ symbol: "DXY", timeframe: "4h" });
  assert.equal(chart.available, false);
  assert.match(chart.error, /Yahoo Finance HTTP 503/);
  assert.deepEqual(chart.candles, []);
  assert.equal(chart.value, undefined);
  assert.equal(chart.source.providerSymbol, "DX-Y.NYB");
});

test("sampled series: line bars from samples, 5m refused, stale sampling refused", async () => {
  const fresh = Array.from({ length: 16 }, (_, i) => ({ t: NOW - (15 - i) * 15 * 60 * 1000, value: 4 + i / 100 }));
  const { service } = build({ dominance: { points: () => fresh } });
  const chart = await service.getChart({ symbol: "USDT.D", timeframe: "1h" });
  assert.equal(chart.available, true);
  assert.equal(chart.chartType, "line");
  assert.equal(chart.source.sampled, true);
  assert.equal(chart.value, 4.15);

  const fiveMin = await service.getChart({ symbol: "TOTAL", timeframe: "5m" });
  assert.equal(fiveMin.available, false);
  assert.match(fiveMin.error, /no 5m bars/);

  const old = fresh.map((p) => ({ ...p, t: p.t - SAMPLED_STALE_MS - 60 * 1000 }));
  const stale = await build({ dominance: { points: () => old } }).service.getChart({ symbol: "USDT.D", timeframe: "1h" });
  assert.equal(stale.available, false);
  assert.match(stale.error, /sampling has stopped/);

  const empty = await build().service.getChart({ symbol: "TOTAL", timeframe: "1h" });
  assert.equal(empty.available, false);
  assert.match(empty.error, /No TOTAL samples recorded yet/);
});

test("unknown symbols and timeframes are 400s", async () => {
  const { service } = build();
  await assert.rejects(service.getChart({ symbol: "UUP", timeframe: "1h" }), (err) => err.statusCode === 400);
  await assert.rejects(service.getChart({ symbol: "BTC", timeframe: "2h" }), (err) => err.statusCode === 400);
});

test("24h change is withheld when the history has a gap there", () => {
  const candles = hourly(48);
  const gapped = candles.slice(0, 10).concat(candles.slice(40));
  assert.equal(summarize(gapped, "1h").change24hPct, null);
  assert.equal(summarize(hourly(2), "1W").change24hPct, null);
});

test("Yahoo intraday bars close at their own interval; 4H is rolled up from 1H", async () => {
  const ts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Date.UTC(2026, 8, 21, 0) / 1000 + i * 3600);
  const body = {
    chart: {
      result: [{ timestamp: ts, indicators: { quote: [{ open: ts.map(() => 1), high: ts.map(() => 2), low: ts.map(() => 0.5), close: ts.map((_, i) => 1 + i), volume: ts.map(() => 0) }] } }],
    },
  };
  const urls = [];
  const yahoo = new YahooMatrixProvider({
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const fifteen = await yahoo.fetchCandles("DX-Y.NYB", "15m");
  assert.match(urls[0], /interval=15m/);
  assert.equal(fifteen[0].closeTime - fifteen[0].openTime, 15 * 60 * 1000 - 1);
  const four = await yahoo.fetchCandles("DX-Y.NYB", "4h");
  assert.match(urls[1], /interval=60m/);
  assert.equal(four.length, 2);
  assert.equal(four[0].close, 4);
  assert.equal(four[1].close, 8);
});

test("route serves config and charts; failures are 200 + available:false", async () => {
  const { service } = build({ yahoo: { fetchCandles: async () => { throw new Error("down"); } } });
  const app = express();
  app.use("/api/market-matrix", createMarketMatrixRouter({ marketMatrixService: service }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/market-matrix`;
  try {
    const config = await (await fetch(`${base}/config`)).json();
    assert.deepEqual(config.defaults, { panels: DEFAULT_PANELS, timeframe: "1h" });
    assert.deepEqual(config.timeframes.map((t) => t.label), ["5m", "15m", "30m", "1H", "4H", "1D", "1W"]);
    assert.ok(config.symbols.find((s) => s.id === "TOTAL").timeframes.every((tf) => tf !== "5m"));

    const btc = await fetch(`${base}/chart?symbol=BTC&tf=1h`);
    assert.equal(btc.status, 200);
    assert.equal((await btc.json()).available, true);

    const dxy = await (await fetch(`${base}/chart?symbol=DXY&tf=1h`)).json();
    assert.equal(dxy.available, false);

    assert.equal((await fetch(`${base}/chart?symbol=NOPE&tf=1h`)).status, 400);
  } finally {
    server.close();
  }
});

test("page, navigation and route alias are wired", () => {
  const html = read("public/market-matrix.html");
  assert.match(html, /\/assets\/vendor\/lightweight-charts\/lightweight-charts-4\.2\.3\.standalone\.production\.js/);
  assert.match(html, /\/assets\/js\/market-matrix\.js/);
  assert.match(html, /id="mm-grid"/);
  assert.match(html, /<strong>AI use: No\.<\/strong>/);
  assert.ok(html.indexOf("How this page works") > html.indexOf('id="mm-grid"'));

  const sidebar = read("public/assets/js/sidebar.js");
  const tradeHunter = sidebar.slice(sidebar.indexOf('label: "TradeHunter"'), sidebar.indexOf('label: "AI Analysis"'));
  assert.match(tradeHunter, /href: "\/tradehunter\/market-matrix", label: "Market Matrix"/);

  const appSource = read("src/app.js");
  assert.match(appSource, /"\/tradehunter\/market-matrix"/);
  assert.match(appSource, /app\.use\("\/api\/market-matrix"/);
});
