"use strict";

// /api/rsi-matrix over HTTP, plus the page and navigation that front it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const express = require("express");

const { createRsiMatrixRouter } = require("../src/routes/rsi-matrix");
const { RsiMatrixSettingsService } = require("../src/services/rsi-matrix-settings");
const { RsiMatrixService } = require("../src/services/rsi-matrix/service");
const { MemoryCache } = require("../src/services/cache");

const ROOT = path.join(__dirname, "..");
const quiet = { log() {}, warn() {}, error() {} };
const SECRET = "cg-demo-key-must-never-leak";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function candles(n) {
  const now = Date.now();
  const hour = 3600 * 1000;
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 5;
    const openTime = now - (n - i) * hour;
    return { openTime, closeTime: openTime + hour - 1, open: close, high: close, low: close, close, volume: 1 };
  });
}

function buildApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-matrix-route-"));
  const settings = new RsiMatrixSettingsService({ dataDir, logger: quiet, verifyInstrument: async () => {} });
  settings.ensureSeeded();
  // Every provider answers with enough history, except Yahoo, which is down.
  const ok = { fetchCandles: async () => candles(300) };
  const providers = new Proxy(
    {
      yahoo: { fetchCandles: async () => { throw new Error("Yahoo Finance HTTP 503"); } },
      // A market-data client holding a key sits behind this provider; nothing
      // from it may be serialised into a response.
      "coingecko-mcap": { config: { coingeckoApiKey: SECRET }, fetchCandles: async () => candles(300) },
    },
    { get: (target, key) => target[key] || ok },
  );
  const service = new RsiMatrixService({ settingsService: settings, providers, cache: new MemoryCache() });
  const requireAdmin = (req, res, next) => (req.headers["x-admin-key"] === "admin" ? next() : res.status(401).json({ error: "Admin key required" }));
  const app = express();
  app.use(express.json());
  app.use("/api/rsi-matrix", createRsiMatrixRouter({ rsiMatrixService: service, rsiMatrixSettingsService: settings, requireAdmin }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/rsi-matrix renders every group even when one source is down", async () => {
  await withServer(buildApp(), async (base) => {
    const res = await fetch(`${base}/api/rsi-matrix`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "no API key in the response");
    const body = JSON.parse(text);
    assert.equal(body.rsiLength, 14);
    assert.deepEqual(body.timeframes, ["1W", "1D", "4h", "1h"]);
    assert.deepEqual(body.groups.map((g) => g.id), ["cross-market", "crypto-stables"]);
    const gold = body.instruments.find((r) => r.id === "gold");
    const btc = body.instruments.find((r) => r.id === "btc-usd");
    assert.match(gold.error, /Data unavailable/);
    assert.equal(gold.values["1h"], null, "unavailable is null, never 0");
    assert.equal(typeof btc.values["1h"], "number");
    assert.equal(typeof btc.average, "number");
  });
});

test("settings reads are open, writes are admin-gated", async () => {
  await withServer(buildApp(), async (base) => {
    const snap = await (await fetch(`${base}/api/rsi-matrix/settings`)).json();
    assert.ok(snap.providers.length >= 8);
    assert.ok(!JSON.stringify(snap).includes(SECRET));

    const body = JSON.stringify({ label: "RENDER", group: "crypto-stables", provider: "binance", providerSymbol: "RENDERUSDT" });
    const denied = await fetch(`${base}/api/rsi-matrix/settings/instruments`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(denied.status, 401);

    const added = await fetch(`${base}/api/rsi-matrix/settings/instruments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "admin" },
      body,
    });
    assert.equal(added.status, 200);
    const render = (await added.json()).instruments.find((r) => r.label === "RENDER");

    const bad = await fetch(`${base}/api/rsi-matrix/settings/instruments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": "admin" },
      body: JSON.stringify({ label: "USDT.D", group: "crypto-stables", provider: "binance", providerSymbol: "USDT.D" }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /synthetic index/);

    const del = await fetch(`${base}/api/rsi-matrix/settings/instruments/${render.id}`, { method: "DELETE", headers: { "x-admin-key": "admin" } });
    assert.equal(del.status, 200);
    const putDenied = await fetch(`${base}/api/rsi-matrix/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(putDenied.status, 401);
    const reset = await fetch(`${base}/api/rsi-matrix/settings/reset`, { method: "POST", headers: { "x-admin-key": "admin" } });
    assert.equal(reset.status, 200);
  });
});

// ── Page, script and navigation ─────────────────────────────────────────

test("RSI Matrix sits under TradeHunter → Screeners and its assets exist", () => {
  const sidebar = read("public/assets/js/sidebar.js");
  const start = sidebar.indexOf('label: "Screeners"');
  const menu = sidebar.slice(start, sidebar.indexOf('label: "My Trades"', start));
  assert.match(menu, /href: "\/rsi-matrix\.html", label: "RSI Matrix"/);
  const page = read("public/rsi-matrix.html");
  for (const asset of ["/assets/styles/rsi-matrix.css", "/assets/js/rsi-matrix.js", "/assets/js/sidebar.js"]) {
    assert.ok(page.includes(asset));
    assert.ok(fs.existsSync(path.join(ROOT, "public", asset)));
  }
  const settings = read("public/settings.html");
  assert.match(settings, /id="rsi-matrix-settings"/);
  assert.match(settings, /\/api\/rsi-matrix\/settings/);
});

test("nothing on the page reads as a trade instruction", () => {
  const code = read("public/assets/js/rsi-matrix.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bBUY\b|\bSELL\b|"LONG"|"SHORT"/);
});

// Runs the real page script against a minimal DOM and a canned response.
async function renderPage(matrix) {
  const elements = {};
  function el(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        innerHTML: "",
        textContent: "",
        value: "",
        className: "",
        style: {},
        disabled: false,
        addEventListener() {},
        querySelectorAll: () => [],
      };
    }
    return elements[id];
  }
  const context = {
    document: { getElementById: el, hidden: false },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => matrix }),
    setInterval: () => 0,
    console,
  };
  vm.runInNewContext(read("public/assets/js/rsi-matrix.js"), context);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

test("missing values render as —, never RSI 0, and a partial AVG says how many exist", async () => {
  const matrix = {
    updatedAt: new Date().toISOString(),
    rsiLength: 14,
    timeframes: ["1W", "1D", "4h", "1h"],
    timeframeLabels: { "1W": "1W", "1D": "1D", "4h": "4H", "1h": "1H" },
    thresholds: { average: { overbought: 70, oversold: 30 } },
    groups: [
      {
        id: "cross-market",
        label: "Cross-Market",
        rows: ["gold"],
        summary: { mostOverbought: null, mostOversold: null, strongestAverage: null, weakestAverage: null, mtfOverbought: [], mtfOversold: [] },
      },
    ],
    instruments: [
      {
        id: "gold",
        label: "GOLD",
        sourceLabel: "Macro (Yahoo Finance chart)",
        providerSymbol: "GC=F",
        values: { "1W": 61.22, "1D": null, "4h": 52.06, "1h": 27.61 },
        states: { "1W": "weak-bullish", "1D": null, "4h": "neutral", "1h": "bearish" },
        errors: { "1D": "Yahoo Finance HTTP 429" },
        freshness: {},
        average: null,
        averageAvailable: 3,
        averageRequired: 4,
        error: null,
      },
    ],
  };
  const elements = await renderPage(matrix);
  const html = elements["rm-groups"].innerHTML;
  assert.match(html, /rm-cell--na[^>]*>—<\/td>/);
  assert.doesNotMatch(html, />0\.00</);
  assert.match(html, /3\/4/);
  assert.match(html, /GOLD · RSI 14 · 1H · 27\.61 · Bearish momentum/);
  assert.match(html, /GOLD · RSI 14 · 1D · unavailable — Yahoo Finance HTTP 429/);
});

test("the page explains itself and discloses no AI use", () => {
  const page = read("public/rsi-matrix.html");
  assert.ok(page.indexOf("How this page works") > page.indexOf('id="rm-groups"'));
  assert.match(page, /<strong>AI use: No\.<\/strong>/);
});
