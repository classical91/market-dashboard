"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Trading Lab UI is strategy-account first and has no active legacy selector", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");

  assert.doesNotMatch(html, /Portfolio Book/i);
  assert.doesNotMatch(html, /id=["']tl-book["']/i);
  assert.doesNotMatch(js, /bookSelect/);
  assert.match(html, /Legacy Paper History/i);
  assert.match(html, /read-only/i);
  assert.match(js, /data-strategy=/);
  assert.match(js, /data\.accounts/);
  assert.match(js, /data\.legacyBooks/);
});

test("Trading Lab UI removes unattributed persistent trade actions", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");

  assert.doesNotMatch(js, /Paper trade/);
  assert.doesNotMatch(js, /candidate-trade/);
  assert.match(html, /unattributed, non-persistent analysis context/i);
  assert.match(js, /Research only/);
});

test("strategy cards separate research status from live demo state and expose Account Activity", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");
  const css = read("public/assets/styles/trading-lab.css");

  assert.match(html, /Research status and live demo state are separate/i);
  assert.match(html, /id="tl-activity-shell"/);
  assert.match(js, /Research: /);
  assert.match(js, /LIVE DEMO: /);
  assert.match(js, /What is it doing\?/);
  assert.match(js, /Current intent/i);
  assert.match(js, /Decision Pipeline/i);
  assert.match(js, /How this strategy trades/i);
  assert.match(js, /Recent Activity/i);
  assert.match(js, /setInterval/);
  assert.match(css, /tl-activity-panel/);
  assert.match(css, /prefers-reduced-motion/);
});

test("every strategy card renders a description sourced from metadata", () => {
  const js = read("public/assets/js/trading-lab.js");
  const css = read("public/assets/styles/trading-lab.css");
  const { listStrategyAccounts } = require("../src/services/trading/strategy-accounts");

  // Rendered from the account payload, not composed in the dashboard.
  assert.match(js, /account\.shortDescription/);
  assert.match(js, /tl-acct-desc/);
  assert.match(css, /\.tl-acct-desc/);

  // Every account the page will be handed actually carries the field, so
  // "renders a description" is true for all five rather than for the one
  // someone happened to check.
  for (const account of listStrategyAccounts()) {
    assert.ok(account.shortDescription, `${account.id} would render an empty description`);
  }

  // Escaped like every other value on the card.
  assert.match(js, /escapeHtml\(account\.shortDescription\)/);
});

test("the card description stays separate from Current intent", () => {
  const js = read("public/assets/js/trading-lab.js");

  // Two different sources: one static metadata field, one live runner field.
  assert.match(js, /account\.shortDescription/);
  assert.match(js, /runner\.currentIntent/);
  assert.match(js, /Current intent/i);
  // The description must not be fed from runner state, which changes per tick.
  assert.doesNotMatch(js, /intent\.(title|summary)\s*\|\|\s*account\.shortDescription/);
  assert.doesNotMatch(js, /account\.shortDescription\s*\|\|\s*intent\./);
});

test("the detailed rule inspector is unchanged", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");

  // The short card line is an addition, not a replacement for the full
  // breakdown behind "What is it doing?".
  assert.match(js, /What is it doing\?/);
  assert.match(js, /How this strategy trades/i);
  for (const section of ["Purpose", "Looks For", "Long Entry", "Short Entry", "Trend Filter", "Stop", "Target", "Position Sizing"]) {
    assert.match(js, new RegExp(section.replace(/ /g, "\\s*"), "i"), `${section} row is missing`);
  }
  assert.match(html, /id="tl-activity-shell"/);
});

test("card descriptions are bounded in metadata rather than clipped in JavaScript", () => {
  const js = read("public/assets/js/trading-lab.js");
  const css = read("public/assets/styles/trading-lab.css");

  // No substring/slice/ellipsis applied to the description in the renderer —
  // a clipped sentence loses its qualifying clause and misdescribes the rules.
  assert.doesNotMatch(js, /shortDescription[^\n]*\.(slice|substr|substring)\(/);
  // Line clamping is a display safety net only.
  assert.match(css, /-webkit-line-clamp/);
});

test("the card clamp cannot clip a valid description", () => {
  const css = read("public/assets/styles/trading-lab.css");
  const { listStrategyAccounts } = require("../src/services/trading/strategy-accounts");

  // A two-line clamp clipped BananaGun's "Not candle-based." and Donchian's
  // "price channel." — the qualifying clause sits at the end and is the first
  // thing lost, turning a correct description into a confident half-sentence.
  const clamp = css.match(/\.tl-acct-desc[^}]*-webkit-line-clamp:\s*(\d+)/s);
  assert.ok(clamp, "the description needs a line-clamp safety net");
  assert.ok(Number(clamp[1]) >= 3, "three lines, or the longest valid description clips");

  // And no tighter override at a wider breakpoint, which is how the clipping
  // got in the first time.
  const overrides = css.match(/\.tl-acct-desc\s*\{\s*-webkit-line-clamp:\s*(\d+)/g) || [];
  for (const rule of overrides) {
    assert.ok(Number(rule.match(/(\d+)/)[1]) >= 3, `a breakpoint tightens the clamp: ${rule}`);
  }

  // The metadata bound and the clamp have to agree: 140 chars must fit.
  for (const account of listStrategyAccounts()) {
    assert.ok(account.shortDescription.length <= 140, account.id);
  }
});
