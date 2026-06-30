const { createServiceError } = require("../utils/errors");

const DEFAULT_CRYPTOS = [
  { symbol: "BTC", id: "bitcoin", name: "Bitcoin" },
  { symbol: "ETH", id: "ethereum", name: "Ethereum" },
  { symbol: "SOL", id: "solana", name: "Solana" },
  { symbol: "BNB", id: "binancecoin", name: "BNB" },
  { symbol: "XRP", id: "ripple", name: "XRP" },
  { symbol: "ADA", id: "cardano", name: "Cardano" },
  { symbol: "DOGE", id: "dogecoin", name: "Dogecoin" },
  { symbol: "AVAX", id: "avalanche-2", name: "Avalanche" },
];

const FALLBACK_EQUITIES = [
  { symbol: "SPY", name: "S&P 500 ETF", price: 522.18, changePercent: 0.38, volume: "74.1M" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", price: 448.72, changePercent: 0.61, volume: "51.8M" },
  { symbol: "NVDA", name: "Nvidia", price: 884.55, changePercent: 3.12, volume: "49.7M" },
  { symbol: "TSLA", name: "Tesla", price: 173.42, changePercent: -1.26, volume: "92.4M" },
];

const FALLBACK_MACRO = [
  { symbol: "XAU", name: "Gold", price: 2342.9, changePercent: -0.24, volume: "High" },
  { symbol: "DXY", name: "Dollar Index", price: 104.12, changePercent: -0.31, volume: "High" },
  { symbol: "WTI", name: "Crude Oil", price: 78.44, changePercent: 0.88, volume: "Med" },
  { symbol: "VIX", name: "Volatility Index", price: 14.72, changePercent: -2.08, volume: "Med" },
];

const FALLBACK_NEWS = [
  {
    title: "Bitcoin trades in tight range as traders await Fed signal",
    source: "Fallback Feed",
    url: null,
    publishedAt: null,
  },
  {
    title: "Stablecoin supply expansion remains a key risk barometer",
    source: "Fallback Feed",
    url: null,
    publishedAt: null,
  },
  {
    title: "Semiconductor basket continues to lead broad equity advance",
    source: "Fallback Feed",
    url: null,
    publishedAt: null,
  },
];

const FALLBACK_CALENDAR = [
  { time: "08:30", title: "US CPI Inflation", impact: "High" },
  { time: "10:00", title: "Consumer Sentiment", impact: "Medium" },
  { time: "14:00", title: "Fed Speaker", impact: "High" },
  { time: "16:30", title: "Oil Inventories", impact: "Medium" },
];

const RANGE_TO_DAYS = { "1D": 1, "1W": 7, "1M": 30, "3M": 90 };

class MarketDataService {
  constructor(config = {}) {
    const coingeckoKey =
      config.coingeckoApiKey || process.env.COINGECKO_API_KEY || process.env.COINGECKO_DEMO_API_KEY || "";
    this.config = {
      provider: config.provider || process.env.MARKET_DATA_PROVIDER || "coingecko",
      apiKey: config.apiKey || process.env.MARKET_DATA_API_KEY || "",
      coingeckoApiKey: coingeckoKey,
      coingeckoKeyHeader:
        config.coingeckoKeyHeader ||
        process.env.COINGECKO_KEY_HEADER ||
        (process.env.COINGECKO_API_KEY ? "x-cg-pro-api-key" : "x-cg-demo-api-key"),
      baseUrl:
        config.baseUrl || process.env.MARKET_DATA_BASE_URL || "https://api.coingecko.com/api/v3",
      requestTimeoutMs: Number(config.requestTimeoutMs || process.env.MARKET_DATA_TIMEOUT_MS || 8000),
      retryCount: Number(config.retryCount || process.env.MARKET_DATA_RETRIES || 1),
      newsUrl: config.newsUrl || process.env.MARKET_NEWS_URL || "",
      finnhubApiKey: config.finnhubApiKey || process.env.FINNHUB_API_KEY || "",
      finnhubBaseUrl: config.finnhubBaseUrl || process.env.FINNHUB_BASE_URL || "https://finnhub.io/api/v1",
    };
    // Last-known-good live responses, keyed per data type, so a transient
    // CoinGecko rate-limit (429) serves slightly stale real data instead of
    // overwriting the dashboard with static seed values.
    this.lastGood = new Map();
  }

  rememberGood(key, value) {
    this.lastGood.set(key, { value, storedAt: Date.now() });
  }

  recallGood(key) {
    const entry = this.lastGood.get(key);
    return entry ? entry.value : null;
  }

  hasLiveCryptoSource() {
    return this.config.provider === "coingecko";
  }

  hasLiveEquitySource() {
    return Boolean(this.config.finnhubApiKey);
  }

  async getCryptoPrices(symbols = DEFAULT_CRYPTOS) {
    if (this.config.provider !== "coingecko") {
      return { live: false, source: "fallback", items: fallbackCrypto(symbols) };
    }

    const ids = symbols.map((entry) => entry.id).join(",");
    const cacheKey = `crypto:${ids}`;
    const url = `${this.config.baseUrl}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(
      ids,
    )}&price_change_percentage=24h&per_page=${symbols.length}&page=1`;

    try {
      const data = await this.fetchJson(url);
      if (!Array.isArray(data)) {
        return this.staleOr(cacheKey, { live: false, source: "fallback", items: fallbackCrypto(symbols) });
      }
      const byId = new Map(data.map((row) => [row.id, row]));
      const items = symbols.map((entry) => {
        const row = byId.get(entry.id);
        if (!row) {
          return fallbackCryptoOne(entry);
        }
        return {
          symbol: entry.symbol,
          name: entry.name,
          price: Number(row.current_price ?? 0),
          changePercent: Number(row.price_change_percentage_24h ?? 0),
          volume: formatVolume(row.total_volume),
          marketCap: Number(row.market_cap ?? 0),
        };
      });
      const result = { live: true, source: "coingecko", items };
      this.rememberGood(cacheKey, result);
      return result;
    } catch (error) {
      return this.staleOr(
        cacheKey,
        { live: false, source: "fallback", items: fallbackCrypto(symbols) },
        error,
      );
    }
  }

  // Serve the last live response (marked stale) when a fresh fetch fails;
  // otherwise fall back to the static seed payload.
  staleOr(cacheKey, fallback, error) {
    const good = this.recallGood(cacheKey);
    if (good) {
      return { ...good, live: false, stale: true, source: "coingecko-stale", error: error?.message };
    }
    return error ? { ...fallback, error: error.message } : fallback;
  }

  async getGlobalDominance() {
    if (this.config.provider !== "coingecko") {
      return { live: false, source: "fallback", dominance: defaultDominance() };
    }
    try {
      const data = await this.fetchJson(`${this.config.baseUrl}/global`);
      const pct = data?.data?.market_cap_percentage || {};
      const totalMcap = Number(data?.data?.total_market_cap?.usd || 0);
      const totalVolume = Number(data?.data?.total_volume?.usd || 0);
      const dominance = Object.entries(pct)
        .map(([symbol, value]) => ({ symbol: symbol.toUpperCase(), percent: Number(value) }))
        .sort((a, b) => b.percent - a.percent);
      const result = { live: true, source: "coingecko", dominance, totalMcap, totalVolume };
      this.rememberGood("global", result);
      return result;
    } catch (error) {
      return this.staleOr(
        "global",
        { live: false, source: "fallback", dominance: defaultDominance() },
        error,
      );
    }
  }

  async getMarketChart(range = "1D", coinId = "bitcoin") {
    const days = RANGE_TO_DAYS[range] || 1;
    if (this.config.provider !== "coingecko") {
      return { live: false, source: "fallback", points: fallbackChartPoints(range) };
    }
    const cacheKey = `chart:${coinId}:${days}`;
    try {
      const url = `${this.config.baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
      const data = await this.fetchJson(url);
      const prices = Array.isArray(data?.prices) ? data.prices : [];
      if (!prices.length) {
        return this.staleOr(cacheKey, { live: false, source: "fallback", points: fallbackChartPoints(range) });
      }
      const sampled = sampleSeries(prices, 30);
      const first = sampled[0][1];
      const points = sampled.map(([ts, value]) => ({
        time: new Date(ts).toISOString(),
        value: Number(((value / first) * 100).toFixed(3)),
      }));
      const result = { live: true, source: "coingecko", points };
      this.rememberGood(cacheKey, result);
      return result;
    } catch (error) {
      return this.staleOr(
        cacheKey,
        { live: false, source: "fallback", points: fallbackChartPoints(range) },
        error,
      );
    }
  }

  async getEquities() {
    if (!this.config.finnhubApiKey) {
      return {
        live: false,
        source: "fallback",
        items: FALLBACK_EQUITIES.map((entry) => ({ ...entry, type: "equity" })),
      };
    }
    let firstError = null;
    let liveCount = 0;
    const items = await Promise.all(
      FALLBACK_EQUITIES.map(async (entry) => {
        try {
          const url = `${this.config.finnhubBaseUrl}/quote?symbol=${encodeURIComponent(
            entry.symbol,
          )}&token=${encodeURIComponent(this.config.finnhubApiKey)}`;
          const data = await this.singleFetch(url, { Accept: "application/json" });
          const price = Number(data?.c ?? 0);
          if (!price) {
            return { ...entry, type: "equity" };
          }
          liveCount += 1;
          return {
            symbol: entry.symbol,
            name: entry.name,
            price,
            changePercent: Number(data?.dp ?? 0),
            volume: "-",
            type: "equity",
          };
        } catch (error) {
          if (!firstError) firstError = error;
          return { ...entry, type: "equity" };
        }
      }),
    );
    return {
      live: liveCount > 0,
      source: liveCount > 0 ? "finnhub" : "fallback",
      items,
      error: liveCount === 0 && firstError ? firstError.message : undefined,
    };
  }

  async getMacro() {
    return {
      live: false,
      source: "fallback",
      items: FALLBACK_MACRO.map((entry) => ({ ...entry, type: "macro" })),
    };
  }

  async getNews() {
    const url = this.config.newsUrl;
    if (!url) {
      return { live: false, source: "fallback", items: FALLBACK_NEWS.map((item) => ({ ...item })) };
    }
    try {
      const data = await this.singleFetch(url, { Accept: "application/json" }, "News feed");
      const items = normalizeNews(data);
      if (!items.length) {
        return { live: false, source: "fallback", items: FALLBACK_NEWS.map((item) => ({ ...item })) };
      }
      return { live: true, source: "market_news_url", items };
    } catch (error) {
      return {
        live: false,
        source: "fallback",
        items: FALLBACK_NEWS.map((item) => ({ ...item })),
        error: error.message,
      };
    }
  }

  async getCalendar() {
    return {
      live: false,
      source: "fallback",
      items: FALLBACK_CALENDAR.map((item) => ({ ...item })),
    };
  }

  async fetchJson(url) {
    const headers = { Accept: "application/json" };
    if (this.config.coingeckoApiKey && url.startsWith(this.config.baseUrl)) {
      headers[this.config.coingeckoKeyHeader] = this.config.coingeckoApiKey;
    }
    const maxAttempts = Math.max(1, this.config.retryCount + 1);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.singleFetch(url, headers);
      } catch (error) {
        lastError = error;
        const status = error.statusCode || error.status || 0;
        const transient = status === 429 || status >= 500 || error.name === "AbortError";
        if (!transient || attempt === maxAttempts) break;
        // Honor the server's Retry-After on 429 when present, but cap it so a
        // long header value can't stall the request past a sensible budget.
        const wait = Math.min(error.retryAfterMs ?? 400 * attempt, 2000);
        await sleep(wait);
      }
    }
    throw lastError;
  }

  async singleFetch(url, headers, label = "CoinGecko") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const detail = payload?.error || payload?.status?.error_message || text.slice(0, 120) || response.statusText;
        const error = createServiceError(
          `${label} HTTP ${response.status} ${detail}`,
          response.status,
        );
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfterMs != null) {
          error.retryAfterMs = retryAfterMs;
        }
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw createServiceError(
          `${label} request timed out after ${this.config.requestTimeoutMs}ms`,
          408,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

// Normalize a variety of news-feed JSON shapes (NewsAPI, Finnhub, generic
// arrays, {items|results|data:[...]}) into the dashboard's news item shape.
function normalizeNews(data) {
  const rows = Array.isArray(data)
    ? data
    : data?.articles || data?.items || data?.results || data?.data || [];
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const title = String(row.title || row.headline || row.name || "").trim();
      if (!title) return null;
      const sourceRaw =
        (row.source && (row.source.name || row.source.title || row.source)) ||
        row.author ||
        row.provider ||
        "News";
      const urlRaw = row.url || row.link || row.guid || null;
      const publishedAt =
        row.publishedAt || row.published_at || row.pubDate || row.datetime || row.date || null;
      return {
        title,
        source: String(sourceRaw).slice(0, 80),
        url: typeof urlRaw === "string" ? urlRaw : null,
        publishedAt: normalizePublishedAt(publishedAt),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizePublishedAt(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fallbackCrypto(symbols) {
  return symbols.map(fallbackCryptoOne);
}

function fallbackCryptoOne(entry) {
  const seeds = {
    BTC: { price: 64280, changePercent: 2.84, volume: "38.2B" },
    ETH: { price: 3188, changePercent: 1.42, volume: "18.6B" },
    SOL: { price: 152.4, changePercent: 2.1, volume: "2.6B" },
    BNB: { price: 588.3, changePercent: 0.4, volume: "1.4B" },
    XRP: { price: 0.52, changePercent: -0.6, volume: "1.1B" },
    ADA: { price: 0.45, changePercent: -1.1, volume: "420M" },
    DOGE: { price: 0.16, changePercent: 0.9, volume: "780M" },
    AVAX: { price: 35.7, changePercent: 1.8, volume: "320M" },
  };
  const seed = seeds[entry.symbol] || { price: 0, changePercent: 0, volume: "-" };
  return {
    symbol: entry.symbol,
    name: entry.name,
    price: seed.price,
    changePercent: seed.changePercent,
    volume: seed.volume,
    marketCap: 0,
  };
}

function defaultDominance() {
  return [
    { symbol: "BTC", percent: 52 },
    { symbol: "ETH", percent: 17 },
    { symbol: "USDT", percent: 6 },
    { symbol: "BNB", percent: 3 },
    { symbol: "SOL", percent: 3 },
  ];
}

function fallbackChartPoints(range) {
  const sets = {
    "1D": [100, 100.4, 100.7, 101.1, 101.0, 101.5, 102.0, 101.7, 102.3, 102.8],
    "1W": [100, 98.6, 99.3, 101.1, 100.8, 103, 102.4, 104.7, 105.2, 106.5],
    "1M": [100, 102, 101.3, 104, 103.8, 105.9, 108.2, 107.3, 110.4, 112.8],
    "3M": [100, 96, 98, 101, 99, 106, 108, 111, 109, 116],
  };
  const values = sets[range] || sets["1D"];
  const now = Date.now();
  const step = (RANGE_TO_DAYS[range] || 1) * 86400 * 1000 / values.length;
  return values.map((value, index) => ({
    time: new Date(now - (values.length - 1 - index) * step).toISOString(),
    value,
  }));
}

function sampleSeries(rows, maxPoints) {
  if (rows.length <= maxPoints) {
    return rows;
  }
  const step = Math.max(1, Math.floor(rows.length / maxPoints));
  const sampled = [];
  for (let i = 0; i < rows.length; i += step) {
    sampled.push(rows[i]);
  }
  if (sampled[sampled.length - 1] !== rows[rows.length - 1]) {
    sampled.push(rows[rows.length - 1]);
  }
  return sampled;
}

function formatVolume(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(Math.round(n));
}

module.exports = { MarketDataService, DEFAULT_CRYPTOS, RANGE_TO_DAYS };
