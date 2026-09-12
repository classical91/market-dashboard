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
// the Binance-based scanners — they're for the TradingView-driven
// AI Analysis presets.
const DOMINANCE_PRESETS = [
  { symbol: "CRYPTOCAP:BTC.D", label: "BTC.D", interval: "4h", category: "dominance" },
  { symbol: "CRYPTOCAP:ETH.D", label: "ETH.D", interval: "4h", category: "dominance" },
  { symbol: "CRYPTOCAP:USDT.D", label: "USDT.D", interval: "4h", category: "dominance" },
  { symbol: "CRYPTOCAP:OTHERS.D", label: "OTHERS.D", interval: "4h", category: "dominance" },
  { symbol: "CRYPTOCAP:TOTAL", label: "TOTAL", interval: "4h", category: "dominance" },
  { symbol: "CRYPTOCAP:TOTAL2", label: "TOTAL2", interval: "4h", category: "dominance" },
  { symbol: "CRYPTOCAP:TOTAL3", label: "TOTAL3", interval: "4h", category: "dominance" },
];

// Chart presets fall into three families that are read very differently, so
// the AI Analysis page groups them under these headings instead of mixing a
// BTC.D ratio chart in with a spot pair. Order here is display order.
const PRESET_CATEGORIES = [
  { key: "crypto", label: "Crypto", description: "Spot pairs — the standard price charts" },
  { key: "dominance", label: "Dominance & Market Cap", description: "CRYPTOCAP ratio and aggregate indices" },
  { key: "stocks", label: "Stocks & Macro", description: "Equity indices, FX, rates, commodities" },
];

const PRESET_CATEGORY_KEYS = PRESET_CATEGORIES.map((category) => category.key);
// Anything we can't place is macro far more often than it is crypto: a bare
// exchange-less ticker on the AI Analysis page is a stock index, not a pair.
const DEFAULT_PRESET_CATEGORY = "stocks";

const DOMINANCE_SYMBOL_PREFIXES = ["CRYPTOCAP:"];
const CRYPTO_SYMBOL_PREFIXES = [
  "BINANCE:", "BYBIT:", "COINBASE:", "OKX:", "KRAKEN:", "BITSTAMP:",
  "BITFINEX:", "KUCOIN:", "MEXC:", "GATEIO:", "HTX:", "UPBIT:", "CRYPTO:",
];
// Quote currencies that only ever appear on crypto pairs, so an unprefixed
// "BTCUSDT" still lands in Crypto. Plain "...USD" is deliberately excluded —
// XAUUSD and EURUSD end that way too.
const CRYPTO_QUOTE_SUFFIXES = ["USDT", "USDC", "USDT.P", "BUSD", "TUSD"];

/**
 * Best-effort category for a preset that didn't declare one (an operator's
 * AI_ANALYSIS_SYMBOLS override, or a symbol analyzed ad hoc). Explicit
 * categories always win; this only fills the gap.
 */
function inferPresetCategory(symbol) {
  const upper = String(symbol || "").trim().toUpperCase();
  if (!upper) return DEFAULT_PRESET_CATEGORY;
  if (DOMINANCE_SYMBOL_PREFIXES.some((prefix) => upper.startsWith(prefix))) return "dominance";
  if (CRYPTO_SYMBOL_PREFIXES.some((prefix) => upper.startsWith(prefix))) return "crypto";
  if (!upper.includes(":") && CRYPTO_QUOTE_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return "crypto";
  return DEFAULT_PRESET_CATEGORY;
}

/**
 * Coerce a caller-supplied category to one of the three known keys, falling
 * back to what the symbol itself suggests when it's missing or unrecognized.
 */
function resolvePresetCategory(category, symbol) {
  const key = String(category || "").trim().toLowerCase();
  if (PRESET_CATEGORY_KEYS.includes(key)) return key;
  return inferPresetCategory(symbol);
}

module.exports = {
  TOP_TOKENS,
  DOMINANCE_PRESETS,
  PRESET_CATEGORIES,
  PRESET_CATEGORY_KEYS,
  DEFAULT_PRESET_CATEGORY,
  inferPresetCategory,
  resolvePresetCategory,
};
