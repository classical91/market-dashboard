"use strict";

// The Directional Bias page is half of what the Signal Screener used to be:
// direction only, in the dashboard's own vocabulary, with no instruction to
// act. These pin the properties that keep it readable that way.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const page = read("public/directional-bias.html");
const script = read("public/assets/js/directional-bias.js");
const shared = read("public/assets/js/screener-ui.js");
const css = read("public/assets/styles/directional-bias.css");
const sharedCss = read("public/assets/styles/signal-screener.css");

test("the page loads the assets it references and nothing else", () => {
  for (const asset of [
    "/assets/styles/command.css",
    "/assets/styles/signal-screener.css",
    "/assets/styles/directional-bias.css",
    "/assets/js/sidebar.js",
    "/assets/js/admin-key.js",
    "/assets/js/screener-ui.js",
    "/assets/js/directional-bias.js",
  ]) {
    assert.ok(page.includes(asset), `${asset} must be referenced`);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", asset)), `${asset} must exist`);
  }
});

test("the page explains what a bias is, and what it is not", () => {
  assert.match(page, /Directional Bias measures where trend and momentum are currently leaning\. It does not represent an automatic trade entry\./);
  assert.match(page, /Bias is not an entry/);
  assert.match(page, /LONG \/ SHORT stay reserved for pages that publish an actual setup/);
});

test("the UI speaks BULLISH / BEARISH / NEUTRAL, never LONG / SHORT", () => {
  assert.match(script, /entry\.bias/);
  // No row, badge or class is driven by the wire vocabulary on this page: the
  // server already translated it.
  assert.doesNotMatch(script, /entry\.signal/);
  assert.doesNotMatch(script, /'LONG'|"LONG"|'SHORT'|"SHORT"/);
  for (const bias of ["BULLISH", "BEARISH", "NEUTRAL"]) {
    assert.match(script, new RegExp(bias));
  }
});

test("the columns the page promises are all present", () => {
  for (const column of [
    "Pair", "Price", "Directional bias", "Score", "Trend regime",
    "RSI", "ADX", "EMA", "VWAP", "MACD", "Volume", "Timeframe", "Freshness",
  ]) {
    assert.match(page, new RegExp(`<th>${column}</th>`), `${column} column is missing`);
  }
  // And each cell carries the label the phone layout stands in for.
  for (const label of ["Price", "Bias", "Score", "Trend regime", "RSI", "Timeframe", "Freshness"]) {
    assert.match(script, new RegExp(`data-label="${label}"`), `${label} cell label is missing`);
  }
  // The four component cells share one renderer, which labels them from its
  // first argument.
  for (const label of ["EMA", "VWAP", "MACD", "Volume"]) {
    assert.match(script, new RegExp(`componentCell\\("${label}"`), `${label} component cell is missing`);
  }
  assert.match(script, /'<td data-label="' \+ escapeHtml\(label\) \+ '">/);
});

test("ranking is by confidence, and never puts bullish above bearish", () => {
  const compare = script.slice(script.indexOf("function compare("), script.indexOf("function renderSummary("));
  assert.match(compare, /b\.score \|\| 0\) - \(a\.score \|\| 0\)/);
  // Rows with a direction sort above neutral ones; the side itself is not
  // part of the comparison.
  assert.match(compare, /bias !== "NEUTRAL"/);
  assert.doesNotMatch(compare, /BULLISH|BEARISH/);
});

test("BTC is pinned as market context and never consumes a rank", () => {
  assert.match(script, /var PINNED_SYMBOLS = \["BTCUSDT"\]/);
  assert.match(script, /!isPinned\(entry\.symbol\) && matchesFilters\(entry\)/);
  assert.match(script, /ranked\.map\(function \(entry, index\) \{ return renderRow\(entry, index \+ 1\); \}\)/);
  assert.match(script, /renderRow\(entry, null\)/);
  assert.match(script, /'<span class="ss-rank">#' \+ rank/);
});

test("USDT.D rides along as context with its scored columns visibly empty", () => {
  // It is a CRYPTOCAP index: no candles, no volume, so the bias engine has
  // nothing to run on. Empty must read as "not scored", never as a zero.
  assert.match(script, /function renderDominanceRow\(dominance\)/);
  assert.match(script, /NOT SCORED/);
  assert.match(script, /BUILDING HISTORY/);
  assert.match(script, /if \(!dominance \|\| dominance\.percent == null\) return ""/);
  // Its own vocabulary, kept distinct from the six-check bias.
  const dominanceRow = script.slice(script.indexOf("function renderDominanceRow"), script.indexOf("function matchesFilters"));
  assert.doesNotMatch(dominanceRow, /BULLISH|BEARISH/);
  assert.doesNotMatch(dominanceRow, /track-btn|watchlist\.button/, "My Trades cannot scan a row with no OHLCV");
});

test("filters cover bias and trend strength without hiding the rest", () => {
  for (const filter of ["ALL", "BULLISH", "BEARISH", "NEUTRAL"]) {
    assert.match(page, new RegExp(`data-filter="${filter}"`));
  }
  for (const filter of ["TRENDING", "STRONG_ADX", "WEAK_TREND"]) {
    assert.match(page, new RegExp(`data-filter="${filter}"`));
  }
  assert.match(page, /id="db-search"/);
});

test("component cells are tinted by their own reading, never by the row's bias", () => {
  // A bearish MACD inside a bullish row must stay visibly bearish, or the
  // page stops showing why a score is what it is.
  const componentCell = script.slice(script.indexOf("var COMPONENT_TONE"), script.indexOf("function trendRegimeCell"));
  assert.doesNotMatch(componentCell, /entry\.bias/);
  assert.match(css, /\.db-part--bull/);
  assert.match(css, /\.db-part--bear/);
});

test("freshness is shown per row, in the project's existing states", () => {
  assert.match(script, /S\.freshnessBadge\(entry\.freshness\)/);
  assert.match(shared, /var FRESHNESS_LABELS = \{ FRESH: "FRESH", STALE: "STALE", UNKNOWN: "UNAVAILABLE" \}/);
  assert.match(sharedCss, /\.ss-fresh--stale/);
});

test("rows can be starred into My Trades, keyed by symbol and timeframe", () => {
  assert.match(page, /<script src="\/assets\/js\/admin-key\.js"><\/script>/, "mutation needs the admin-key helper");
  assert.match(shared, /data-role="track-btn"/);
  assert.match(shared, /AdminKey\.fetch\("\/api\/watchlist"/);
  assert.match(shared, /method: tracked \? "DELETE" : "POST"/, "the same star toggles both ways");
  assert.match(shared, /function trackKey\(symbol, interval\) \{\s*return symbol \+ ":" \+ interval;/);
  // Stars are correct on the first render rather than filling in a beat later.
  assert.match(script, /watchlist\.load\(\)\.then\(function \(\) \{ load\(false\); \}\)/);
});

test("the timeframe travels with the numbers and survives a reload", () => {
  assert.match(script, /S\.rememberSelect\(intervalSelect, "directionalBiasInterval"\)/);
  assert.match(script, /intervalMemory\.remember\(\); load\(false\)/);
  assert.match(script, /<span class="ss-summary-tf">' \+ escapeHtml\(entry\.interval\)/);
});

test("the page fits a phone: the wide table restacks as labelled cards", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 720px) {"));
  assert.match(mobile, /\.db-table \{ min-width: 0; \}/);
  assert.match(mobile, /\.db-table td\[data-label\]::before \{\s*content: attr\(data-label\)/);
  assert.match(mobile, /\.db-table thead \{/);
});
