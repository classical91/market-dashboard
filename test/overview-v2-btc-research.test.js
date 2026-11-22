"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const btc = require("../public/assets/js/overview-v2-btc-research");

const PUBLIC = path.join(__dirname, "..", "public");
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), "utf8");

test("Overview v2 has a BTC Research dropdown under News desks that loads Crypto Hub's section", () => {
  const html = read("overview-v2.html");
  const news = html.indexOf('id="ov2-news"');
  const btcAt = html.indexOf('id="btc-research"');
  assert.ok(news !== -1 && btcAt > news, "BTC Research sits after News desks");
  assert.ok(btcAt < html.indexOf('class="ov2-top"'), "and before the system strip");
  assert.match(html, /<details class="ov2-news ov2-btc" id="btc-research">/);
  assert.match(html, /assets\/js\/overview-v2-btc-research\.js/);
  // The source of truth exists where the dropdown reads it from.
  assert.match(read("crypto.html"), /<div class="cards" id="crypto-research">/);
});

test("sidebar links Overview v2 → BTC Research", () => {
  assert.match(read("assets/js/sidebar.js"), /\{ href: "\/overview-v2#btc-research", label: "BTC Research" \}/);
});

test("render keeps top-level links, nested dropdowns and their open state", () => {
  const data = {
    links: [{ href: "https://cryptoquant.com/insights/research", badge: "CQ RESEARCH", badgeStyle: "background:var(--purple-bg);color:var(--purple)", title: "CryptoQuant Research", src: "cryptoquant.com" }],
    groups: [
      { id: "btc-long-short", label: "Long vs Short", links: [{ href: "https://coinalyze.net/bitcoin/long-short-ratio/", badge: "L/S RATIO", badgeStyle: "", title: "Chart Ratio", src: "coinalyze.net" }] },
      { id: "technical-analysis", label: "Technical Analysis", links: [] },
    ],
  };
  const html = btc.render(data, ["btc-long-short"]);
  assert.equal(btc.countLinks(data), 2);
  assert.match(html, /href="https:\/\/cryptoquant\.com\/insights\/research" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /style="background:var\(--purple-bg\);color:var\(--purple\)"/);
  assert.match(html, /<details class="ov2-btc-sub" data-group="btc-long-short" open>/);
  assert.match(html, /<details class="ov2-btc-sub" data-group="technical-analysis">/);
  assert.match(html, /No links yet\./);
  assert.match(btc.render({ links: [], groups: [] }), /No Bitcoin Research links/);
});

test("render escapes text and drops unsafe hrefs and styles", () => {
  const html = btc.render({ links: [
    { href: "javascript:alert(1)", badge: "X", badgeStyle: "", title: "bad", src: "" },
    { href: "https://ok.example/", badge: "<b>", badgeStyle: "background:url(x)", title: "A & B", src: "" },
  ], groups: [] });
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /style=""/);
});
