"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { OverviewService } = require("../src/services/overview");

const passthroughCache = { getOrLoad: (_key, _ttl, loader) => loader() };

function makeMarketDataStub(overrides = {}) {
  return {
    getCryptoPrices: async () => ({
      live: true,
      source: "coingecko",
      items: [
        { symbol: "BTC", name: "Bitcoin", price: 64000, changePercent: 1.2, volume: "1B" },
        { symbol: "ETH", name: "Ethereum", price: 3200, changePercent: 0.8, volume: "500M" },
      ],
    }),
    getEquities: async () => ({ live: false, source: "fallback", items: [] }),
    getMacro: async () => ({
      live: false,
      source: "fallback",
      items: [{ symbol: "DXY", name: "Dollar Index", price: 104, changePercent: -0.2, type: "macro", proxy: true }],
    }),
    getMarketChart: async () => ({ live: true, source: "coingecko", points: [] }),
    getGlobalDominance: async () => ({ live: true, source: "coingecko", dominance: [] }),
    getNews: async () => ({ live: false, source: "fallback", items: [] }),
    getCalendar: async () => ({ live: true, source: "macro_calendar_url", items: [] }),
    ...overrides,
  };
}

test("overview exposes per-module health statuses", async () => {
  const service = new OverviewService({
    marketDataService: makeMarketDataStub(),
    onchainService: {
      getOverview: async () => ({
        metrics: { stablecoinNetflow: 1000 },
        meta: { source: "defillama-etherscan", note: "Covalent paused." },
      }),
    },
    cache: passthroughCache,
    cacheTtlMs: 0,
  });

  const payload = await service.getOverview("1D");
  assert.deepEqual(payload.dataQuality.modules, {
    crypto: "live",
    equities: "fallback",
    macro: "fallback",
    news: "fallback",
    calendar: "live",
    onchain: "limited",
  });
  // The macro proxy flag survives into the watchlist so the UI can score
  // direction-only for proxy instruments.
  const dxy = payload.watchlist.find((row) => row.symbol === "DXY");
  assert.equal(dxy.proxy, true);
});

test("onchain module reports paused during a Covalent cooldown", async () => {
  const service = new OverviewService({
    marketDataService: makeMarketDataStub(),
    onchainService: {
      getOverview: async () => ({
        metrics: { stablecoinNetflow: 0 },
        meta: { source: "defillama-fallback", note: "Covalent credits exhausted (402)." },
      }),
    },
    cache: passthroughCache,
    cacheTtlMs: 0,
  });

  const payload = await service.getOverview("1D");
  assert.equal(payload.dataQuality.modules.onchain, "paused");
});

test("macro delayed status when serving stale values", async () => {
  const service = new OverviewService({
    marketDataService: makeMarketDataStub({
      getMacro: async () => ({ live: false, stale: true, source: "finnhub-stale", items: [] }),
    }),
    onchainService: null,
    cache: passthroughCache,
    cacheTtlMs: 0,
  });

  const payload = await service.getOverview("1D");
  assert.equal(payload.dataQuality.modules.macro, "delayed");
  assert.equal(payload.dataQuality.modules.onchain, "unavailable");
});
