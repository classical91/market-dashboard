"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const btc = require("../public/assets/js/overview-btc-research");

const PUBLIC = path.join(__dirname, "..", "public");
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), "utf8");

test("BTC Research belongs to Overview v2 and loads Crypto Hub's section", () => {
  assert.doesNotMatch(read("index.html"), /btc-research|overview-btc-research/);
  assert.match(read("overview-v2.html"), /<details class="ov-btc" id="btc-research">/);
  // The source of truth exists where the dropdown reads it from.
  assert.match(read("crypto.html"), /<div class="cards" id="crypto-research">/);
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
  assert.match(html, /<details class="ov-btc-sub" data-group="btc-long-short" open>/);
  assert.match(html, /<details class="ov-btc-sub" data-group="technical-analysis">/);
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

test("Open All covers every safe link, nested groups included, once each", () => {
  const data = {
    links: [{ href: "https://a.example/" }, { href: "javascript:alert(1)" }],
    groups: [
      { id: "g1", label: "G1", links: [{ href: "https://b.example/" }, { href: "https://a.example/" }] },
      { id: "g2", label: "G2", links: [{ href: "/crypto.html" }] },
    ],
  };
  assert.deepEqual(btc.openAllHrefs(data), ["https://a.example/", "https://b.example/", "/crypto.html"]);
  assert.deepEqual(btc.openAllHrefs({ links: [], groups: [] }), []);
  assert.match(read("overview-v2.html"), /<button class="open-all-btn ov-btc-open-all" id="ov-btc-open-all" type="button" hidden>/);
});
