"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { buildMarketState } = require("../src/services/market-state");
const { buildRegime, DecisionEngineService } = require("../src/services/decision-engine");
const { OverviewService } = require("../src/services/overview");

const passthroughCache = { getOrLoad: (_key, _ttl, loader) => loader() };

const CRYPTO = {
  live: true,
  items: [
    { symbol: "BTC", price: 64000, changePercent: 2.4 },
    { symbol: "ETH", price: 3200, changePercent: 1.8 },
    { symbol: "SOL", price: 150, changePercent: 3.1 },
  ],
};
const EQUITIES = {
  live: true,
  items: [
    { symbol: "SPY", price: 520, changePercent: 0.9 },
    { symbol: "QQQ", price: 450, changePercent: 1.2 },
  ],
};
const MACRO = {
  live: true,
  items: [
    { symbol: "DXY", price: 27.1, changePercent: -0.3, proxy: true },
    { symbol: "VIX", price: 14.2, changePercent: -4 },
    { symbol: "XAU", price: 2300, changePercent: 0.1 },
    { symbol: "WTI", price: 78, changePercent: -0.5 },
  ],
};
const CALENDAR = { live: true, items: [] };

test("the canonical regime is exactly the Decision Engine's regime", () => {
  const state = buildMarketState({ crypto: CRYPTO, equities: EQUITIES, macro: MACRO, calendar: CALENDAR });
  const expected = buildRegime({ crypto: CRYPTO.items, equities: EQUITIES.items, macro: MACRO.items });

  assert.equal(state.source, "decision-engine");
  for (const key of ["label", "score", "weighted", "volatility", "inputsUsed", "summary"]) {
    assert.deepEqual(state.regime[key], expected[key], `${key} must match buildRegime`);
  }
  assert.deepEqual(state.regime.modifiers, expected.modifiers);
  // Components keep buildRegime's numbers; quality is an annotation only.
  assert.deepEqual(
    state.regime.components.map(({ name, symbol, weight, vote }) => ({ name, symbol, weight, vote })),
    expected.components.map(({ name, symbol, weight, vote }) => ({ name, symbol, weight, vote })),
  );
});

test("each input says where it came from, and a proxy never reads as live", () => {
  const state = buildMarketState({ crypto: CRYPTO, equities: EQUITIES, macro: MACRO, calendar: CALENDAR });
  const quality = Object.fromEntries(state.regime.components.map((c) => [c.symbol, c.quality]));

  assert.equal(quality.BTC, "live");
  assert.equal(quality.AVG, "live");
  assert.equal(quality.SPY, "live");
  assert.equal(quality.VIX, "live");
  assert.equal(quality.DXY, "proxy");
  assert.deepEqual(state.dataQuality.proxyInputs, ["DXY"]);
  assert.equal(state.dataQuality.degraded, false);
});

test("fallback feeds are flagged, and the state is marked degraded", () => {
  const state = buildMarketState({
    crypto: { ...CRYPTO, live: false, stale: true },
    equities: { ...EQUITIES, live: false },
    macro: MACRO,
    calendar: { live: false, items: [] },
  });
  const quality = Object.fromEntries(state.regime.components.map((c) => [c.symbol, c.quality]));

  assert.equal(quality.BTC, "delayed");
  assert.equal(quality.SPY, "fallback");
  assert.equal(quality.QQQ, "fallback");
  assert.deepEqual(state.dataQuality.fallbackInputs, ["SPY", "QQQ"]);
  assert.equal(state.dataQuality.degraded, true);
  assert.equal(state.dataQuality.modules.calendar, "fallback");
  assert.equal(state.newsRisk.quality, "fallback");
  assert.ok(state.dataQuality.warnings.some((w) => /fallback data for SPY, QQQ/.test(w)));
});

test("missing feeds leave inputs out instead of inventing them", () => {
  const state = buildMarketState({ crypto: CRYPTO });
  const symbols = state.regime.components.map((c) => c.symbol);

  assert.deepEqual(symbols, ["BTC", "AVG"]);
  assert.equal(state.dataQuality.modules.equities, "unavailable");
  assert.equal(state.dataQuality.modules.macro, "unavailable");
});

test("no inputs at all is Unknown, not a neutral-looking regime", () => {
  const state = buildMarketState({});
  assert.equal(state.regime.label, "Unknown");
  assert.equal(state.regime.inputsUsed, 0);
  assert.equal(state.dataQuality.degraded, true);
});

test("Overview and the Decision Engine give the same regime for the same feeds", async () => {
  const marketDataService = {
    getCryptoPrices: async () => CRYPTO,
    getEquities: async () => EQUITIES,
    getMacro: async () => MACRO,
    getCalendar: async () => CALENDAR,
    getMarketChart: async () => ({ live: true, points: [] }),
    getGlobalDominance: async () => ({ live: true, dominance: [] }),
    getNews: async () => ({ live: false, items: [] }),
  };
  const overview = await new OverviewService({ marketDataService, cache: passthroughCache, cacheTtlMs: 0 }).getOverview("1D");
  const decision = await new DecisionEngineService({
    marketDataService,
    signalScreenerService: { scanAll: async () => [], getCandles: async () => [] },
    cache: passthroughCache,
    cacheTtlMs: 0,
  }).getDecision("4h");

  assert.ok(overview.marketState, "the overview payload carries the canonical market state");
  assert.equal(overview.marketState.regime.label, decision.regime.label);
  assert.equal(overview.marketState.regime.score, decision.regime.score);
  assert.deepEqual(overview.marketState.regime.modifiers, decision.regime.modifiers);
  assert.equal(overview.marketState.newsRisk.level, decision.newsRisk.level);
});
