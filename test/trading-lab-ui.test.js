"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Backtest Lab is strategy-account first and has no active legacy selector", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");

  assert.doesNotMatch(html, /Portfolio Book/i);
  assert.doesNotMatch(html, /id=["']tl-book["']/i);
  assert.doesNotMatch(js, /bookSelect/);
  assert.match(js, /data-strategy=/);
  assert.match(js, /data\.accounts/);
});

test("the archived ledgers are still readable, on the page that now owns them", () => {
  // Legacy Paper History moved to Signal Diagnostics — it serves no demo
  // account. The guarantee that it stays readable and read-only did not move
  // with it by accident, so it is asserted where the content now lives.
  const html = read("public/signal-diagnostics.html");
  const js = read("public/assets/js/signal-diagnostics.js");

  assert.match(html, /Legacy Paper History/i);
  assert.match(html, /read-only/i);
  assert.match(js, /data\.legacyBooks/);
  // And it is gone from the Lab rather than duplicated across both pages.
  assert.doesNotMatch(read("public/trading-lab.html"), /Legacy Paper History/i);
});

test("no page offers an unattributed persistent trade action", () => {
  // The property is about both pages now: the Decision Engine candidates table
  // moved to Signal Diagnostics, and neither page may offer a way to turn one
  // of those plans into a persistent trade.
  for (const file of ["public/assets/js/trading-lab.js", "public/assets/js/signal-diagnostics.js"]) {
    assert.doesNotMatch(read(file), /Paper trade/, file);
    assert.doesNotMatch(read(file), /candidate-trade/, file);
  }

  // And the reason is stated where the candidates are shown.
  assert.match(read("public/signal-diagnostics.html"), /unattributed, non-persistent analysis context/i);
  assert.match(read("public/assets/js/signal-diagnostics.js"), /Research only/);
});

test("the Lab is renamed and points at where the moved panels went", () => {
  const html = read("public/trading-lab.html");

  assert.match(html, /Backtest Lab/);
  assert.doesNotMatch(html, /&#129514; Trading Lab/);
  assert.match(read("public/assets/js/sidebar.js"), /label: "Backtest Lab"/);

  // The CARDS are gone from the Lab. Checked as card titles rather than as bare
  // phrases: the regime note legitimately explains that the live scanner
  // decides its own eligibility, and banning the words would forbid the
  // sentence that says these systems are separate.
  for (const title of ["Decision Engine Candidates", "Signal Bot Would-Have-Traded", "Live Scanner"]) {
    assert.ok(
      !html.includes(`<div class="de-card-title">${title}</div>`),
      `the ${title} card is still on the Lab page`,
    );
  }
  // And their mount points went with them.
  for (const id of ["tl-candidates-tbody", "tl-signal-actions-tbody", "tl-scanner", "tl-legacy-books"]) {
    assert.ok(!html.includes(id), `${id} is orphaned on the Lab page`);
  }
  // ...and reachable rather than simply deleted.
  assert.match(html, /signal-diagnostics\.html/);
});

test("Signal Diagnostics is reachable from the sidebar under Signal Screener", () => {
  const sidebar = read("public/assets/js/sidebar.js");
  const screener = sidebar.indexOf('/signal-screener.html');
  const diagnostics = sidebar.indexOf('/signal-diagnostics.html');

  assert.ok(diagnostics > -1, "the page is not in the sidebar");
  assert.ok(diagnostics > screener, "it should sit under Signal Screener");
});

test("the Lab offers the timeframes the screener can actually fetch", () => {
  const html = read("public/trading-lab.html");
  const { INTERVAL_MAP } = require("../src/services/signal-screener");

  // Every interval the backtest selector offers must be one the candle source
  // can serve — an option that 400s is worse than an absent one.
  const offered = [...html.matchAll(/<option value="([^"]+)"[^>]*>[^<]*<\/option>/g)]
    .map((m) => m[1])
    .filter((value) => /^\d+[mhDW]$/.test(value));
  for (const interval of offered) {
    assert.ok(INTERVAL_MAP[interval], `the UI offers "${interval}" but the screener cannot fetch it`);
  }
  // And the widening actually happened.
  assert.match(html, /value="1m"/);
  assert.match(html, /value="15m"/);
  assert.match(html, /value="1W"/);
});

test("strategy cards separate research status from live demo state and expose Account Activity", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");
  const css = read("public/assets/styles/trading-lab.css");

  assert.match(html, /Research status and demo trading state are separate/i);
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

test("the dashboard observes autonomous experiments and cannot alter them", () => {
  const js = read("public/assets/js/trading-lab.js");
  const css = read("public/assets/styles/trading-lab.css");

  // A runner-owned position gets a tag, not a Close button.
  assert.match(js, /autonomousOwner/);
  assert.match(js, /tl-autonomous-tag/);
  assert.match(css, /\.tl-autonomous-tag/);

  // Mark to market is disabled for an autonomous account rather than left to
  // bounce off the API guard.
  assert.match(js, /syncAutonomousControls/);
  assert.match(js, /markBtn\.disabled = locked/);
  assert.match(js, /LIVE DEMO — AUTONOMOUS/);
  assert.match(css, /\.tl-autonomous-banner/);
});

test("everything needed to inspect an autonomous account stays visible", () => {
  const html = read("public/trading-lab.html");
  const js = read("public/assets/js/trading-lab.js");

  // Locking the controls must not have removed the observation surface.
  assert.match(js, /Current intent/i);
  assert.match(js, /Decision Pipeline/i);
  assert.match(js, /How this strategy trades/i);
  assert.match(js, /Recent Activity/i);
  assert.match(js, /account\.shortDescription/);
  assert.match(js, /What is it doing\?/);
  assert.match(js, /Equity/);
  assert.match(html, /id="tl-activity-shell"/);
});

test("zero trades can never be confused with a dead runner", () => {
  const js = read("public/assets/js/trading-lab.js");
  const css = read("public/assets/styles/trading-lab.css");

  // Every one of the six numbers is on the card. Without them an account that
  // has processed a thousand candles and found no setup renders exactly like
  // one whose runner never started.
  for (const label of ["Markets", "Candles", "Signals", "Trades", "Blocked by risk", "Errors"]) {
    assert.ok(js.includes(`panelStat("${label}"`), `the status panel is missing ${label}`);
  }
  assert.match(js, /counters\.candlesProcessed/);
  assert.match(js, /counters\.signalsGenerated/);
  assert.match(js, /counters\.signalsBlockedByRisk/);
  assert.match(js, /counters\.executionErrors/);

  // A refused signal is shown with its reason, not swallowed.
  assert.match(js, /lastRefusedSignal/);
  assert.match(js, /Last refused/);
  // And a partly-broken account says so rather than reading healthy because
  // nineteen of twenty markets are fine.
  assert.match(js, /runnersErrored/);

  assert.match(css, /\.tl-acct-panel/);
  assert.match(css, /\.tl-acct-stat/);
  assert.match(css, /\.tl-acct-refused/);
  // Numbers must not clip: the label is what yields when space runs out.
  assert.match(css, /\.tl-acct-stat strong[^}]*flex:\s*none/s);
});
