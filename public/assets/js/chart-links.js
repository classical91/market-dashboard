(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChartLinks = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Chart links for Potential Buys tickers: which TradingView chart a folder
  // like "$NVDA", "$BTC" or "$TOTAL3" should open. TradingView's free chart
  // needs no account, and on phones settings.js reroutes these links into the
  // TradingView app.
  //
  // - Stocks stay bare ("NVDA", "BRK.B"): TradingView opens the main listing.
  // - Crypto becomes a Binance USDT pair ("BTC" → BINANCE:BTCUSDT), because a
  //   bare "BTC" is ambiguous on TradingView. A ticker counts as crypto when
  //   it is a known coin, a pair ("SOLUSDT", "SOL-USD"), or the screenshot's
  //   label says #crypto.
  // - Market-cap and dominance charts ("TOTAL3", "BTC.D") are CRYPTOCAP:.
  // - #stock in a label keeps a ticker on the stock chart even when it is
  //   also a coin's symbol.

  var TV_CHART = "https://www.tradingview.com/chart/?symbol=";

  // Every base of the server's TRACKABLE_TOKENS (src/config/market-symbols.js,
  // checked by a test) plus other widely traded coins.
  var CRYPTO = [
    "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "SUI",
    "DOT", "NEAR", "INJ", "OP", "ARB", "PENDLE", "WIF", "FET", "PEPE", "LTC",
    "TON", "APT", "UNI", "TRX", "SHIB", "BCH", "XLM", "HBAR", "AAVE", "ETC",
    "ATOM", "FIL", "ICP", "ALGO", "VET", "XMR", "TAO", "HYPE", "ENA", "JUP",
    "BONK", "FLOKI", "SEI", "TIA", "RENDER", "RNDR", "ONDO", "WLD", "POL",
    "MATIC", "LDO", "STX", "IMX", "GRT", "MKR", "PYTH", "JTO", "RUNE", "KAS",
    "TRUMP", "VIRTUAL", "PENGU", "FARTCOIN", "POPCAT", "BRETT", "MOG",
  ];

  // Aggregate charts that only exist as TradingView CRYPTOCAP: indices.
  var CRYPTOCAP = ["TOTAL", "TOTAL2", "TOTAL3", "OTHERS", "TOTALDEFI", "TOTALES"];

  // Category words people put in labels ("#crypto", "#stocks"): folders, not
  // tickers, so they get no chart.
  var NOT_TICKERS = [
    "CRYPTO", "STOCK", "STOCKS", "ALT", "ALTS", "ALTCOIN", "ALTCOINS", "MEME", "MEMES",
    "WATCH", "WATCHLIST", "IDEA", "IDEAS", "SETUP", "SETUPS", "TA", "LONG", "SHORT", "SWING",
  ];
  var CRYPTO_HINTS = ["CRYPTO", "ALT", "ALTS", "ALTCOIN", "ALTCOINS", "MEME", "MEMES"];
  var STOCK_HINTS = ["STOCK", "STOCKS"];

  var PAIR_QUOTE_RE = /^([A-Z][A-Z0-9]{1,14}?)(USDT|USDC)$/;
  var DASH_PAIR_RE = /^([A-Z][A-Z0-9]{1,14})-(USD|USDT|USDC)$/;
  var USD_PAIR_RE = /^([A-Z][A-Z0-9]{1,14})USD$/;

  function has(list, value) {
    return list.indexOf(value) !== -1;
  }

  /** "crypto", "stock" or "" from the tags of the screenshots in a folder. */
  function marketHint(tags) {
    var list = Array.isArray(tags) ? tags : [];
    if (list.some(function (t) { return has(STOCK_HINTS, t); })) return "stock";
    if (list.some(function (t) { return has(CRYPTO_HINTS, t); })) return "crypto";
    return "";
  }

  /**
   * The TradingView symbol for a folder tag (upper case, as extractTags gives
   * it), or "" when the tag is a category word rather than a ticker.
   */
  function chartSymbol(tag, hint) {
    var t = String(tag || "").toUpperCase();
    if (!t || has(NOT_TICKERS, t) || !/^[A-Z][A-Z0-9.\-]*$/.test(t)) return "";
    if (has(CRYPTOCAP, t) || /^[A-Z0-9]+\.D$/.test(t)) return "CRYPTOCAP:" + t;
    if (hint === "stock") return t;
    var pair = PAIR_QUOTE_RE.exec(t);
    if (pair) return "BINANCE:" + t;
    var dash = DASH_PAIR_RE.exec(t);
    if (dash) return "BINANCE:" + dash[1] + "USDT";
    var usd = USD_PAIR_RE.exec(t);
    if (usd && has(CRYPTO, usd[1])) return "BINANCE:" + usd[1] + "USDT";
    if (has(CRYPTO, t) || hint === "crypto") return "BINANCE:" + t + "USDT";
    return t;
  }

  /** The free TradingView chart for a folder tag, or "" (see chartSymbol). */
  function chartUrl(tag, hint) {
    var symbol = chartSymbol(tag, hint);
    return symbol ? TV_CHART + encodeURIComponent(symbol) : "";
  }

  return {
    CRYPTO: CRYPTO,
    chartSymbol: chartSymbol,
    chartUrl: chartUrl,
    marketHint: marketHint,
  };
});
