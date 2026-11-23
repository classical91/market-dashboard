"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");
const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 3600000;
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function element() {
  const node = {
    innerHTML: "", textContent: "", className: "", open: true, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    querySelector(sel) { return (this.children ||= {})[sel] ||= element(); },
  };
  return node;
}

async function run(responses, review) {
  const nodes = {};
  const context = {
    Date: Clock,
    window: { ScreenerUI: { escapeHtml: escapeHtml }, OverviewNewsReview: review },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { hidden: false, getElementById: (id) => (nodes[id] ||= element()) },
    setInterval() {},
    fetch: async (url) => {
      const key = Object.keys(responses).find((prefix) => url.startsWith(prefix));
      if (!key || responses[key] instanceof Error) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => responses[key] };
    },
  };
  context.window.BriefingFreshness = undefined;
  vm.runInNewContext(read("assets/js/briefing-freshness.js"), context);
  context.window.ScreenerUI = { escapeHtml: escapeHtml };
  vm.runInNewContext(read("assets/js/overview-v2-status.js"), context);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  return nodes;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

test("news desks use the newer source and the collapsed line names the latest report", async () => {
  const nodes = await run({
    "/api/phone-briefings": { categories: [{ key: "economics", latest: { receivedAt: iso(50 * HOUR) } }] },
    "/api/daily-report/generations?section=crypto": { generations: [{ generatedAt: iso(2 * HOUR) }] },
    "/api/daily-report/generations?section=geopolitics": { generations: [{ generatedAt: iso(40 * HOUR) }] },
    "/api/daily-report/generations": { generations: [] },
  });
  const desks = nodes["ov2-desks"].innerHTML;
  assert.match(desks, /ov2-desk fresh" href="\/briefings\/crypto"/);
  assert.match(desks, /ov2-desk nearing" href="\/briefings\/geopolitics"/);
  assert.match(desks, /ov2-desk stale" href="\/briefings\/economics"/);
  assert.match(desks, /ov2-desk empty" href="\/briefings\/stocks"/);
  assert.match(nodes["ov2-news-last"].innerHTML, /^Last report 2h ago · Crypto · <time/);
});

test("desk clicks review the newer report's content and preserve modified link clicks", async () => {
  const opened = [];
  const nodes = await run({
    "/api/phone-briefings": { categories: [
      { key: "economics", latest: { receivedAt: iso(HOUR), title: "Phone headlines", text: "New phone report" } },
      { key: "crypto", latest: { receivedAt: iso(4 * HOUR), text: "Old phone report" } },
    ] },
    "/api/daily-report/generations?section=economics": { generations: [{ generatedAt: iso(2 * HOUR), content: "Old reporter content" }] },
    "/api/daily-report/generations?section=crypto": { generations: [{ generatedAt: iso(HOUR), content: "New reporter content", noBriefing: true }] },
    "/api/daily-report/generations": { generations: [] },
  }, { open(desk) { opened.push(desk); return true; } });
  let prevented = 0;
  function click(key, extra = {}) {
    nodes["ov2-desks"].listeners.click({
      button: 0, target: { closest: () => ({ getAttribute: () => key }) },
      preventDefault() { prevented++; }, ...extra,
    });
  }
  click("economics");
  click("crypto");
  assert.equal(opened[0].text, "New phone report");
  assert.equal(opened[0].title, "Phone headlines");
  assert.equal(opened[0].reporter, false);
  assert.equal(opened[1].text, "New reporter content");
  assert.equal(opened[1].reporter, true);
  assert.equal(opened[1].noBriefing, true);
  assert.equal(prevented, 2);
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) click("crypto", { [modifier]: true });
  click("crypto", { button: 1 });
  assert.equal(opened.length, 2);
  assert.equal(prevented, 2);
});

test("review distinguishes a missing report from failed and partially available sources", async () => {
  const opened = [];
  const nodes = await run({
    "/api/phone-briefings": new Error("down"),
    "/api/daily-report/generations?section=crypto": { generations: [{ generatedAt: iso(HOUR), content: "Available report" }] },
    "/api/daily-report/generations?section=economics": { generations: [] },
    "/api/daily-report/generations": new Error("down"),
  }, { open(desk) { opened.push(desk); return true; } });
  for (const key of ["crypto", "economics", "stocks"]) {
    nodes["ov2-desks"].listeners.click({
      button: 0, target: { closest: () => ({ getAttribute: () => key }) }, preventDefault() {},
    });
  }
  assert.equal(opened[0].text, "Available report");
  assert.equal(opened[0].partial, true);
  assert.equal(opened[0].failed, false);
  assert.equal(opened[1].at, null);
  assert.equal(opened[1].failed, false);
  assert.equal(opened[2].failed, true);
});

test("system tiles show a count and the last run or update, and a failure stays visible", async () => {
  const nodes = await run({
    "/api/ai-analysis/log": { entries: [{ generatedAt: iso(HOUR) }, { generatedAt: iso(3 * HOUR) }, { generatedAt: iso(30 * HOUR) }] },
    "/api/layout-analysis/log": { entries: [] },
    "/api/watchlist": { items: [{ addedAt: iso(5 * HOUR) }, { addedAt: iso(26 * HOUR) }] },
    "/api/potential-buys/summary": new Error("down"),
    "/api/phone-briefings": { categories: [] },
    "/api/daily-report/generations": { generations: [] },
  });
  const tile = (id) => nodes["ov2-system"] && nodes["ov2-sys-" + id];
  assert.match(tile("presets").querySelector(".ov2-sys-count").innerHTML, /<strong>2<\/strong> runs in 24h/);
  assert.match(tile("presets").querySelector(".ov2-sys-when").innerHTML, /^Last run 1h ago/);
  assert.equal(tile("layouts").querySelector(".ov2-sys-when").innerHTML, "No run recorded");
  assert.match(nodes["ov2-generation-log"].innerHTML, /No captures yet/);
  assert.match(tile("trades").querySelector(".ov2-sys-count").innerHTML, /<strong>2<\/strong> pairs tracked/);
  assert.match(tile("trades").querySelector(".ov2-sys-when").innerHTML, /^Last updated 5h ago/);
  assert.match(tile("buys").querySelector(".ov2-sys-when").textContent, /^Unavailable/);
  assert.match(tile("buys").querySelector(".ov2-sys-count").innerHTML, /—/);
});

test("layout widget orders captures newest first, groups local days and escapes layout labels", async () => {
  const nodes = await run({
    "/api/layout-analysis/log": { entries: [
      { label: "BTC 4h", verdict: "HOLD", generatedAt: iso(20 * HOUR) },
      { label: '<img src=x onerror="alert(1)">', verdict: "BUY", generatedAt: iso(HOUR) },
      { label: "BTC 1D", verdict: "SELL", generatedAt: iso(2 * HOUR) },
      { layoutId: "undated", verdict: "unknown", generatedAt: "invalid" },
    ] },
  });
  const html = nodes["ov2-generation-log"].innerHTML;
  assert.ok(html.indexOf("&lt;img") < html.indexOf("BTC 1D"));
  assert.ok(html.indexOf("BTC 1D") < html.indexOf("BTC 4h"));
  assert.match(html, />Today<\/div>/);
  assert.match(html, />Yesterday<\/div>/);
  assert.match(html, /aia-verdict--buy/);
  assert.match(html, /aia-verdict--sell/);
  assert.match(html, /aia-verdict--hold/);
  assert.match(html, /datetime="2026-11-22T11:00:00.000Z"/);
  assert.match(html, /NO CALL/);
  assert.match(html, /Unknown date/);
  assert.doesNotMatch(html, /<img/);
});

test("layout widget limits recent captures and reports a failed source", async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ label: "capture-" + i, verdict: "HOLD", generatedAt: iso(i * HOUR) }));
  const nodes = await run({ "/api/layout-analysis/log": { entries } });
  assert.equal((nodes["ov2-generation-log"].innerHTML.match(/class="aia-log-item/g) || []).length, 12);
  assert.doesNotMatch(nodes["ov2-generation-log"].innerHTML, /capture-12/);
  const failed = await run({ "/api/layout-analysis/log": new Error("offline") });
  assert.match(failed["ov2-generation-log"].innerHTML, /Failed to load captures/);
  assert.match(failed["ov2-generation-log"].innerHTML, /Refresh all/);
});

test("generation widget shows timeframe tiles, filters the log, and switches to presets", async () => {
  const nodes = await run({
    "/api/layout-analysis/log": { entries: [
      { layoutId: "btc-1w", label: "BTC 1W", verdict: "HOLD", generatedAt: iso(HOUR) },
      { layoutId: "btc-4h", label: "BTC 4h", verdict: "SELL", generatedAt: iso(2 * HOUR), chartUrl: "/layout-screenshots/btc-4h-new.png", analysis: "**Trend** down <script>x</script>" },
      { layoutId: "btc-4h", label: "BTC 4h", verdict: "HOLD", generatedAt: iso(30 * HOUR), chartUrl: "/layout-screenshots/btc-4h-old.png" },
    ] },
    "/api/layout-analysis": { layouts: [{ id: "btc-1w", label: "BTC 1W" }, { id: "btc-1d", label: "BTC 1D" }, { id: "btc-4h", label: "BTC 4h" }] },
    "/api/ai-analysis/log": { entries: [
      { symbol: "BINANCE:BTCUSDT", interval: "4h", label: "BTCUSDT", verdict: "BUY", generatedAt: iso(HOUR) },
      { symbol: "BINANCE:ETHUSDT", interval: "1D", label: "ETHUSDT", verdict: "SELL", generatedAt: iso(HOUR) },
    ] },
    "/api/ai-analysis": { presets: [{ symbol: "BINANCE:BTCUSDT", label: "BTCUSDT" }, { symbol: "BINANCE:ETHUSDT", label: "ETHUSDT" }], availableIntervals: ["1h", "4h", "1D"] },
  });
  const tiles = nodes["ov2-presets"];
  // Shortest timeframe first; a layout with no capture still gets a tile.
  assert.ok(tiles.innerHTML.indexOf('data-preset="btc-4h"') < tiles.innerHTML.indexOf('data-preset="btc-1d"'));
  assert.ok(tiles.innerHTML.indexOf('data-preset="btc-1d"') < tiles.innerHTML.indexOf('data-preset="btc-1w"'));
  assert.match(tiles.innerHTML, /Not captured yet/);

  const click = (id) => tiles.listeners.click({ target: { closest: () => ({ getAttribute: () => id }) } });
  click("btc-4h");
  assert.doesNotMatch(nodes["ov2-generation-log"].innerHTML, /BTC 1W/);
  assert.equal((nodes["ov2-generation-log"].innerHTML.match(/class="aia-log-item/g) || []).length, 2);
  assert.equal(nodes["ov2-generation-open"].href, "/layout-analysis.html?layout=btc-4h");
  // The viewer shows the selected layout's newest capture: chart, verdict and read.
  const view = nodes["ov2-generation-view"];
  assert.equal(view.hidden, false);
  assert.match(view.innerHTML, /<img src="\/layout-screenshots\/btc-4h-new.png"/);
  assert.match(view.innerHTML, /aia-verdict--sell/);
  assert.match(view.innerHTML, /<strong>Trend<\/strong> down/);
  assert.doesNotMatch(view.innerHTML, /<script>/);
  click("btc-1d");
  assert.match(view.innerHTML, /has no capture yet/);
  click("btc-1d");
  assert.equal(view.hidden, true);
  click("btc-4h");
  click("btc-4h");
  assert.match(nodes["ov2-generation-log"].innerHTML, /BTC 1W/);

  nodes["ov2-gen-tab-presets"].listeners.click();
  assert.equal(nodes["ov2-gen-tab-presets"].attrs["aria-selected"], "true");
  assert.equal(nodes["ov2-generation-symbol-wrap"].hidden, false);
  assert.match(nodes["ov2-generation-symbol"].innerHTML, /BTCUSDT[\s\S]*ETHUSDT/);
  assert.match(tiles.innerHTML, /data-preset="1h"[\s\S]*aia-verdict--buy/);
  assert.match(nodes["ov2-generation-log"].innerHTML, /BTCUSDT 4h/);
  assert.equal(nodes["ov2-generation-view"].hidden, true);
  assert.doesNotMatch(nodes["ov2-generation-log"].innerHTML, /ETHUSDT/);

  nodes["ov2-generation-symbol"].value = "BINANCE:ETHUSDT";
  nodes["ov2-generation-symbol"].listeners.change();
  assert.match(nodes["ov2-generation-log"].innerHTML, /ETHUSDT 1D/);
  assert.doesNotMatch(nodes["ov2-generation-log"].innerHTML, /BTCUSDT/);
});

test("Overview v2 carries the news tab, status row and Market Matrix card", () => {
  const html = read("overview-v2.html");
  for (const id of ["ov2-news", "ov2-news-last", "ov2-desks", "ov2-system", "ov2-matrix", "ov2-generation-log"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /href="\/tradehunter\/market-matrix"/);
  assert.match(html, /href="\/layout-analysis.html#aia-log"/);
  assert.ok(html.indexOf("briefing-freshness.js") < html.indexOf("overview-v2-status.js"));
});
