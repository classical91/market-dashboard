"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const page = read("public/overview-v2.html");
const css = read("public/assets/styles/overview-v2.css");
const sidebar = read("public/assets/js/sidebar.js");
const terminal = read("public/terminal-suite.html");

test("Overview v2 no longer carries the Mini X Portal", () => {
  assert.doesNotMatch(page, /mini-x-portal|Mini X Portal|ov2-portal/);
  assert.doesNotMatch(css, /ov2-portal/);
  assert.doesNotMatch(sidebar, /mini-x-portal|label: "Mini X Portal"/);
});

test("Overview v2 holds the TradingView technical ratings Terminal links to", () => {
  assert.match(terminal, /href="\/#technical-analysis"/);
  assert.match(page, /id="technical-analysis"/);
  for (const symbol of ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT", "AMEX:SPY", "NASDAQ:QQQ", "TVC:DXY"]) {
    assert.ok(page.includes(`"symbol": "${symbol}"`), `${symbol} rating missing from Overview v2`);
  }
  assert.match(page, /Technical Ratings &middot; TradingView/);
  assert.match(page, /href="\/directional-bias\.html"/);
});
