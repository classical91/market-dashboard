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
