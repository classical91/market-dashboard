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

test("BTC is pinned as market context and never consumes a rank", () => {
  assert.match(page, /var PINNED_SYMBOLS = \['BTCUSDT'\]/);
  // Pinned rows are lifted out before the sort, so the comparator is untouched
  // and the first ranked row is #1 rather than #2.
  assert.match(page, /results\.filter\(function \(entry\) \{ return !isPinned\(entry\.symbol\); \}\)\.sort/);
  assert.match(page, /ranked\.map\(function \(entry, index\) \{ return renderExtremeRow\(entry, index \+ 1\); \}\)/);
  assert.match(page, /renderExtremeRow\(entry, null\)/);
  assert.match(page, /'<span class="ss-rank">#' \+ rank/);
});

test("The pinned card is tinted by extreme state, never by bias", () => {
  // A card that goes green whenever bias is bullish would rebuild the
  // LONG-67-with-a-confirmed-top confusion the bias rename removed.
  const pinState = page.slice(page.indexOf("function pinStateClass"), page.indexOf("function rowMarker"));
  assert.match(pinState, /extreme\.state/);
  assert.doesNotMatch(pinState, /signal|BIAS_LABELS|bias/i);
  assert.match(css, /\.ss-extreme-row--pinned\.ss-pin-state--confirmed \{ --pin-alpha/);
  assert.match(css, /\.ss-extreme-row--pinned\.ss-extreme-row--top \{ --pin-rgb: 255, 93, 93/);
  assert.match(css, /\.ss-extreme-row--pinned\.ss-extreme-row--bottom \{ --pin-rgb: 0, 184, 148/);
});

test("USDT.D renders as context with its scored columns visibly empty", () => {
  // It is a CRYPTOCAP index: no candles, no volume, so bias and extreme have
  // nothing to run on. Empty must read as "not scored", never as a zero.
  assert.match(page, /function renderDominanceRow\(dominance\)/);
  assert.match(page, /NOT SCORED/);
  assert.match(page, /Not scored — USDT\.D has no OHLCV/);
  assert.match(page, /ss-extreme-row--dominance/);
  // Its own vocabulary, kept distinct from the six-check bias.
  assert.match(page, /BUILDING HISTORY/);
  assert.match(page, /ss-dom-direction--/);
  assert.doesNotMatch(page.slice(page.indexOf("function renderDominanceRow"), page.indexOf("function renderExtremes")), /BULLISH|BEARISH/);
});

test("A missing or failed dominance read drops the row instead of faking one", () => {
  assert.match(page, /if \(!dominance \|\| dominance\.percent == null\) return ''/);
  assert.match(page, /renderExtremes\(data\.results \|\| \[\], data\.context \|\| null\)/);
});

test("Local extremes is the view the page opens on", () => {
  assert.match(page, /class="ss-view-tab is-active"[^>]+id="ss-tab-extremes" aria-selected="true"/);
  assert.match(page, /<section class="ss-view is-active" id="ss-view-extremes"/);
  // The bias view must be both inert and hidden, or its panels render beneath.
  assert.match(page, /id="ss-tab-signals" aria-selected="false"/);
  assert.match(page, /<section class="ss-view" id="ss-view-signals"[^>]*hidden>/);
});

test("Local extremes rows can be starred into My Trades, like Pattern Scanner", () => {
  assert.match(page, /<script src="\/assets\/js\/admin-key\.js"><\/script>/, "mutation needs the admin-key helper");
  assert.match(page, /data-role="track-btn"/);
  assert.match(page, /AdminKey\.fetch\('\/api\/watchlist'/);
  assert.match(page, /method: tracked \? 'DELETE' : 'POST'/, "the same star toggles both ways");
  // The row renders the star beside the chart link.
  assert.match(page, /tickerLink\(entry\.symbol\) \+ trackButton\(entry\.symbol\)/);
  assert.match(css, /\.ss-track-btn--active \{ color: #f5c542/);
});

test("Tracking is keyed by symbol and timeframe, and read before the first paint", () => {
  // The same token on 4h and on 1D are two separate watchlist entries, so the
  // star must reflect the timeframe currently on screen.
  assert.match(page, /function trackKey\(symbol, interval\) \{\s*return symbol \+ ':' \+ interval;/);
  assert.match(page, /trackedKeys\[trackKey\(symbol, intervalSelect\.value\)\]/);
  assert.match(page, /data-interval="' \+ escapeHtml\(intervalSelect\.value\)/);
  // Stars are correct on the first render rather than filling in a beat later.
  assert.match(page, /loadTracked\(\)\.then\(function \(\) \{ load\(false\); \}\)/);
});

test("The USDT.D context row carries no star: My Trades cannot scan it", () => {
  // It has no OHLCV, so a tracked entry would produce a card neither engine
  // could fill. The dominance row is built without a track button.
  const dominanceRow = page.slice(page.indexOf("function renderDominanceRow"), page.indexOf("function renderExtremes"));
  assert.doesNotMatch(dominanceRow, /track-btn|trackButton/);
});

test("Extremes rank by state first, so a confirmed turn outranks a stretched candidate", () => {
  assert.match(page, /var STATE_RANK = \{ CONFIRMED: 4, CONFIRMING: 3, CANDIDATE: 2, WATCH: 1, NONE: 0 \}/);
  // Score only breaks ties inside a tier.
  assert.match(page, /stateRank\(b\) - stateRank\(a\) \|\| peakScore\(b\) - peakScore\(a\)/);
});

test("The timeframe travels with the numbers and survives a reload", () => {
  // A card scrolled below the selector still says which clock produced it.
  assert.match(page, /<span class="ss-summary-tf">' \+ escapeHtml\(intervalSelect\.value\)/);
  assert.match(css, /\.ss-summary-tf \{/);
  assert.match(page, /var INTERVAL_STORAGE_KEY = 'signalScreenerInterval'/);
  assert.match(page, /function restoreInterval\(\)/);
  assert.match(page, /intervalSelect\.addEventListener\('change', function \(\) \{ rememberInterval\(\); load\(false\); \}\)/);
});

test("Directional bias rows can be starred too, and both views share one listener", () => {
  assert.match(page, /'<td><span class="ss-token-head">' \+ tickerLink\(entry\.symbol\) \+ trackButton\(entry\.symbol\)/);
  assert.match(page, /\[extremeTbody, tbodyLong, tbodyShort, tbodyFlat\]\.forEach\(function \(tbody\)/);
  // A star toggled in one view must repaint the other.
  assert.match(page, /renderSplit\(lastResults\);\s*\n\s*renderExtremes\(lastResults, lastContext\);/);
  // Six columns still fit a 320px screen: the star gives up the most room.
  assert.match(css, /\.ss-track-btn \{ padding: 2px 3px; font-size: 11px; \}/);
});
