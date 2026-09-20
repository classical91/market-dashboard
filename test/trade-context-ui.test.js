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
