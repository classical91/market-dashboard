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

test("Overview v2 restores the mini portal's original shortcuts and full category launcher", () => {
  assert.match(page, /id="mini-x-portal" aria-labelledby="ov2-portal-heading"/);
  assert.match(page, /<h2 id="ov2-portal-heading">Mini Intelligent Portal<\/h2>/);
  assert.match(page, /href="\/x-intelligence\.html\?template=markets"/);
  assert.match(page, /href="\/youtube-v2\.html\?category=category%3Acrypto"/);
  assert.match(page, /href="\/intelligence-portal\.html"/);
  assert.ok(page.indexOf('id="mini-x-portal"') < page.indexOf('id="ov2-news"'));
  assert.match(css, /@media \(max-width: 640px\) \{ \.ov2-portal \{ grid-template-columns: 1fr/);
  assert.match(css, /\.ov2-main \.ov2-portal-card:focus-visible/);
  assert.doesNotMatch(sidebar, /label: "Mini X Portal"/);
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

test("Overview v2 shows BTC Research right under News desks, styled by the shared sheet", () => {
  const news = page.indexOf('id="ov2-news"');
  const btcAt = page.indexOf('id="btc-research"');
  assert.ok(news !== -1 && btcAt > news, "BTC Research follows News desks");
  assert.ok(btcAt < page.indexOf('class="ov2-top"'), "and sits above the status / Market Matrix row");
  assert.match(page, /<details class="ov-btc" id="btc-research">/);
  assert.match(page, /assets\/js\/overview-btc-research\.js/);
  assert.match(page, /assets\/styles\/overview-btc-research\.css/);
  assert.match(read("public/assets/styles/overview-btc-research.css"), /\.ov-btc \{/);
});
