"use strict";

// The My Trades card renders three engines' output; freshness is what tells a
// reader whether that output is now. These cover that it is on the card at
// all, that it sits above the numbers it qualifies, and that the page stops
// presenting its own load time as if it were the data's age.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "..", "public", "pattern-scanner-trades.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "public", "assets", "styles", "trade-context.css"), "utf8");

test("every card carries a DATA line with both ages", () => {
  assert.match(page, /function freshnessLine\(freshness\)/);
  assert.match(page, /tc-data-label">DATA</);
  assert.match(page, /escapeHtml\(freshness\.summary \|\| ''\)/);
});

test("the DATA line precedes the evidence it qualifies", () => {
  // Reading "BULLISH 67" and only afterwards learning it is nine hours old is
  // the failure this is here to prevent.
  const data = page.indexOf("freshnessLine(card.freshness)");
  const bias = page.indexOf("biasSection(card.directionalBias)");
  const context = page.indexOf("tc-context tc-context--");
  assert.ok(data > -1 && bias > -1);
  assert.ok(data < bias, "the DATA line must render above the directional bias section");
  assert.ok(data < context, "and above the context strip");
});

test("a stale card is flagged in the head, where the eye lands first", () => {
  assert.match(page, /function freshnessBadge\(freshness\)/);
  assert.match(page, /freshnessBadge\(card\.freshness\)/);
  assert.match(page, /STALE/);
  assert.match(page, /AGE UNKNOWN/);
  // Absent timestamps and stale timestamps are different claims.
  assert.match(page, /tc-stale--' \+ \(stale \? 'stale' : 'unknown'\)/);
  assert.match(page, /No data age reported/);
});

test("the stale badge names which engine is behind rather than just flagging the card", () => {
  assert.match(page, /freshness\.staleReasons \|\| \[\]/);
});

test("the header timestamp says page refresh, not data age", () => {
  assert.match(page, /'Page refreshed '/);
  assert.doesNotMatch(page, /'Updated ' \+ new Date\(\)/);
  // A card count is more use than a bare flag when a watchlist is long.
  assert.match(page, /on stale data/);
});

test("the explainer tells a reader what candle age means on their timeframe", () => {
  assert.match(page, /Check the DATA line before you trust the card/);
  assert.match(page, /Candle age is not the same as staleness/);
});

test("freshness is styled as a qualifier, not as a fourth engine section", () => {
  assert.match(css, /\.tc-data\s*\{[^}]*font-size:\s*10px/s);
  assert.match(css, /\.tc-data--stale\s*\{/);
  assert.match(css, /\.tc-stale--stale\s*\{/);
  // It has to survive a phone: the head wraps rather than pushing the badge
  // off the card.
  const mobile = css.slice(css.indexOf("@media (max-width: 720px) {"));
  assert.match(mobile, /\.tc-data\s*\{\s*font-size:\s*9px/);
  // The head wraps at every width, not only on a phone: the badge crowds a
  // two-column card too, and a head that breaks words instead of rows reads
  // as a rendering bug.
  assert.match(css, /\.tc-head\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.tc-head > \*\s*\{\s*white-space:\s*nowrap/);
});

test("each card offers the Analysis Trader (GPT) hand-off", () => {
  assert.match(page, /<script src="\/assets\/js\/trade-gpt\.js"><\/script>/);
  assert.match(page, /gptActions\(card, index\)/);
  assert.match(page, /data-role="gpt-send"/);
  assert.doesNotMatch(page, /data-role="gpt-copy"/);
  // Each card links its own token's CoinGlass Super Chart.
  assert.match(page, /'https:\/\/www\.coinglass\.com\/tv\/Binance_' \+ encodeURIComponent\(symbol\)/);
  assert.match(page, /superChartLink\(card\.symbol\)/);
  assert.match(css, /\.tc-gpt\s*\{/);
});

test("the GPT brief carries the card's data and prefills the custom GPT", () => {
  const TradeGpt = require("../public/assets/js/trade-gpt.js");
  assert.strictEqual(TradeGpt.GPT_URL, "https://chatgpt.com/g/g-6a3806b123748191b5bfa7c394c5dd66-analysis-trader");
  const brief = TradeGpt.buildBrief({
    symbol: "SOLUSDT",
    interval: "4h",
    price: 142.5,
    freshness: { state: "FRESH", summary: "candle closed 12m ago" },
    directionalBias: { bias: "BULLISH", score: 67, trendRegime: "TREND_UP", rsi: 58.2, adx: 24 },
    extremes: { bottomScore: 15, topScore: 40, state: "NONE" },
    patterns: { pattern: "Bull flag", patternBias: "bullish", status: "forming", patternScore: 72 },
    openInterest: { horizon: "4h", state: { label: "Longs opening" }, oiChangePct: 3.1, priceChangePct: 1.2 },
    rsi: { cells: [{ label: "1h", value: 61.2 }], average: 61.2 },
    evidence: ["Higher lows on 4h"],
    context: { state: "ALIGNED", summary: "Bias and pattern agree" },
  });
  for (const fragment of ["SOLUSDT", "4h", "BULLISH (score 67/100)", "Bull flag", "Longs opening", "1h 61.2", "Higher lows on 4h", "ALIGNED"]) {
    assert.ok(brief.includes(fragment), `brief should include ${fragment}`);
  }
  const url = TradeGpt.gptUrl(brief);
  assert.ok(url.startsWith(TradeGpt.GPT_URL + "?q="));
  assert.strictEqual(decodeURIComponent(url.slice(url.indexOf("?q=") + 3)), brief);
  // Too long for a URL: open the GPT plain and rely on the clipboard.
  assert.strictEqual(TradeGpt.gptUrl("x".repeat(TradeGpt.MAX_PREFILL_CHARS + 1)), TradeGpt.GPT_URL);
});

test("a card with failed engines still produces a brief rather than throwing", () => {
  const TradeGpt = require("../public/assets/js/trade-gpt.js");
  const brief = TradeGpt.buildBrief({
    symbol: "BTCUSDT", interval: "1D",
    directionalBias: { error: "bias engine down" }, extremes: { error: "x" }, patterns: { error: "y" },
  });
  assert.match(brief, /unavailable: bias engine down/);
});

test("each card carries a changes block above the sections it qualifies", () => {
  assert.match(page, /function changesBlock\(changes\)/);
  assert.match(page, /changesBlock\(card\.changes\)/);
  const changes = page.indexOf("changesBlock(card.changes)");
  const bias = page.indexOf("biasSection(card.directionalBias)");
  const data = page.indexOf("freshnessLine(card.freshness)");
  assert.ok(data < changes, "the data's age is read before what changed in it");
  assert.ok(changes < bias, "and both are read before the states they qualify");
});

test("a first look is not dressed up as 'nothing changed'", () => {
  assert.match(page, /FIRST_OBSERVATION/);
  assert.match(page, /First look at this pair/);
  assert.match(page, /Nothing changed on the last closed candle/);
});

test("a changed card is flagged in the head with how many transitions it has", () => {
  assert.match(page, /function changedBadge\(changes\)/);
  assert.match(page, /changedBadge\(card\.changes\)/);
  assert.match(page, /' CHANGE' \+ \(count === 1 \? '' : 'S'\)/);
});

test("an unavailable change history is reported, not rendered as no changes", () => {
  assert.match(page, /tc-changes--unavailable/);
  assert.match(page, /changes\.error/);
});

test("the header counts changed cards alongside stale ones", () => {
  assert.match(page, /data\.changed \|\| 0/);
  assert.match(page, /' card' \+ \(changed === 1 \? '' : 's'\) \+ ' changed'/);
});

test("the explainer states the baseline rolls on candles and that outages are not changes", () => {
  assert.match(page, /Scan the CHANGED blocks first/);
  assert.match(page, /per closed candle, not per page load/);
  assert.match(page, /A broken engine never counts as a change/);
});

test("changes are styled as the card's one attention signal and survive a phone", () => {
  assert.match(css, /\.tc-changes\s*\{/);
  assert.match(css, /\.tc-changes--changed\s*\{/);
  assert.match(css, /\.tc-changed-badge\s*\{/);
  assert.match(css, /\.tc-change--new \.tc-change-label\s*\{/);
  const mobile = css.slice(css.indexOf("@media (max-width: 720px) {"));
  assert.match(mobile, /\.tc-change-kind\s*\{\s*min-width:\s*0/);
});
