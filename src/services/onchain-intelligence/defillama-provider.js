/**
 * DefiLlama provider for On-Chain Intelligence.
 *
 * Uses only DefiLlama's free, keyless public endpoints:
 *   api.llama.fi/v2/historicalChainTvl[/{chain}]  daily TVL series
 *   stablecoins.llama.fi/stablecoincharts/all      daily stablecoin supply
 *   stablecoins.llama.fi/stablecoins               per-asset supply (USDT share)
 *   api.llama.fi/overview/dexs[/{chain}]           DEX volume summaries
 *
 * Every provider returns the same normalized snapshot (see normalizeSnapshot
 * in ./service.js for the shape), so a CryptoQuant / Glassnode / CoinMetrics
 * provider can be added later without touching the Overview UI. Each section
 * is fetched independently: one failing endpoint leaves that section null and
 * is reported in `errors`, it never zeroes the value or sinks the others.
 */

const DAY_SECONDS = 86_400;

// Chains shown in the Chain Activity rows. `llama` is DefiLlama's chain name.
const DEFAULT_CHAINS = [
  { id: "BTC", name: "Bitcoin", llama: "Bitcoin" },
  { id: "ETH", name: "Ethereum", llama: "Ethereum" },
  { id: "SOL", name: "Solana", llama: "Solana" },
];

class DefiLlamaOnchainProvider {
  constructor({
    tvlBaseUrl = "https://api.llama.fi/",
    stablecoinsBaseUrl = "https://stablecoins.llama.fi/",
    chains = DEFAULT_CHAINS,
    requestTimeoutMs = 15_000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.id = "defillama";
    this.attribution = { name: "DefiLlama", url: "https://defillama.com" };
    this.tvlBaseUrl = tvlBaseUrl;
    this.stablecoinsBaseUrl = stablecoinsBaseUrl;
    this.chains = chains;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async fetchSnapshot() {
    const errors = [];
    const attempt = async (label, fn) => {
      try {
        return await fn();
      } catch (error) {
        errors.push(`${label}: ${error.message}`);
        return null;
      }
    };

    const [tvl, stablecoins, usdtSupply, dex, chains] = await Promise.all([
      attempt("DeFi TVL", () => this.fetchTvl()),
      attempt("Stablecoin supply", () => this.fetchStablecoinSupply()),
      attempt("USDT supply", () => this.fetchUsdtSupply()),
      attempt("DEX volume", () => this.fetchDexVolume()),
      Promise.all(
        this.chains.map(async (chain) => ({
          id: chain.id,
          name: chain.name,
          tvl: await attempt(`${chain.name} TVL`, () => this.fetchTvl(chain.llama)),
          // Chains with no tracked DEXs (Bitcoin, today) answer 404 or an empty
          // summary; that is "not available", not an outage worth a warning.
          dex: await this.fetchDexVolume(chain.llama).catch(() => null),
        })),
      ),
    ]);

    if (stablecoins && Number.isFinite(usdtSupply) && stablecoins.current > 0) {
      stablecoins.usdtShare = (usdtSupply / stablecoins.current) * 100;
    }

    return {
      provider: this.id,
      attribution: this.attribution,
      data: {
        tvl,
        stablecoins,
        dex,
        chains: chains.map((chain) => ({
          id: chain.id,
          name: chain.name,
          tvl: chain.tvl?.current ?? null,
          tvlChange1d: chain.tvl?.change1d ?? null,
          tvlChange7d: chain.tvl?.change7d ?? null,
          dexVolume24h: chain.dex?.volume24h ?? null,
          dexChange7d: chain.dex?.change7d ?? null,
        })),
      },
      errors,
    };
  }

  async fetchTvl(chain) {
    const pathname = chain ? `v2/historicalChainTvl/${encodeURIComponent(chain)}` : "v2/historicalChainTvl";
    const payload = await this.requestJson(this.tvlBaseUrl, pathname);
    const series = toSeries(payload, (row) => [row?.date, row?.tvl]);
    return summarizeSeries(series);
  }

  async fetchStablecoinSupply() {
    const payload = await this.requestJson(this.stablecoinsBaseUrl, "stablecoincharts/all");
    const series = toSeries(payload, (row) => [row?.date, sumValues(row?.totalCirculatingUSD)]);
    const summary = summarizeSeries(series);
    return summary ? { ...summary, usdtShare: null } : null;
  }

  async fetchUsdtSupply() {
    const payload = await this.requestJson(this.stablecoinsBaseUrl, "stablecoins?includePrices=false");
    const assets = Array.isArray(payload?.peggedAssets) ? payload.peggedAssets : [];
    const usdt = assets
      .filter((asset) => asset?.symbol === "USDT")
      .map((asset) => Number(asset?.circulating?.peggedUSD))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => b - a)[0];
    return usdt ?? null;
  }

  async fetchDexVolume(chain) {
    const base = chain ? `overview/dexs/${encodeURIComponent(chain)}` : "overview/dexs";
    const payload = await this.requestJson(
      this.tvlBaseUrl,
      `${base}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
    );
    const volume24h = finiteOrNull(payload?.total24h);
    const volume7d = finiteOrNull(payload?.total7d);
    if (volume24h === null && volume7d === null) return null;

    const prior24h = finiteOrNull(payload?.total48hto24h);
    const prior7d = finiteOrNull(payload?.total14dto7d);
    return {
      volume24h,
      volume7d,
      // Derive changes from the raw totals when both sides are present; fall
      // back to DefiLlama's own change fields otherwise.
      change1d: pctChange(volume24h, prior24h) ?? finiteOrNull(payload?.change_1d),
      change7d: pctChange(volume7d, prior7d) ?? finiteOrNull(payload?.change_7dover7d),
    };
  }

  async requestJson(baseUrl, pathname) {
    const url = new URL(pathname, baseUrl);
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`DefiLlama ${response.status} for ${url.pathname}`);
    }
    return response.json();
  }
}

// [[unixSeconds, value], ...] sorted ascending, non-finite rows dropped.
function toSeries(payload, pick) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((row) => {
      const [date, value] = pick(row);
      return [Number(date), Number(value)];
    })
    .filter(([date, value]) => Number.isFinite(date) && Number.isFinite(value) && value > 0)
    .sort((a, b) => a[0] - b[0]);
}

function summarizeSeries(series) {
  if (!series.length) return null;
  const [lastDate, current] = series[series.length - 1];
  return {
    current,
    asOf: new Date(lastDate * 1000).toISOString(),
    change1d: pctChange(current, valueDaysAgo(series, 1)),
    change7d: pctChange(current, valueDaysAgo(series, 7)),
    change30d: pctChange(current, valueDaysAgo(series, 30)),
  };
}

// The latest point at or before `days` before the last point. Returns null
// when the series does not reach back that far, so a short history yields
// "—" rather than a change measured over the wrong window.
function valueDaysAgo(series, days) {
  const target = series[series.length - 1][0] - days * DAY_SECONDS;
  // Allow a few hours of slack: DefiLlama's latest point is often intraday.
  const cutoff = target + DAY_SECONDS / 4;
  for (let i = series.length - 2; i >= 0; i -= 1) {
    if (series[i][0] <= cutoff) {
      return series[i][0] >= target - DAY_SECONDS * 2 ? series[i][1] : null;
    }
  }
  return null;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function sumValues(obj) {
  if (!obj || typeof obj !== "object") return NaN;
  const values = Object.values(obj).map(Number).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : NaN;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { DefiLlamaOnchainProvider, DEFAULT_CHAINS, summarizeSeries, valueDaysAgo };
