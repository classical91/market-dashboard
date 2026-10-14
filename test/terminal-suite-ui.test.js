"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const page = read("public/terminal-suite.html");
const script = read("public/assets/js/terminal-suite.js");

function loadTerminal() {
  const module = { exports: {} };
  vm.runInNewContext(script, { module, console });
  return module.exports;
}

const { buildConfluence, PRESETS } = loadTerminal();

const LIVE_STATE = {
  newsRisk: { level: "low", reason: "No high-impact events on today's calendar.", quality: "live" },
};

function payload({ watchlist, marketState = LIVE_STATE, modules = { macro: "live", calendar: "live" } }) {
  return { watchlist, marketState, dataQuality: { live: true, partial: false, modules } };
}

const FULL = [
  { symbol: "BTC", price: 64000, changePercent: 1.2 },
  { symbol: "ETH", price: 3200, changePercent: 0.8 },
  { symbol: "SPY", price: 520, changePercent: 0.4 },
  { symbol: "QQQ", price: 450, changePercent: 0.6 },
  { symbol: "DXY", price: 27, changePercent: -0.2, proxy: true },
  { symbol: "VIX", price: 15, changePercent: -1 },
  { symbol: "XAU", price: 2300, changePercent: 0.2 },
  { symbol: "WTI", price: 78, changePercent: 0.1 },
];

test("a missing asset is not scored, instead of reading as a bullish 0% move", () => {
  const withoutDxy = FULL.filter((row) => row.symbol !== "DXY");
  const confluence = buildConfluence(payload({ watchlist: withoutDxy }));
  const dxy = confluence.factors.find((f) => f.key === "dxy");

  assert.equal(dxy.points, null);
  assert.equal(dxy.bias, "No data");
  assert.equal(dxy.reading, "No DXY row");
  // Confidence pays for the gap.
  assert.match(confluence.summary, /1 factor without data/);
});

test("with no rows at all there is no score, not a mid-scale one", () => {
  const confluence = buildConfluence(payload({ watchlist: [], marketState: null }));
  assert.equal(confluence.score, null);
  assert.ok(confluence.factors.every((f) => f.points === null));
});

test("calendar risk comes from the Decision Engine's news risk, and only when the calendar is live", () => {
  const high = buildConfluence(payload({
    watchlist: FULL,
    marketState: { newsRisk: { level: "high", reason: "US CPI in 10 min.", quality: "live" } },
  }));
  assert.equal(high.factors.find((f) => f.key === "calendar").points, 1);

  const fallback = buildConfluence(payload({
    watchlist: FULL,
    marketState: { newsRisk: { level: "medium", reason: "2 high-impact events today", quality: "fallback" } },
  }));
  const calendar = fallback.factors.find((f) => f.key === "calendar");
  assert.equal(calendar.points, null, "sample fallback events must not be scored");
  assert.equal(calendar.reading, "Calendar feed not live");
});

test("proxy instruments are labelled as proxies in the factor itself", () => {
  const confluence = buildConfluence(payload({ watchlist: FULL }));
  assert.equal(confluence.factors.find((f) => f.key === "dxy").label, "Dollar (DXY proxy)");
  assert.equal(confluence.factors.find((f) => f.key === "vix").label, "Volatility (VIX)");
});

test("presets still re-weight the same factors", () => {
  const base = buildConfluence(payload({ watchlist: FULL }), PRESETS.default);
  const crypto = buildConfluence(payload({ watchlist: FULL }), PRESETS.cryptoRisk);
  assert.equal(base.factors.length, 6);
  assert.equal(crypto.factors.find((f) => f.key === "crypto").weight, PRESETS.cryptoRisk.weights.crypto);
  assert.equal(crypto.preset.label, "Crypto Risk");
});

test("the confluence no longer carries its own regime label", () => {
  const confluence = buildConfluence(payload({ watchlist: FULL }));
  assert.equal(confluence.label, undefined);
  assert.doesNotMatch(script, /RISK-ON|MIXED \/ NEUTRAL/);
  assert.match(script, /data\.marketState\?\.regime/);
  assert.match(page, /<span>of 100<\/span>/);
});

test("range buttons and the DOM-patching workaround are gone; Terminal shares Overview's snapshot", () => {
  assert.doesNotMatch(page, /terminal-range|terminal-suite-fixes\.js/);
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "public/assets/js/terminal-suite-fixes.js")));
  assert.match(script, /const OVERVIEW_RANGE = "1D"/);
  assert.doesNotMatch(script, /state\.range/);
});

test("dominance only shows when its own feed is live, and fallback calendar rows are not listed", () => {
  assert.match(script, /const dominanceLive = Boolean\(data\.allocation\?\.live\)/);
  assert.match(script, /No live calendar feed/);
});
