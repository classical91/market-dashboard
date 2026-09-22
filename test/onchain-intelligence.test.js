"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { DefiLlamaOnchainProvider } = require("../src/services/onchain-intelligence/defillama-provider");
const { OnchainIntelligenceService } = require("../src/services/onchain-intelligence/service");
const { computePulse, liquidityRegime, scoreChange, RULES } = require("../src/services/onchain-intelligence/scoring");
const { MemoryCache } = require("../src/services/cache");

const DAY = 86_400;
const END = 1_760_000_000;

// Daily series ending at END that grows by `dailyPct` per day.
function series(days, start, dailyPct, valueKey = "tvl") {
  return Array.from({ length: days }, (_, i) => ({
    date: END - (days - 1 - i) * DAY,
    [valueKey]: start * (1 + dailyPct / 100) ** i,
  }));
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

// Routes DefiLlama paths to fixtures; anything unrouted is a 404.
function fakeFetch(routes) {
  return async (url) => {
    const key = url.pathname + (url.search || "");
    for (const [prefix, handler] of Object.entries(routes)) {
      if (key === prefix || key.startsWith(prefix + "?")) {
        return typeof handler === "function" ? handler() : jsonResponse(handler);
      }
    }
    return jsonResponse({ message: "not found" }, 404);
  };
}

function healthyRoutes() {
  return {
    "/v2/historicalChainTvl": series(40, 100e9, 0.5),
    "/v2/historicalChainTvl/Bitcoin": series(40, 5e9, 0.1),
    "/v2/historicalChainTvl/Ethereum": series(40, 60e9, -0.1),
    "/v2/historicalChainTvl/Solana": series(40, 8e9, 1),
    "/stablecoincharts/all": series(40, 250e9, 0.1, "x").map((row) => ({
      date: String(row.date),
      totalCirculatingUSD: { peggedUSD: row.x * 0.99, peggedEUR: row.x * 0.01 },
    })),
    "/stablecoins": {
      peggedAssets: [
        { symbol: "USDT", circulating: { peggedUSD: 150e9 } },
        { symbol: "USDC", circulating: { peggedUSD: 60e9 } },
      ],
    },
    "/overview/dexs": { total24h: 8e9, total48hto24h: 7e9, total7d: 60e9, total14dto7d: 45e9 },
    "/overview/dexs/Ethereum": { total24h: 2e9, total7d: 14e9, total14dto7d: 14e9 },
    "/overview/dexs/Solana": { total24h: 3e9, total7d: 20e9, total14dto7d: 16e9 },
  };
}

function provider(routes) {
  return new DefiLlamaOnchainProvider({ fetchImpl: fakeFetch(routes) });
}

test("provider normalizes DefiLlama responses into the shared schema", async () => {
  const { data, errors } = await provider(healthyRoutes()).fetchSnapshot();
  assert.deepEqual(errors, []);

  assert.ok(Math.abs(data.tvl.change1d - 0.5) < 1e-9);
  assert.ok(Math.abs(data.tvl.change7d - (1.005 ** 7 - 1) * 100) < 1e-9);
  assert.ok(data.stablecoins.current > 0);
  // USDT share is USDT supply over total stablecoin supply.
  assert.ok(Math.abs(data.stablecoins.usdtShare - (150e9 / data.stablecoins.current) * 100) < 1e-9);
  assert.ok(Math.abs(data.dex.change7d - (60 / 45 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(data.dex.change1d - (8 / 7 - 1) * 100) < 1e-9);

  const btc = data.chains.find((row) => row.id === "BTC");
  assert.equal(btc.dexVolume24h, null, "Bitcoin has no DEX summary; it stays null, not 0");
  assert.ok(btc.tvl > 0);
});

test("changes stay null when history is too short", async () => {
  const routes = healthyRoutes();
  routes["/v2/historicalChainTvl"] = series(3, 100e9, 1);
  const { data } = await provider(routes).fetchSnapshot();
  assert.ok(Number.isFinite(data.tvl.change1d));
  assert.equal(data.tvl.change7d, null);
  assert.equal(data.tvl.change30d, null);
});

test("a failing endpoint nulls only its section and is reported", async () => {
  const routes = healthyRoutes();
  routes["/overview/dexs"] = () => jsonResponse({}, 500);
  const { data, errors } = await provider(routes).fetchSnapshot();
  assert.equal(data.dex, null);
  assert.ok(data.tvl);
  assert.ok(errors.some((e) => e.startsWith("DEX volume")));
});

test("scoring rules are deterministic and symmetric", () => {
  const rule = RULES.components.tvl;
  assert.equal(scoreChange(0, rule), 0);
  assert.equal(scoreChange(rule.neutral, rule), 1);
  assert.equal(scoreChange(-rule.strong, rule), -2);
  assert.equal(scoreChange(null, rule), null);

  const up = computePulse({ stablecoins: { change7d: 2 }, tvl: { change7d: 10 }, dex: { change7d: 30 } });
  assert.equal(up.score, 6);
  assert.equal(up.maxScore, 6);
  assert.equal(up.label, "Strong Expansion");
  assert.equal(up.state, "EXPANDING");

  const mild = computePulse({ stablecoins: { change7d: 0.6 }, tvl: { change7d: 3.5 }, dex: { change7d: 0 } });
  assert.equal(mild.label, "Expansion");

  const down = computePulse({ stablecoins: { change7d: -0.6 }, tvl: { change7d: -4 }, dex: { change7d: -12 } });
  assert.equal(down.label, "Contraction");
  assert.equal(down.state, "CONTRACTING");

  const flat = computePulse({ stablecoins: { change7d: 0.1 }, tvl: { change7d: -1 }, dex: null });
  assert.equal(flat.label, "Neutral");
  assert.equal(flat.maxScore, 4, "max scales with the components actually scored");

  const thin = computePulse({ stablecoins: { change7d: 5 }, tvl: null, dex: null });
  assert.equal(thin.label, null, "one component is not enough for a pulse");
  assert.equal(thin.maxScore, null);
});

test("liquidity regime falls back to 30D when 7D is missing", () => {
  assert.deepEqual(liquidityRegime({ change7d: 0.7 }), { regime: "EXPANDING", basis: "7d" });
  assert.deepEqual(liquidityRegime({ change7d: null, change30d: -2 }), { regime: "CONTRACTING", basis: "30d" });
  assert.deepEqual(liquidityRegime(null), { regime: null, basis: null });
});

test("service reports LIVE, then CACHED, then STALE across a provider outage", async () => {
  let clock = Date.UTC(2026, 8, 22, 12);
  let routes = healthyRoutes();
  const service = new OnchainIntelligenceService({
    provider: new DefiLlamaOnchainProvider({ fetchImpl: (url) => fakeFetch(routes)(url) }),
    cache: new MemoryCache(),
    cacheTtlMs: 0,
    failureCacheTtlMs: 0,
    staleAfterMs: 60 * 60 * 1000,
    now: () => clock,
  });

  const live = await service.getIntelligence();
  assert.equal(live.status, "LIVE");
  assert.equal(live.attribution.name, "DefiLlama");
  assert.ok(live.pulse.label);
  const liveTvl = live.metrics.tvl.current;

  routes = {};
  clock += 10 * 60 * 1000;
  const cached = await service.getIntelligence();
  assert.equal(cached.status, "CACHED");
  assert.equal(cached.metrics.tvl.current, liveTvl, "last good value is preserved");
  assert.ok(cached.errors.length > 0);

  clock += 2 * 60 * 60 * 1000;
  const stale = await service.getIntelligence();
  assert.equal(stale.status, "STALE");
  assert.equal(stale.metrics.tvl.current, liveTvl);
});

test("service is UNAVAILABLE with null metrics when nothing was ever fetched", async () => {
  const service = new OnchainIntelligenceService({
    provider: { id: "defillama", attribution: { name: "DefiLlama" }, fetchSnapshot: async () => { throw new Error("down"); } },
    cache: new MemoryCache(),
    cacheTtlMs: 0,
    failureCacheTtlMs: 0,
  });
  const payload = await service.getIntelligence();
  assert.equal(payload.status, "UNAVAILABLE");
  assert.equal(payload.metrics.tvl, null);
  assert.equal(payload.pulse.label, null);
  assert.deepEqual(payload.chains, []);
});

test("a chain whose TVL fetch fails keeps its previous value, flagged", async () => {
  let routes = healthyRoutes();
  const service = new OnchainIntelligenceService({
    provider: new DefiLlamaOnchainProvider({ fetchImpl: (url) => fakeFetch(routes)(url) }),
    cache: new MemoryCache(),
    cacheTtlMs: 0,
    failureCacheTtlMs: 0,
  });
  const first = await service.getIntelligence();
  const solTvl = first.chains.find((row) => row.id === "SOL").tvl;

  routes = healthyRoutes();
  delete routes["/v2/historicalChainTvl/Solana"];
  const second = await service.getIntelligence();
  const sol = second.chains.find((row) => row.id === "SOL");
  assert.equal(sol.tvl, solTvl);
  assert.equal(sol.tvlCarried, true);
  assert.equal(second.chains.find((row) => row.id === "ETH").tvlCarried, false);
});

test("the persisted last good dataset survives a restart", async () => {
  const saved = new Map();
  const store = { get: (k) => saved.get(k) ?? null, set: (k, v) => saved.set(k, JSON.parse(JSON.stringify(v))) };
  const make = (routes) =>
    new OnchainIntelligenceService({
      provider: new DefiLlamaOnchainProvider({ fetchImpl: fakeFetch(routes) }),
      cache: new MemoryCache(),
      store,
      cacheTtlMs: 0,
      failureCacheTtlMs: 0,
    });

  const live = await make(healthyRoutes()).getIntelligence();
  const restarted = await make({}).getIntelligence();
  assert.equal(restarted.status, "CACHED");
  assert.equal(restarted.metrics.stablecoins.current, live.metrics.stablecoins.current);
});
