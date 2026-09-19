"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "..", "public", "signal-screener.html"), "utf8");

test("Signal Screener exposes directional and local-extreme engines as separate views", () => {
  assert.match(page, /role="tab"[^>]+ss-tab-signals/);
  assert.match(page, /role="tab"[^>]+ss-tab-extremes/);
  assert.match(page, /id="ss-view-signals"/);
  assert.match(page, /id="ss-view-extremes"/);
});

test("Local Extremes keeps bottom and top scores independent and explains confirmation", () => {
  assert.match(page, /<th>Bottom<\/th><th>Top<\/th>/);
  assert.match(page, /A high bottom score can coexist with a strong BEARISH bias/);
  assert.match(page, /A candidate has exhaustion evidence/);
  assert.doesNotMatch(page, /combined extreme score/i);
});

const css = fs.readFileSync(path.join(__dirname, "..", "public", "assets", "styles", "signal-screener.css"), "utf8");

test("Signal Screener panels can shrink below the table width so the page never scrolls sideways", () => {
  // A grid item defaults to min-width:auto — the table's 640px min-width —
  // which pushed the whole page past the viewport on a phone.
  assert.match(css, /\.ss-split > \.ss-panel\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.ss-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
});

test("Signal Screener fits a phone: signal columns tighten, extremes restack as labelled cards", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 720px) {", css.indexOf(".ss-chart-link")));
  assert.match(mobile, /\.ss-table\s*\{\s*min-width:\s*0/);
  assert.match(mobile, /\.ss-chart-link-text\s*\{\s*display:\s*none/);
  assert.match(mobile, /\.ss-extreme-table td\[data-label\]::before\s*\{\s*content:\s*attr\(data-label\)/);
  // The hidden header is what the per-cell labels stand in for.
  assert.match(mobile, /\.ss-extreme-table thead\s*\{/);
});

test("Extremes cells carry the labels the phone layout renders, and the chart link keeps a name without its text", () => {
  ["Price", "Bias", "Bottom", "Top", "Extreme state", "EMA200", "Reasons"].forEach((label) => {
    assert.match(page, new RegExp('data-label="' + label + '"'));
  });
  assert.match(page, /aria-label="'\s*\+\s*label/);
  assert.match(page, /class="ss-chart-link-text">Chart</);
});

test("Directional scores read as bias, not as an entry instruction", () => {
  // LONG 67 looked like "go long now"; it is four of six checks agreeing.
  assert.match(page, /var BIAS_LABELS = \{ LONG: 'BULLISH', SHORT: 'BEARISH', FLAT: 'NEUTRAL' \}/);
  assert.match(page, /biasLabel\(entry\.signal\)/);
  assert.match(page, /<th>Directional bias<\/th>/);
  assert.doesNotMatch(page, />\s*Signal confluence\s*</);
});

test("The API's own LONG/SHORT values are untouched — the rename is display only", () => {
  // Grouping, row colour and the panels still switch on the wire values, so
  // the bot, the decision engine and the alerts keep working unchanged.
  assert.match(page, /r\.signal === 'LONG'/);
  assert.match(page, /r\.signal === 'SHORT'/);
  assert.match(page, /entry\.signal === 'LONG' \? 'ss-row--long'/);
});

test("Bias and extreme stay independent: neither one rewrites the other", () => {
  // All four bias/extreme pairings must remain renderable — a BULLISH bias
  // with TOP CONFIRMED is information, not a contradiction to be corrected.
  assert.match(page, /all four combinations are legitimate/);
  assert.doesNotMatch(page, /dominant === 'top'[^\n]*(BEARISH|SHORT)/);
  assert.doesNotMatch(page, /dominant === 'bottom'[^\n]*(BULLISH|LONG)/);
  // extremeStateLabel reads only the extreme; signalBadge reads only the bias.
  const stateLabel = page.slice(page.indexOf("function extremeStateLabel"), page.indexOf("function renderExtremeRow"));
  assert.doesNotMatch(stateLabel, /entry\.signal|BIAS_LABELS/);
});

test("LONG/SHORT stay reserved for pages that publish an actual setup", () => {
  assert.match(page, /LONG \/ SHORT stay reserved for pages that publish an actual setup/);
  assert.match(page, /Bias is not an entry/);
});
