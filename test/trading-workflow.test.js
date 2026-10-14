"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const terminal = read("public/terminal-suite.html");
const terminalJs = read("public/assets/js/terminal-suite.js");
const overviewPage = read("public/index.html");
const overviewJs = read("public/assets/js/overview.js");
const sidebar = read("public/assets/js/sidebar.js");

test("Terminal links each workflow step to the page that owns it, in order", () => {
  const start = terminal.indexOf('id="trading-workflow"');
  assert.ok(start > -1, "the workflow strip is missing");
  const strip = terminal.slice(start, terminal.indexOf("</nav>", start));
  const steps = [
    'href="#macro-regime"',
    'href="/directional-bias.html"',
    'href="/local-extremes.html"',
    'href="/pattern-scanner.html"',
    'href="https://trading-strategy-production-1b41.up.railway.app/"',
    'href="/pattern-scanner-trades.html"',
  ];
  let cursor = -1;
  for (const step of steps) {
    const next = strip.indexOf(step, cursor + 1);
    assert.ok(next > cursor, `${step} is missing or out of order`);
    cursor = next;
  }
  // The Decision Engine is the user's own external app, opened in a new tab.
  assert.match(strip, /railway\.app\/" target="_blank" rel="noopener"/);
  for (const href of ["/directional-bias.html", "/local-extremes.html", "/pattern-scanner.html", "/pattern-scanner-trades.html"]) {
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", href)), `${href} must exist`);
  }
});

test("Overview hands an asset to Terminal, which opens it on first load", () => {
  assert.match(overviewJs, /href="\/terminal-suite\.html\?symbol=\$\{encodeURIComponent\(s\.symbol\)\}"/);
  assert.match(overviewPage, /href="\/terminal-suite\.html#macro-regime">Open Terminal →/);
  assert.match(terminalJs, /new URLSearchParams\(window\.location\.search\)\.get\("symbol"\)/);
  assert.match(terminalJs, /function openRequestedAsset\(\)/);
  assert.match(terminalJs, /isn't in the Terminal feed/);
});

test("Overview is the first entry in the sidebar, with Terminal right after it", () => {
  const workspace = sidebar.slice(sidebar.indexOf("var workspace"));
  const overview = workspace.indexOf('label: "Overview"');
  const terminalEntry = workspace.indexOf('label: "Terminal Suite"');
  const trades = workspace.indexOf('label: "Trades"');
  assert.ok(overview > -1 && terminalEntry > overview && trades > terminalEntry);
});
