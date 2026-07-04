// Shared symbol lists so every scanner/screener/analysis page draws from the
// same universe instead of each hardcoding its own.

// Top Binance spot USDT pairs by market-cap relevance, used by the Signal
// Screener and Pattern Scanner. Spot pairs (not ".P" perpetuals) because the
// public data endpoint we use only serves spot klines.
const TOP_TOKENS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT",
  "DOTUSDT", "NEARUSDT", "INJUSDT", "OPUSDT", "ARBUSDT",
  "PENDLEUSDT", "WIFUSDT", "FETUSDT", "PEPEUSDT", "LTCUSDT",
  "TONUSDT", "APTUSDT", "UNIUSDT", "TRXUSDT", "SHIBUSDT",
];

// Dominance / aggregate market-cap charts. These are synthetic TradingView
// indices (CRYPTOCAP:*) with no Binance OHLCV data, so they can't go through
// the Binance-based scanners — they're for the chart-img/TradingView-driven
// AI Analysis presets.
const DOMINANCE_PRESETS = [
  { symbol: "CRYPTOCAP:BTC.D", label: "BTC.D", interval: "4h" },
  { symbol: "CRYPTOCAP:ETH.D", label: "ETH.D", interval: "4h" },
  { symbol: "CRYPTOCAP:USDT.D", label: "USDT.D", interval: "4h" },
  { symbol: "CRYPTOCAP:OTHERS.D", label: "OTHERS.D", interval: "4h" },
  { symbol: "CRYPTOCAP:TOTAL", label: "TOTAL", interval: "4h" },
  { symbol: "CRYPTOCAP:TOTAL2", label: "TOTAL2", interval: "4h" },
  { symbol: "CRYPTOCAP:TOTAL3", label: "TOTAL3", interval: "4h" },
];

module.exports = { TOP_TOKENS, DOMINANCE_PRESETS };
