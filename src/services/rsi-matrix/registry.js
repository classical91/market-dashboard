"use strict";

// The RSI Matrix's shipped instrument registry: the two reference matrices,
// expressed as logical instruments rather than TradingView tickers.
//
// Each entry separates what the column is called (`label`) from where its
// candles come from (`provider` + `providerSymbol`). Where the reference used
// a venue this app cannot reach (CAPITALCOM:DAIUSD has no public API), the
// closest public market is used and the Source line on the page says so —
// it is never silently swapped.
//
// The same market may appear in both groups (BTCUSD does, as in both
// reference screenshots). That costs nothing upstream: candles are cached by
// provider + symbol + timeframe, not by row.

const GROUPS = [
  { id: "cross-market", label: "Cross-Market" },
  { id: "crypto-stables", label: "Crypto / Dominance / Stablecoins" },
];

const GROUP_IDS = GROUPS.map((g) => g.id);

function entry(id, label, group, provider, providerSymbol, note) {
  return { id, label, group, provider, providerSymbol, enabled: true, ...(note ? { note } : {}) };
}

const DEFAULT_INSTRUMENTS = [
  // Cross-Market
  entry("spx", "SPX", "cross-market", "yahoo", "^GSPC"),
  entry("btc-usd", "BTCUSD", "cross-market", "binance", "BTCUSDT", "Binance BTCUSDT spot"),
  entry("eth-usd", "ETHUSD", "cross-market", "binance", "ETHUSDT", "Binance ETHUSDT spot"),
  entry("xrp-usdt", "XRPUSDT", "cross-market", "binance", "XRPUSDT"),
  entry("us10y", "US10Y", "cross-market", "yahoo", "^TNX", "CBOE 10-year yield index"),
  entry("gold", "GOLD", "cross-market", "yahoo", "GC=F", "COMEX gold front-month future"),
  entry("silver", "SILVER", "cross-market", "yahoo", "SI=F", "COMEX silver front-month future"),
  entry("usoil", "USOIL", "cross-market", "yahoo", "CL=F", "NYMEX WTI front-month future"),
  entry("eur1", "EUR1!", "cross-market", "yahoo", "6E=F", "CME euro FX front-month future"),
  entry("dxy", "DXY", "cross-market", "yahoo", "DX-Y.NYB", "ICE US Dollar Index"),

  // Crypto / Dominance / Stablecoins
  entry("usdt-d", "USDT.D", "crypto-stables", "dominance", "USDT.D"),
  entry("btc-usd-crypto", "BTCUSD", "crypto-stables", "binance", "BTCUSDT", "Binance BTCUSDT spot"),
  entry("btc-d", "BTC.D", "crypto-stables", "dominance", "BTC.D"),
  entry("total3", "TOTAL3", "crypto-stables", "dominance", "TOTAL3"),
  entry("usdc-d", "USDC.D", "crypto-stables", "dominance", "USDC.D"),
  // MXUSDT and MEXC:MXUSDT in the references are one market: one column.
  entry("mx", "MXUSDT", "crypto-stables", "mexc", "MXUSDT"),
  entry("ustc", "USTCUSDT", "crypto-stables", "binance", "USTCUSDT"),
  entry("cro", "CROUSDT", "crypto-stables", "mexc", "CROUSDT", "CRO is not listed on Binance"),
  entry("kcs", "KCSUSDT", "crypto-stables", "kucoin", "KCS-USDT"),
  entry("bnb-perp", "BNBUSDT.P", "crypto-stables", "binance-futures", "BNBUSDT"),
  entry("usdt-mcap", "USDT MCAP", "crypto-stables", "coingecko-mcap", "tether", "CRYPTOCAP:USDT equivalent"),
  entry("usdc-mcap", "USDC MCAP", "crypto-stables", "coingecko-mcap", "usd-coin", "CRYPTOCAP:USDC equivalent"),
  entry("dai", "DAIUSD", "crypto-stables", "kraken", "DAIUSD", "Kraken DAIUSD — Capital.com has no public candle API"),
  entry("tusd", "TUSD", "crypto-stables", "coinbase", "TUSD-USD"),
  entry("fdusd-mcap", "FDUSD MCAP", "crypto-stables", "coingecko-mcap", "first-digital-usd", "CRYPTOCAP:FDUSD equivalent"),
  entry("usdd", "USDDUSDC", "crypto-stables", "kucoin", "USDD-USDC"),
  entry("usdp", "USDPUSDT", "crypto-stables", "binance", "USDPUSDT"),
  entry("pyusd", "PYUSDEUR", "crypto-stables", "kraken", "PYUSDEUR"),
  entry("frax", "FRAXUSDT", "crypto-stables", "poloniex", "FRAX_USDT"),
];

module.exports = { GROUPS, GROUP_IDS, DEFAULT_INSTRUMENTS };
