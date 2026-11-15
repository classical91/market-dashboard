"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", "public/assets/js", name), "utf8");
const NOW = Date.parse("2026-11-15T12:00:00Z");
const HOUR = 3600000;
class Clock extends Date { static now() { return NOW; } }

test("run freshness uses exact 32 and 48 hour boundaries, with neutral missing dates", () => {
  const context = { window: {}, Date: Clock };
  vm.runInNewContext(read("briefing-freshness.js"), context);
  const { state } = context.window.BriefingFreshness;
  for (const [age, expected] of [[0, "fresh"], [32 * HOUR, "fresh"], [32 * HOUR + 1, "nearing"], [48 * HOUR, "nearing"], [48 * HOUR + 1, "stale"], [11 * 24 * HOUR, "stale"]]) {
    assert.equal(state(new Date(NOW - age).toISOString()), expected);
  }
  for (const value of [null, undefined, "", "invalid"]) assert.equal(state(value), "empty");
});

async function page({ failedSection, phoneAt = "2026-11-01T00:00:00Z" } = {}) {
  const nodes = {};
  const categories = ["geopolitics", "economics", "stocks", "crypto"].map((key) => ({
    key, label: key, icon: "", latest: { receivedAt: phoneAt },
  }));
  const stamps = { geopolitics: "2026-11-15T11:00:00Z", economics: "2026-11-14T00:00:00Z", markets: "2026-11-15T12:00:00+02:00", crypto: "2026-11-13T00:00:00Z" };
  const requested = [];
  const timers = [];
  const context = {
    Date: Clock,
    window: { location: { pathname: "/briefings/geopolitics", origin: "http://x" }, setInterval(fn) { timers.push(fn); }, addEventListener() {} },
    document: { getElementById(id) {
      return nodes[id] ||= { hidden: false, innerHTML: "", textContent: "", className: "", classList: { add() {}, remove() {} }, addEventListener() {} };
    } },
    fetch: async (url) => {
      requested.push(url);
      let data = {};
      if (url === "/api/phone-briefings") data = { categories };
      else if (url === "/api/phone-briefings/geopolitics") data = { runs: [] };
      else if (url.startsWith("/api/daily-report/generations")) {
        const section = new URL(url, "http://x").searchParams.get("section");
        if (section === failedSection) throw new Error("Reporter unavailable");
        data = { generations: [{ generatedAt: stamps[section], content: "1. News" }] };
      }
      return { ok: true, json: async () => data };
    },
  };
  for (const file of ["briefing-markdown.js", "briefing-freshness.js", "briefing.js"]) vm.runInNewContext(read(file), context);
  await new Promise(setImmediate);
  return { nodes, requested, timers };
}

test("all desk cards use their newer Reporter run, even when another desk is open", async () => {
  const { nodes, requested, timers } = await page();
  const html = nodes.briefingDesks.innerHTML;
  for (const section of ["geopolitics", "economics", "markets", "crypto"]) {
    assert.ok(requested.some((url) => url.includes("section=" + section)));
  }
  assert.match(html, /briefing-desk active fresh/);
  assert.match(html, /briefing-desk nearing" href="\/briefings\/economics/);
  assert.match(html, /briefing-desk fresh" href="\/briefings\/stocks/);
  assert.match(html, /briefing-desk stale" href="\/briefings\/crypto/);
  assert.match(html, /datetime="2026-11-15T12:00:00\+02:00"/);
  assert.match(html, /Past due/);
  assert.equal(nodes.briefingAge.className, "briefing-age fresh");
  const body = nodes.briefingBody.innerHTML;
  timers[0]();
  assert.equal(nodes.briefingBody.innerHTML, body, "age updates preserve the displayed content");
});

test("an unavailable Reporter desk keeps the phone timestamp and other desks still update", async () => {
  const { nodes } = await page({ failedSection: "markets" });
  assert.match(nodes.briefingDesks.innerHTML, /briefing-desk stale" href="\/briefings\/stocks/);
  assert.match(nodes.briefingDesks.innerHTML, /datetime="2026-11-01T00:00:00Z"/);
  assert.match(nodes.briefingDesks.innerHTML, /briefing-desk nearing" href="\/briefings\/economics/);
});

 test("a newer phone upload wins even when Reporter timestamps use another UTC offset", async () => {
  const { nodes } = await page({ phoneAt: "2026-11-15T10:30:00Z" });
  const stocks = nodes.briefingDesks.innerHTML.match(/<a class="briefing-desk fresh" href="\/briefings\/stocks"[\s\S]*?<\/a>/)[0];
  assert.match(stocks, /📱/);
  assert.match(stocks, /datetime="2026-11-15T10:30:00Z"/);
});
