"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public", name), "utf8");
const NOW = Date.parse("2026-11-22T12:00:00Z");
const HOUR = 3600000;
class Clock extends Date { static now() { return NOW; } }
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function element() {
  const node = {
    innerHTML: "", textContent: "", className: "", open: true, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector(sel) { return (this.children ||= {})[sel] ||= element(); },
  };
  return node;
}

async function run(responses) {
  const nodes = {};
  const context = {
    Date: Clock,
    window: { ScreenerUI: { escapeHtml: (s) => String(s) } },
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
  context.window.ScreenerUI = { escapeHtml: (s) => String(s) };
  vm.runInNewContext(read("assets/js/overview-v2-status.js"), context);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  return nodes;
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
  assert.match(tile("trades").querySelector(".ov2-sys-count").innerHTML, /<strong>2<\/strong> pairs tracked/);
  assert.match(tile("trades").querySelector(".ov2-sys-when").innerHTML, /^Last updated 5h ago/);
  assert.match(tile("buys").querySelector(".ov2-sys-when").textContent, /^Unavailable/);
  assert.match(tile("buys").querySelector(".ov2-sys-count").innerHTML, /—/);
});

test("Overview v2 carries the news tab, status row and Market Matrix card", () => {
  const html = read("overview-v2.html");
  for (const id of ["ov2-news", "ov2-news-last", "ov2-desks", "ov2-system", "ov2-matrix"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /href="\/tradehunter\/market-matrix"/);
  assert.ok(html.indexOf("briefing-freshness.js") < html.indexOf("overview-v2-status.js"));
});
