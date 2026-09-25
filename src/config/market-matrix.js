"use strict";

// TradeHunter → Market Matrix: the symbols a chart panel can show.
//
// Panels are keyed by concept ("TOTAL", "DXY", "BTC", "USDT.D"), never by a
// provider ticker. Each entry says where its candles really come from, so
// swapping a feed is a one-line change here and the page — which shows the
// source in every panel header — never has to be touched.
//
// Rules that keep the page honest:
// - No proxies. DXY is the ICE US Dollar Index itself (Yahoo DX-Y.NYB), not
//   UUP or an FX basket; TOTAL and the dominance series are this server's own
//   CoinGecko /global samples, not a single-coin stand-in.
// - A timeframe a feed cannot honestly produce is not offered for it. The
//   sampled series are recorded every 15 minutes, so they have no 5m bars.
// - `tvSymbol` is only a link out to the same concept on TradingView; no
//   data is read from it.

const TIMEFRAMES = [
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "30m", label: "30m" },
  { key: "1h", label: "1H" },
  { key: "4h", label: "4H" },
  { key: "1D", label: "1D" },
  { key: "1W", label: "1W" },
];

const TIMEFRAME_KEYS = TIMEFRAMES.map((tf) => tf.key);

// Hourly is the TradeHunter working timeframe.
const DEFAULT_TIMEFRAME = "1h";

// Top-left, top-right, bottom-left, bottom-right.
const DEFAULT_PANELS = ["TOTAL", "DXY", "BTC", "USDT.D"];

const SOURCES = {
  binance: {
    label: "Binance Spot",
    // The same data-api.binance.vision klines Directional Bias, Local
    // Extremes and the RSI Matrix read.
    detail: "Binance spot klines",
    timeframes: TIMEFRAME_KEYS,
    sampled: false,
  },
  yahoo: {
    label: "Yahoo Finance",
    detail: "Yahoo Finance chart history (4H rolled up from 1H on UTC boundaries)",
    timeframes: TIMEFRAME_KEYS,
    sampled: false,
  },
  sampled: {
    label: "CoinGecko /global (sampled)",
    detail:
      "No free feed serves this series' history, so the server records CoinGecko /global every 15 minutes and builds bars from those samples. Nothing before the first sample is shown, and unsampled periods stay as gaps.",
    timeframes: TIMEFRAME_KEYS.filter((tf) => tf !== "5m"),
    sampled: true,
  },
};

function symbol(id, label, name, source, providerSymbol, extra = {}) {
  return { id, label, name, source, providerSymbol, format: "price", ...extra };
}

const SYMBOLS = [
  // Defaults
  symbol("TOTAL", "TOTAL", "Total crypto market cap", "sampled", "TOTAL", { format: "usd-compact", tvSymbol: "CRYPTOCAP:TOTAL" }),
  symbol("DXY", "DXY", "U.S. Dollar Index", "yahoo", "DX-Y.NYB", { tvSymbol: "TVC:DXY", note: "ICE US Dollar Index" }),
  symbol("BTC", "BTC/USDT", "Bitcoin", "binance", "BTCUSDT", { tvSymbol: "BINANCE:BTCUSDT" }),
  symbol("USDT.D", "USDT.D", "Tether market-cap dominance", "sampled", "USDT.D", { format: "percent", tvSymbol: "CRYPTOCAP:USDT.D" }),

  // Crypto
  symbol("ETH", "ETH/USDT", "Ethereum", "binance", "ETHUSDT", { tvSymbol: "BINANCE:ETHUSDT" }),
  symbol("SOL", "SOL/USDT", "Solana", "binance", "SOLUSDT", { tvSymbol: "BINANCE:SOLUSDT" }),
  symbol("XRP", "XRP/USDT", "XRP", "binance", "XRPUSDT", { tvSymbol: "BINANCE:XRPUSDT" }),
  symbol("BNB", "BNB/USDT", "BNB", "binance", "BNBUSDT", { tvSymbol: "BINANCE:BNBUSDT" }),
  symbol("ETHBTC", "ETH/BTC", "Ethereum / Bitcoin", "binance", "ETHBTC", { tvSymbol: "BINANCE:ETHBTC" }),

  // Market cap and dominance
  symbol("TOTAL2", "TOTAL2", "Crypto market cap excl. BTC", "sampled", "TOTAL2", { format: "usd-compact", tvSymbol: "CRYPTOCAP:TOTAL2" }),
  symbol("TOTAL3", "TOTAL3", "Crypto market cap excl. BTC & ETH", "sampled", "TOTAL3", { format: "usd-compact", tvSymbol: "CRYPTOCAP:TOTAL3" }),
  symbol("BTC.D", "BTC.D", "Bitcoin dominance", "sampled", "BTC.D", { format: "percent", tvSymbol: "CRYPTOCAP:BTC.D" }),
  symbol("ETH.D", "ETH.D", "Ethereum dominance", "sampled", "ETH.D", { format: "percent", tvSymbol: "CRYPTOCAP:ETH.D" }),
  symbol("USDC.D", "USDC.D", "USDC dominance", "sampled", "USDC.D", { format: "percent", tvSymbol: "CRYPTOCAP:USDC.D" }),

  // Macro
  symbol("SPX", "SPX", "S&P 500 index", "yahoo", "^GSPC", { tvSymbol: "SP:SPX" }),
  symbol("NDX", "NDX", "Nasdaq 100 index", "yahoo", "^NDX", { tvSymbol: "NASDAQ:NDX" }),
  symbol("US10Y", "US10Y", "US 10-year yield", "yahoo", "^TNX", { tvSymbol: "TVC:US10Y", note: "CBOE 10-year yield index (^TNX)" }),
  symbol("GOLD", "GOLD", "Gold", "yahoo", "GC=F", { tvSymbol: "COMEX:GC1!", note: "COMEX gold front-month future" }),
  symbol("USOIL", "USOIL", "WTI crude oil", "yahoo", "CL=F", { tvSymbol: "NYMEX:CL1!", note: "NYMEX WTI front-month future" }),
];

const SYMBOL_GROUPS = [
  { label: "Defaults", ids: ["TOTAL", "DXY", "BTC", "USDT.D"] },
  { label: "Crypto", ids: ["ETH", "SOL", "XRP", "BNB", "ETHBTC"] },
  { label: "Market cap & dominance", ids: ["TOTAL2", "TOTAL3", "BTC.D", "ETH.D", "USDC.D"] },
  { label: "Macro", ids: ["SPX", "NDX", "US10Y", "GOLD", "USOIL"] },
];

const SYMBOLS_BY_ID = new Map(SYMBOLS.map((s) => [s.id, s]));

function getSymbol(id) {
  return SYMBOLS_BY_ID.get(String(id || "")) || null;
}

function isTimeframe(tf) {
  return TIMEFRAME_KEYS.includes(tf);
}

function timeframeLabel(tf) {
  const found = TIMEFRAMES.find((t) => t.key === tf);
  return found ? found.label : tf;
}

module.exports = {
  TIMEFRAMES,
  TIMEFRAME_KEYS,
  DEFAULT_TIMEFRAME,
  DEFAULT_PANELS,
  SOURCES,
  SYMBOLS,
  SYMBOL_GROUPS,
  getSymbol,
  isTimeframe,
  timeframeLabel,
};
