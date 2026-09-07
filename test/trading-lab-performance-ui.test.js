"use strict";

// The Backtest Lab performance panel where it meets the page.
//
// The panel's LOGIC is tested directly in performance-panel.test.js — that is
// the point of keeping it in its own module. What is left for a file-reading
// test is the wiring the browser needs and the promises the page makes:
// the module is actually loaded, the panel is actually mounted, the three
// request states are distinguishable, the interactions are actually bound, and
// nothing that was on this page before has been quietly dropped.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const html = read("public/trading-lab.html");
const js = read("public/assets/js/trading-lab.js");
const css = read("public/assets/styles/trading-lab.css");
const panel = read("public/assets/js/performance-panel.js");

test("the panel module is loaded before the page script that uses it", () => {
  const module = html.indexOf("/assets/js/performance-panel.js");
  const page = html.indexOf("/assets/js/trading-lab.js");
  assert.ok(module > 0, "performance-panel.js is not loaded by the page");
  assert.ok(module < page, "the panel module must load before trading-lab.js");
});

test("the panel module works in both a browser and the test runner", () => {
  // The same arrangement x-freshness.js uses: one file, loaded as a script by
  // the page and required as a module by the tests, so what ships is what is
  // under test rather than a copy of it.
  assert.match(panel, /module\.exports = api/);
  assert.match(panel, /root\.PerformancePanel = api/);
  // ...and it stays free of the DOM, or it could not be required at all.
  assert.doesNotMatch(panel, /\bdocument\./);
  assert.doesNotMatch(panel, /\bfetch\(/);
});

test("a finished backtest mounts the panel with the run's own symbol and window", () => {
  assert.match(js, /renderPerformancePanel\(/);
  assert.match(js, /id="tl-bt-performance"/);
  // Fed from the response, not from the form: a reader who changed the symbol
  // and has not re-run must not see the new symbol labelling the old numbers.
  assert.match(js, /symbol: data\.symbol/);
  assert.match(js, /interval: data\.interval/);
  assert.match(js, /from: data\.from/);
  assert.match(js, /to: data\.to/);
});

test("all six required headline stats are on the panel", () => {
  for (const label of ["Net P&L", "Return", "Max drawdown", "Total trades", "Win rate", "Profit factor"]) {
    assert.ok(js.includes(`statTile("${label}"`), `the panel is missing the ${label} tile`);
  }
});

test("the line, the legend key and the tooltip agree on the run's colour", () => {
  // Decided once. When each picked its own, a losing run drew a red line
  // beneath a green legend swatch, and the legend then contradicts the chart.
  assert.match(js, /function strategyColor\(model\)/);
  assert.strictEqual((js.match(/(?<!function )strategyColor\(model\)/g) || []).length, 3);
  assert.doesNotMatch(js, /tl-perf-swatch--strategy"><\/i>/);
});

test("the benchmark is drawn, named and explained", () => {
  assert.match(js, /Buy &amp; hold/);
  assert.match(js, /tl-perf-swatch--benchmark/);
  assert.match(css, /\.tl-perf-swatch--benchmark/);
  // The assumptions behind the second line are stated on the card. A benchmark
  // whose costs a reader has to guess at is not evidence.
  assert.match(js, /same starting capital and the same fee and slippage assumptions/);
  assert.match(js, /marked to market at the end rather than charged an exit/);
});

test("the hover tooltip reports the time and both values", () => {
  assert.match(js, /data-perf-tooltip/);
  assert.match(js, /PANEL\.formatDateTime\(point\.at\)/);
  assert.match(js, /PANEL\.formatUsd\(point\.strategy\)/);
  assert.match(js, /PANEL\.formatUsd\(point\.benchmark\)/);
  assert.match(css, /\.tl-perf-tooltip/);
  // The tooltip must not swallow the pointer events that position it.
  assert.match(css, /\.tl-perf-tooltip[^}]*pointer-events:\s*none/s);
});

test("zoom and pan are bound for pointer, wheel, pinch and keyboard", () => {
  assert.match(js, /addEventListener\(\s*\n?\s*"wheel"/);
  assert.match(js, /PANEL\.zoomView\(/);
  assert.match(js, /PANEL\.panView\(/);
  assert.match(js, /addEventListener\("pointerdown"/);
  assert.match(js, /addEventListener\("pointermove"/);
  // Two fingers is a zoom, not a pan.
  assert.match(js, /pinch/);
  // Wheel zoom has to be able to preventDefault, or the page scrolls instead.
  assert.match(js, /\{ passive: false \}/);
  // Keyboard parity: a chart only reachable with a mouse hides half its
  // numbers from anyone who does not use one.
  assert.match(js, /addEventListener\("keydown"/);
  assert.match(js, /ArrowRight/);
});

test("Reset Zoom is a visible control, not a gesture to discover", () => {
  assert.match(js, /data-perf-reset/);
  assert.match(js, /Reset Zoom/);
  assert.match(js, /resetBtn\.addEventListener\("click"/);
  assert.match(js, /view = PANEL\.fullView\(\);/);
  // Disabled while there is nothing to reset, and re-enabled by drawing —
  // an always-live button that does nothing is a button nobody trusts.
  assert.match(js, /resetBtn\.disabled = PANEL\.isFullView\(view\)/);
  assert.match(css, /\.tl-perf-reset\[disabled\]/);
  // The gesture hint may be hidden on a phone; the control never is.
  const mobile = css.slice(css.indexOf("@media (max-width: 720px)"));
  assert.doesNotMatch(mobile, /\.tl-perf-reset[^}]*display:\s*none/s);
});

test("loading, empty and error states are three different things on screen", () => {
  assert.match(js, /function btLoading\(/);
  assert.match(js, /function btError\(/);
  assert.match(js, /btResult\.innerHTML = btLoading\(/);
  assert.match(js, /btResult\.innerHTML = btError\(/);
  assert.match(js, /btCompareResult\.innerHTML = btLoading\(/);
  assert.match(js, /btCompareResult\.innerHTML = btError\(/);
  // A failure announced to assistive tech as an alert, progress as a status.
  assert.match(js, /role="alert"/);
  assert.match(js, /role="status" aria-live="polite"/);
  // ...and visually distinct, rather than a second grey "nothing here" box.
  assert.match(css, /\.tl-perf-error[^}]*var\(--coral-bg\)/s);
  assert.match(css, /\.tl-perf-spinner/);
  assert.match(css, /prefers-reduced-motion[^}]*\.tl-perf-spinner/s);
  // The empty state still says why rather than going blank.
  assert.match(js, /tl-perf--empty/);
  assert.match(js, /escapeHtml\(model\.reason\)/);
});

test("the chart is reachable and describable without sight or a mouse", () => {
  assert.match(js, /tabindex="0"/);
  assert.match(js, /panelSummarySentence/);
  assert.match(js, /aria-label="' \+ escapeHtml\(panelSummarySentence/);
  // A live readout so a keyboard user hears the bar they moved onto.
  assert.match(js, /data-perf-readout/);
  assert.match(css, /\.tl-perf-chart:focus-visible/);
  // A focusable chart has to say what its keys do, and the sighted hint cannot
  // carry that: it is hidden outright on a phone.
  assert.match(js, /aria-describedby="tl-perf-help"/);
  assert.match(js, /id="tl-perf-help"/);
  assert.match(js, /arrows move through the bars/);
  assert.match(css, /\.tl-perf-sr/);
  // Decorative SVG is hidden from the accessibility tree rather than read out
  // as a wall of coordinates — the sentence above is the text equivalent.
  assert.match(js, /aria-hidden="true" focusable="false"/);
});

test("every value the panel injects is escaped", () => {
  // The panel renders API-supplied strings — symbol, interval, timestamps and
  // the benchmark's own unavailability reason — straight into innerHTML.
  const start = js.indexOf("function renderPerformancePanel(");
  const end = js.indexOf("function renderBacktest(", start);
  const body = js.slice(start, end);
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /\+ info\.symbol/);
  assert.doesNotMatch(body, /\+ point\.at/);
  assert.match(body, /escapeHtml\(info\.symbol/);
  assert.match(body, /escapeHtml\(PANEL\.formatDateTime\(point\.at\)\)/);
});

test("the panel is responsive rather than dropped on a phone", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 720px)"));
  // The chart shrinks; it does not disappear, because the shape of the
  // strategy-against-benchmark comparison is the one thing a list of numbers
  // cannot carry.
  assert.doesNotMatch(mobile, /\.tl-perf-plot[^}]*display:\s*none/s);
  assert.match(mobile, /\.tl-perf-plot,\s*\n\s*\.tl-perf-skeleton-plot \{ height: 180px; \}/);
  // The four-column comparison table restacks instead of scrolling sideways.
  assert.match(mobile, /\.tl-perf-compare[^{]*\{\s*\n?\s*display: block/s);
  assert.match(mobile, /\.tl-perf-compare td::before/);
  assert.match(js, /data-label="Buy &amp; hold"/);
  // Horizontal page overflow is the failure mode this guards: the wide table
  // is inside the shared scroll wrapper, and the readout truncates instead of
  // pushing the card wider.
  assert.match(js, /de-table-wrap"><table class="de-table tl-perf-compare/);
  assert.match(css, /\.tl-perf-readout[^}]*min-width:\s*0/s);
  assert.match(css, /\.tl-perf-readout[^}]*text-overflow:\s*ellipsis/s);
});

/* ── Regression: nothing that was already on this page may have gone ────── */

test("the Backtest Lab controls are all still there", () => {
  for (const id of [
    "tl-bt-symbol",
    "tl-bt-interval",
    "tl-bt-strategy",
    "tl-bt-mode",
    "tl-bt-costs",
    "tl-bt-run",
    "tl-bt-compare",
    "tl-bt-options",
    "tl-bt-result",
    "tl-bt-compare-result",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `the ${id} control is gone`);
  }
  assert.match(js, /options:\s*selectedOptions\(\)/);
  assert.match(js, /executionMode: btMode\.value/);
  assert.match(js, /costScenario: btCosts\.value/);
});

test("the Pine Script copy actions still work", () => {
  assert.match(js, /data-copy-pine/);
  assert.match(js, /Copy Pine Script/);
  assert.match(js, /fetch\("\/pine\/"/);
  assert.match(js, /function copyPineScript\(/);
  assert.match(js, /navigator\.clipboard\.writeText/);
});

test("the rest of the backtest result survived the panel landing above it", () => {
  // The panel is an addition. The R-multiple distribution, the caveats, the
  // costs line and the execution-mode disclosure all still render.
  assert.match(js, /rMultipleChart\(data\.trades\)/);
  assert.match(js, /costsLine\(data\.costs, data\.costScenario\)/);
  assert.match(js, /executionModeLabel\(data\.executionMode\)/);
  assert.match(js, /appliedExecutionLabel\(data\.executionApplied\)/);
  assert.match(js, /still open at the end/);
  // ...and the comparison card is untouched.
  assert.match(js, /function renderComparison\(/);
  assert.match(js, /miniEquity\(r\.equityCurve/);
});

test("the equity chart the panel replaced was removed, not left behind", () => {
  // Two equity charts on one card, one of them without the benchmark, is the
  // duplicated-logic outcome this panel exists to avoid.
  assert.doesNotMatch(js, /function equityChart\(/);
  assert.doesNotMatch(js, /function attachCrosshair\(/);
  assert.doesNotMatch(js, /function fmtDay\(/);
});
