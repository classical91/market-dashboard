(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TickerLabel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Potential Buys labels. Shared by the page (potential-buys.js) and the
  // store (src/services/potential-buys.js) so both agree on what a ticker is.
  //
  // - A label that is a single ticker-shaped word ("btc", "Total3", "#eth")
  //   becomes a cashtag: "$BTC", "$TOTAL3", "$ETH".
  // - Cashtags inside a longer note are upper-cased: "$sol breakout" →
  //   "$SOL breakout". Plain words in a note are left alone.
  // - A label's folders are its $cashtags and #hashtags, upper-cased, so
  //   "$BTC", "#btc" and a legacy bare "Btc" all land in the BTC folder.

  /** A $ or # followed by a letter-led symbol; not "&#39;", "foo#BAR" or "$100". */
  var TAG_RE = /(^|[^\w&#$])[#$]([A-Za-z][A-Za-z0-9._-]{0,23})/g;
  var CASHTAG_RE = /(^|[^\w&#$])\$([A-Za-z][A-Za-z0-9._-]{0,23})/g;
  /** The whole label is one ticker: BTC, brk.b, SOL-USD, Total3, #eth, $nvda. */
  var BARE_TICKER_RE = /^[#$]?([A-Za-z][A-Za-z0-9.-]{0,11})$/;

  function collapse(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function cleanSymbol(symbol) {
    return symbol.replace(/[._-]+$/, "").toUpperCase();
  }

  /** "btc" → "$BTC"; "$sol breakout" → "$SOL breakout"; other notes unchanged. */
  function formatLabel(value) {
    var label = collapse(value);
    if (!label) return "";
    var bare = BARE_TICKER_RE.exec(label);
    if (bare) {
      var symbol = cleanSymbol(bare[1]);
      return symbol ? "$" + symbol : label;
    }
    return label.replace(CASHTAG_RE, function (_, lead, symbol) {
      return lead + "$" + symbol.toUpperCase();
    });
  }

  /** The folders a label files into, upper-cased and de-duplicated, in order. */
  function extractTags(value) {
    var label = formatLabel(value);
    var tags = [];
    if (!label) return tags;
    var match;
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(label))) {
      var tag = cleanSymbol(match[2]);
      if (tag && tags.indexOf(tag) === -1) tags.push(tag);
    }
    return tags;
  }

  return {
    formatLabel: formatLabel,
    extractTags: extractTags,
  };
});
