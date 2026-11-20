"use strict";

// Resolves the dashboard's supported assets (BTC, ETH, SOL) to the symbols
// KuCoin actually lists, from KuCoin's public instrument metadata:
//
//   GET https://api.kucoin.com/api/ua/v2/market/instrument?tradeType=SPOT
//   GET https://api.kucoin.com/api/ua/v2/market/instrument?tradeType=FUTURES
//
// Spot and futures names differ (BTC-USDT vs XBTUSDTM), and the futures
// contract multiplier (`unitSize`: 0.001 BTC, 0.01 ETH, 0.1 SOL per contract
// at the time of writing) is read from the exchange, never hard-coded.

const SUPPORTED_ASSETS = Object.freeze(["BTC", "ETH", "SOL"]);
// KuCoin futures still name bitcoin XBT.
const FUTURES_BASE_ALIASES = Object.freeze({ BTC: ["XBT", "BTC"] });
const QUOTE = "USDT";
const DEFAULT_BASE_URL = "https://api.kucoin.com";
const INSTRUMENT_PATH = "/api/ua/v2/market/instrument";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function spotCandidates(list, asset) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && item.baseCurrency === asset && item.quoteCurrency === QUOTE && item.tradingStatus === "TradingEnabled")
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
}

function futuresCandidates(list, asset) {
  const aliases = FUTURES_BASE_ALIASES[asset] || [asset];
  return (Array.isArray(list) ? list : [])
    .filter((item) => item
      && aliases.includes(item.baseCurrency)
      && item.quoteCurrency === QUOTE
      && item.settlementCurrency === QUOTE
      && item.isInverse === false
      // Perpetual only: delivery contracts carry their own expiry and basis.
      && String(item.contractType) === "0"
      && item.tradingStatus === "Open"
      && num(item.unitSize) > 0)
    .sort((a, b) => aliases.indexOf(a.baseCurrency) - aliases.indexOf(b.baseCurrency)
      || String(a.symbol).localeCompare(String(b.symbol)));
}

function toSpotInstrument(item, asset, fetchedAt) {
  return {
    marketType: "spot",
    asset,
    symbol: item.symbol,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency,
    settlementCurrency: null,
    multiplier: 1,
    multiplierText: "1",
    quantityUnit: item.baseCurrency,
    tickSize: item.tickSize != null ? String(item.tickSize) : null,
    lotSize: item.baseOrderStep != null ? String(item.baseOrderStep) : null,
    isInverse: false,
    contractType: null,
    tradingStatus: item.tradingStatus,
    fetchedAt,
  };
}

function toFuturesInstrument(item, asset, fetchedAt) {
  return {
    marketType: "futures",
    asset,
    symbol: item.symbol,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency,
    settlementCurrency: item.settlementCurrency,
    multiplier: num(item.unitSize),
    multiplierText: String(item.unitSize),
    quantityUnit: "contracts",
    tickSize: item.tickSize != null ? String(item.tickSize) : null,
    lotSize: item.lotSize != null ? String(item.lotSize) : null,
    isInverse: item.isInverse === true,
    contractType: String(item.contractType),
    tradingStatus: item.tradingStatus,
    fetchedAt,
  };
}

/** Pure resolution over the two instrument lists; exported for tests. */
function resolveInstruments({ spotList, futuresList, assets = SUPPORTED_ASSETS, fetchedAt = Date.now() }) {
  const result = { spot: {}, futures: {}, missing: [], fetchedAt };
  for (const asset of assets) {
    const spot = spotCandidates(spotList, asset)[0];
    if (spot) result.spot[asset] = toSpotInstrument(spot, asset, fetchedAt);
    else result.missing.push({ marketType: "spot", asset });
    const futures = futuresCandidates(futuresList, asset)[0];
    if (futures) result.futures[asset] = toFuturesInstrument(futures, asset, fetchedAt);
    else result.missing.push({ marketType: "futures", asset });
  }
  return result;
}

class KucoinInstrumentRegistry {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, ttlMs = 60 * 60 * 1000, timeoutMs = 10000, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.current = null;
    this.loading = null;
    this.lastError = null;
    this.lastAttemptAt = null;
  }

  async fetchList(tradeType) {
    const url = `${this.baseUrl}${INSTRUMENT_PATH}?tradeType=${tradeType}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`KuCoin instrument ${tradeType} HTTP ${res.status}`);
    const body = await res.json();
    if (!body || body.code !== "200000" || !body.data || !Array.isArray(body.data.list)) {
      throw new Error(`KuCoin instrument ${tradeType} returned code ${body && body.code}`);
    }
    return body.data.list;
  }

  async refresh() {
    this.lastAttemptAt = this.now();
    try {
      const [spotList, futuresList] = await Promise.all([this.fetchList("SPOT"), this.fetchList("FUTURES")]);
      this.current = resolveInstruments({ spotList, futuresList, fetchedAt: this.now() });
      this.lastError = null;
      return this.current;
    } catch (err) {
      this.lastError = err.message;
      // Keep serving the last good resolution; symbol names and multipliers
      // change rarely, and a transient REST failure must not drop live feeds.
      if (this.current) return this.current;
      throw err;
    }
  }

  async load({ force = false } = {}) {
    const fresh = this.current && this.now() - this.current.fetchedAt < this.ttlMs;
    if (!force && this.current && fresh) return this.current;
    if (!force && this.current && this.loading == null) {
      // Stale but usable: refresh in the background, answer immediately.
      this.loading = this.refresh().finally(() => { this.loading = null; });
      this.loading.catch(() => {});
      return this.current;
    }
    if (!this.loading) this.loading = this.refresh().finally(() => { this.loading = null; });
    return this.loading;
  }

  async get(marketType, asset) {
    const resolved = await this.load();
    const instrument = resolved[marketType] && resolved[marketType][asset];
    if (!instrument) {
      const err = new Error(`KuCoin lists no supported ${marketType} instrument for ${asset}`);
      err.statusCode = 404;
      throw err;
    }
    return instrument;
  }

  status() {
    return {
      loaded: Boolean(this.current),
      fetchedAt: this.current ? this.current.fetchedAt : null,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  SUPPORTED_ASSETS,
  FUTURES_BASE_ALIASES,
  INSTRUMENT_PATH,
  KucoinInstrumentRegistry,
  resolveInstruments,
  spotCandidates,
  futuresCandidates,
};
