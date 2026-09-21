"use strict";

// The Local Extremes page is the other half of the old Signal Screener:
// location and exhaustion, never direction and never an instruction. These
// pin the distinction the page exists to make.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const page = read("public/local-extremes.html");
const script = read("public/assets/js/local-extremes.js");
const shared = read("public/assets/js/screener-ui.js");
const css = read("public/assets/styles/local-extremes.css");

test("the page loads the assets it references and nothing else", () => {
  for (const asset of [
    "/assets/styles/command.css",
    "/assets/styles/signal-screener.css",
    "/assets/styles/local-extremes.css",
    "/assets/js/sidebar.js",
    "/assets/js/admin-key.js",
    "/assets/js/screener-ui.js",
    "/assets/js/local-extremes.js",
  ]) {
    assert.ok(page.includes(asset), `${asset} must be referenced`);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", asset)), `${asset} must exist`);
  }
});

test("the page explains what an extreme is, and that it is not a direction", () => {
  assert.match(page, /Local Extremes measures whether price appears stretched near a possible local top or bottom\. A confirmed extreme can occur inside a larger trend\./);
  assert.match(page, /A bullish trend and a confirmed local top can both be true\./);
  assert.match(page, /Directional Bias<\/a> = direction\. Local Extremes = location within the move\./);
  assert.match(page, /all four combinations are legitimate/);
});

test("nothing on the page reads as a trade instruction", () => {
  // A local top or bottom is market context, not an entry.
  assert.match(page, /An extreme is a location, not an entry/);
  // Comments are stripped first: the rules that say what this page must not
  // do necessarily name the words it must not render.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bBUY\b|\bSELL\b/);
  // LONG/SHORT appear nowhere either: this page has no directional vocabulary.
  assert.doesNotMatch(code, /'LONG'|"LONG"|'SHORT'|"SHORT"/);
  assert.doesNotMatch(code, /entry\.signal|entry\.bias/);
});

test("both scores are rendered, independently, on every row", () => {
  assert.match(page, /<th>Bottom<\/th>\s*<th>Top<\/th>/);
  assert.match(script, /scoreMeter\(entry\.bottomScore, "bottom"\)/);
  assert.match(script, /scoreMeter\(entry\.topScore, "top"\)/);
  // The dominant side names which one leads; it never replaces the other.
  assert.match(script, /function dominantCell\(entry\)/);
  assert.doesNotMatch(script, /combined extreme score/i);
});

test("the state badge carries the visual label the page is read by", () => {
  // BOTTOM CONFIRMED / TOP CONFIRMING is read across the Extreme and State
  // columns; the badge carries the whole phrase as its accessible name so the
  // cell still says which side it belongs to when read on its own.
  assert.match(script, /return entry\.dominant\.toUpperCase\(\) \+ " " \+ entry\.state;/);
  assert.match(script, /aria-label="' \+ escapeHtml\(label\)/);
  const label = script.slice(script.indexOf("function extremeLabel"), script.indexOf("function stateCell"));
  // The label is built from the extreme alone — no bias, no direction.
  assert.doesNotMatch(label, /bias|signal/i);
  for (const state of ["CONFIRMED", "CONFIRMING", "CANDIDATE", "WATCH", "NONE"]) {
    assert.match(script, new RegExp(state), `${state} must remain a renderable state`);
  }
});

test("the columns the page promises are all present", () => {
  for (const column of [
    "Pair", "Price", "Bottom", "Top", "Extreme", "State",
    "Setup", "Trend", "RSI", "Evidence", "Timeframe", "Freshness",
  ]) {
    assert.match(page, new RegExp(`<th>${column}</th>`), `${column} column is missing`);
  }
  for (const label of ["Price", "Bottom", "Top", "Extreme", "State", "Setup", "Trend", "RSI", "Evidence", "Timeframe", "Freshness"]) {
    assert.match(script, new RegExp(`data-label="${label}"`), `${label} cell label is missing`);
  }
});

test("evidence shows the engine's own components, lit only when they scored", () => {
  for (const [key, chip] of [
    ["priceLocation", "BB"],
    ["momentum", "RSI"],
    ["divergence", "DIV"],
    ["liquidity", "SWEEP"],
    ["volume", "VOL"],
    ["confirmation", "CONF"],
  ]) {
    assert.match(script, new RegExp(`\\["${key}", "${chip}"`), `${key} evidence chip is missing`);
  }
  assert.match(script, /components\[chip\[0\]\]/);
  assert.match(script, /entry\.reasons \|\| \[\]/);
});

test("ranking puts what has triggered above what is merely stretched", () => {
  assert.match(script, /var STATE_RANK = \{ CONFIRMED: 4, CONFIRMING: 3, CANDIDATE: 2, WATCH: 1, NONE: 0 \}/);
  // Score only breaks ties inside a tier.
  assert.match(script, /stateRank\(b\) - stateRank\(a\) \|\| peakScore\(b\) - peakScore\(a\)/);
  assert.match(script, /Math\.max\(S\.clampScore\(entry\.bottomScore\), S\.clampScore\(entry\.topScore\)\)/);
});

test("filters cover both sides and each confirmation tier, plus a Hide NONE default", () => {
  for (const filter of ["ALL", "BOTTOMS", "TOPS", "CONFIRMED", "CONFIRMING", "CANDIDATES"]) {
    assert.match(page, new RegExp(`data-filter="${filter}"`), `${filter} filter is missing`);
  }
  assert.match(page, /id="lx-hide-none" checked/, "weak rows are hidden by default so the page opens on what is stretched");
  assert.match(script, /hideNoneToggle\.checked/);
  assert.match(page, /id="lx-search"/);
});

test("BTC stays pinned as context even when the filters would hide it", () => {
  assert.match(script, /var PINNED_SYMBOLS = \["BTCUSDT"\]/);
  const pinned = script.slice(script.indexOf("var pinned = PINNED_SYMBOLS"), script.indexOf("var ranked ="));
  assert.doesNotMatch(pinned, /hideNoneToggle|matchesFilters/, "only the search narrows the pinned row");
  assert.match(script, /renderRow\(entry, null\)/);
  assert.match(script, /ranked\.map\(function \(entry, index\) \{ return renderRow\(entry, index \+ 1\); \}\)/);
});

test("freshness is shown per row, in the project's existing states", () => {
  assert.match(script, /S\.freshnessBadge\(entry\.freshness\)/);
  assert.match(shared, /FRESHNESS_LABELS/);
});

test("rows can be starred into My Trades, like the other screeners", () => {
  assert.match(page, /<script src="\/assets\/js\/admin-key\.js"><\/script>/);
  assert.match(script, /watchlist\.button\(symbol\)/);
  assert.match(script, /watchlist\.bind\(tbody\)/);
  assert.match(script, /watchlist\.load\(\)\.then\(function \(\) \{ load\(false\); \}\)/);
});

test("the page fits a phone: the wide table restacks as labelled cards", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 720px) {"));
  assert.match(mobile, /\.lx-table \{ min-width: 0; \}/);
  assert.match(mobile, /\.lx-table td\[data-label\]::before \{\s*content: attr\(data-label\)/);
  assert.match(mobile, /\.lx-table thead \{/);
});

test("state colour tracks how far evidence has got, not which side it favours", () => {
  // BOTTOM CONFIRMED and TOP CONFIRMED share one intensity: the tint must not
  // become a buy/sell colour code.
  assert.match(css, /\.lx-state--confirmed \{/);
  assert.match(css, /\.lx-state--candidate \{/);
  const stateBlock = css.slice(css.indexOf(".lx-state--confirmed"), css.indexOf(".lx-side {"));
  assert.doesNotMatch(stateBlock, /bottom|top/i);
});
