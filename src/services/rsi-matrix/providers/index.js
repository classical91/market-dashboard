"use strict";

// The RSI Matrix's provider catalogue.
//
// A matrix instrument is never "just a symbol": it is a display label, a
// provider, and the symbol *that provider* understands. TradingView notation
// (MEXC:MXUSDT, CRYPTOCAP:USDT), dashboard notation (MXUSDT) and the upstream
// API's own spelling (MX_USDT, USDD-USDC, ^GSPC) stay separate, and each
// provider owns the rule for what its own symbols look like.
//
// Static definitions (label, kind, symbol rule) are importable without any
// dependencies so the settings store can validate a row without constructing
// network clients; createProviders() attaches the live fetchers.

const { createServiceError } = require("../../../utils/errors");
const { BinanceSpotProvider, BinanceFuturesProvider } = require("./binance");
const { MexcProvider, KucoinProvider, CoinbaseProvider, KrakenProvider, PoloniexProvider } = require("./exchanges");
const { YahooChartProvider } = require("./yahoo");
const { CoinGeckoMarketCapProvider } = require("./coingecko");
const { DominanceHistoryProvider } = require("./dominance");

// TradingView-only spellings. A synthetic index sent to an exchange would be a
// permanently failing request at best, and at worst a different market that
// happens to share the ticker — so they are refused everywhere except the
// providers built for them.
const SYNTHETIC_PATTERN = /^(?:[A-Z0-9]{2,10}\.D|TOTAL[23]?|TOTALES|OTHERS)$/;

function looksSynthetic(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  return s.includes(":") || SYNTHETIC_PATTERN.test(s) || /\.D$/.test(s);
}

function rule(pattern, hint, { upper = true } = {}) {
  return (raw) => {
    const trimmed = String(raw == null ? "" : raw).trim();
    const symbol = upper ? trimmed.toUpperCase() : trimmed.toLowerCase();
    if (!symbol) throw createServiceError("A provider symbol is required", 400);
    if (symbol.includes(":")) {
      throw createServiceError(
        `"${symbol}" is TradingView notation. Choose the source in the Provider field and enter only its symbol (e.g. ${hint}).`,
        400,
      );
    }
    if (looksSynthetic(symbol)) {
      throw createServiceError(
        `"${symbol}" is a synthetic index, not a tradable market. Use the "Dominance / TOTAL (sampled)" provider for dominance and TOTAL series.`,
        400,
      );
    }
    if (!pattern.test(symbol)) throw createServiceError(`"${symbol}" is not a valid symbol for this provider (e.g. ${hint})`, 400);
    return symbol;
  };
}

const PROVIDER_DEFINITIONS = {
  binance: {
    label: "Binance Spot",
    kind: "exchange",
    hint: "BTCUSDT",
    normalizeSymbol: rule(/^[A-Z0-9]{2,20}$/, "BTCUSDT"),
  },
  "binance-futures": {
    label: "Binance USDT-M Perpetual",
    kind: "exchange",
    hint: "BNBUSDT",
    normalizeSymbol: rule(/^[A-Z0-9]{2,20}$/, "BNBUSDT"),
  },
  mexc: { label: "MEXC Spot", kind: "exchange", hint: "MXUSDT", normalizeSymbol: rule(/^[A-Z0-9]{2,20}$/, "MXUSDT") },
  kucoin: {
    label: "KuCoin Spot",
    kind: "exchange",
    hint: "KCS-USDT",
    normalizeSymbol: rule(/^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/, "KCS-USDT"),
  },
  coinbase: {
    label: "Coinbase Exchange",
    kind: "exchange",
    hint: "BTC-USD",
    normalizeSymbol: rule(/^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/, "BTC-USD"),
  },
  kraken: { label: "Kraken Spot", kind: "exchange", hint: "PYUSDEUR", normalizeSymbol: rule(/^[A-Z0-9]{4,20}$/, "PYUSDEUR") },
  poloniex: {
    label: "Poloniex Spot",
    kind: "exchange",
    hint: "FRAX_USDT",
    normalizeSymbol: rule(/^[A-Z0-9]{1,15}_[A-Z0-9]{1,15}$/, "FRAX_USDT"),
  },
  yahoo: {
    label: "Macro (Yahoo Finance chart)",
    kind: "traditional",
    hint: "^GSPC, GC=F, DX-Y.NYB",
    normalizeSymbol: rule(/^\^?[A-Z0-9][A-Z0-9.=\-]{0,19}$/, "^GSPC"),
  },
  "coingecko-mcap": {
    label: "CoinGecko Market Cap",
    kind: "derived",
    hint: "tether",
    normalizeSymbol: (raw) => {
      const id = String(raw == null ? "" : raw).trim().toLowerCase();
      if (!id) throw createServiceError("A CoinGecko coin id is required", 400);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
        throw createServiceError(`"${id}" is not a CoinGecko coin id (e.g. tether, usd-coin)`, 400);
      }
      return id;
    },
  },
  dominance: {
    label: "Dominance / TOTAL (sampled)",
    kind: "derived",
    hint: "USDT.D, BTC.D, TOTAL3",
    normalizeSymbol: (raw) => {
      const symbol = String(raw == null ? "" : raw).trim().toUpperCase().replace(/^CRYPTOCAP:/, "");
      if (!/^(?:[A-Z0-9]{2,10}\.D|TOTAL[23]?)$/.test(symbol)) {
        throw createServiceError(`"${symbol}" is not a dominance or TOTAL series (e.g. USDT.D, BTC.D, TOTAL3)`, 400);
      }
      return symbol;
    },
  },
};

const PROVIDER_IDS = Object.keys(PROVIDER_DEFINITIONS);

function assertProviderId(value) {
  const id = String(value == null ? "" : value).trim();
  if (!PROVIDER_DEFINITIONS[id]) {
    throw createServiceError(`Unknown provider "${id}". Expected one of: ${PROVIDER_IDS.join(", ")}`, 400);
  }
  return id;
}

function normalizeProviderSymbol(provider, symbol) {
  return PROVIDER_DEFINITIONS[assertProviderId(provider)].normalizeSymbol(symbol);
}

/** Public metadata for the Settings page. No clients, no keys. */
function describeProviders() {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_DEFINITIONS[id].label,
    kind: PROVIDER_DEFINITIONS[id].kind,
    hint: PROVIDER_DEFINITIONS[id].hint,
  }));
}

/**
 * Live fetchers, keyed by provider id. Each has fetchCandles(symbol, tf).
 * `fetchImpl` is injectable so tests never touch the network.
 */
function createProviders({ signalScreenerService, marketDataService, dataDir, fetchImpl = fetch, timeoutMs = 8000, logger } = {}) {
  const opts = { fetchImpl, timeoutMs };
  return {
    binance: new BinanceSpotProvider({ signalScreenerService }),
    "binance-futures": new BinanceFuturesProvider(opts),
    mexc: new MexcProvider(opts),
    kucoin: new KucoinProvider(opts),
    coinbase: new CoinbaseProvider(opts),
    kraken: new KrakenProvider(opts),
    poloniex: new PoloniexProvider(opts),
    yahoo: new YahooChartProvider(opts),
    "coingecko-mcap": new CoinGeckoMarketCapProvider({ marketDataService }),
    dominance: new DominanceHistoryProvider({ marketDataService, dataDir, logger }),
  };
}

/**
 * Save-time check that a provider symbol resolves: one daily series from the
 * provider itself. A venue that answers "no such market" is a 400 the Settings
 * page shows next to the row; a venue that can't be reached is a 503, so an
 * outage is never reported as a bad symbol.
 *
 * Sampled dominance series have no upstream to ask, so they are checked
 * against the coins CoinGecko /global last reported instead.
 */
function createVerifier(providers) {
  return async ({ provider, providerSymbol }) => {
    const label = PROVIDER_DEFINITIONS[provider] ? PROVIDER_DEFINITIONS[provider].label : provider;
    if (provider === "dominance") {
      if (/^TOTAL/.test(providerSymbol)) return;
      const known = providers.dominance && providers.dominance.knownCoins ? providers.dominance.knownCoins() : [];
      const coin = providerSymbol.replace(/\.D$/, "");
      if (known.length && !known.includes(coin)) {
        throw createServiceError(
          `CoinGecko /global reports dominance only for its top coins (${known.join(", ")}); ${providerSymbol} cannot be sampled`,
          400,
        );
      }
      return;
    }
    const source = providers[provider];
    if (!source) throw createServiceError(`Provider "${provider}" is not available`, 503);
    let candles;
    try {
      candles = await source.fetchCandles(providerSymbol, "1D");
    } catch (err) {
      if (err.scope === "symbol") throw createServiceError(`${label} does not recognise ${providerSymbol}: ${err.message}`, 400);
      throw createServiceError(`Could not reach ${label} to verify ${providerSymbol}: ${err.message}`, 503);
    }
    if (!Array.isArray(candles) || !candles.length) {
      throw createServiceError(`${label} returned no candles for ${providerSymbol}`, 400);
    }
  };
}

module.exports = {
  createVerifier,
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  assertProviderId,
  normalizeProviderSymbol,
  describeProviders,
  createProviders,
  looksSynthetic,
};
