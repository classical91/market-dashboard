"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createMacroCalendarRouter } = require("../src/routes/macro-calendar");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "macro-calendar-"));
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = "calendar-test-password";
delete process.env.MACRO_CALENDAR_URL;
const { createApp } = require("../src/app");

async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the locked app exposes only the read-only calendar projection", async t => {
  const base = await listen(t, createApp());
  const response = await fetch(`${base}/api/macro/calendar`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.deepEqual(body.events, []);
  assert.equal(body.status, "unavailable");
  assert.equal(body.message, "Live calendar unavailable");
  assert.ok(!JSON.stringify(body).includes("MACRO_CALENDAR_URL"));
  assert.equal((await fetch(`${base}/api/macro/calendar/`, { method: "HEAD" })).status, 200);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await fetch(`${base}/api/macro/calendar`, { method })).status, 401);
  }
  for (const url of ["/api/overview", "/api/macro/calendar/extra", "/api/macro"]) {
    assert.equal((await fetch(base + url)).status, 401);
  }
});

test("calendar reads share the service cache and omit diagnostics", async t => {
  let reads = 0;
  const app = express();
  const { MarketDataService } = require("../src/services/market-data");
  const marketDataService = new MarketDataService({ calendarUrl: "https://feed.test?key=secret" });
  marketDataService.singleFetch = async () => {
    reads++;
    return [{ title: "CPI", date: new Date().toISOString(), impact: "High", actual: "2%", secret: "private" }];
  };
  app.use("/api/macro/calendar", createMacroCalendarRouter({ marketDataService }));
  const base = await listen(t, app);
  const responses = await Promise.all([fetch(base + "/api/macro/calendar"), fetch(base + "/api/macro/calendar")]);
  const body = await responses[0].json();
  assert.equal(reads, 1);
  assert.equal(body.fallback, false);
  assert.equal(body.events[0].precision, "exact");
  assert.equal(body.timezone, "UTC");
  assert.equal(body.events[0].actual, "2%");
  assert.equal(body.quality, "live");
  assert.ok(!JSON.stringify(body).includes("private"));
});

test("bounded public filters do not widen auth or forward arbitrary provider parameters", async t => {
  const app = express();
  const asked = [];
  app.use("/api/macro/calendar", createMacroCalendarRouter({ marketDataService: {
    async getCalendar(options) {
      asked.push(options);
      return { live: true, timezone: options.timezone, items: [] };
    }
  } }));
  const base = await listen(t, app);
  assert.equal((await fetch(base + "/api/macro/calendar?days=14&timezone=America%2FLos_Angeles&range=all&url=https://untrusted.test")).status, 200);
  assert.deepEqual(asked, [{ days: 14, timezone: "America/Los_Angeles", range: "all" }]);
  for (const query of ["days=15", "days=-1", "days=1.5", "timezone=Invalid/Zone", "range=anything", "timezone[]=UTC"]) assert.equal((await fetch(base + "/api/macro/calendar?" + query)).status, 400);
  assert.equal(asked.length, 1);
});

test("stale and unavailable API responses never label retained events as live", async t => {
  const app = express();
  app.use("/api/macro/calendar", createMacroCalendarRouter({ marketDataService: {
    async getCalendar() {
      return { live: false, stale: true, source: "Test provider", timezone: "UTC", fetchedAt: "2026-11-16T00:00:00Z", detail: "https://provider.test?key=private", items: [] };
    }
  } }));
  const base = await listen(t, app);
  const text = await (await fetch(base + "/api/macro/calendar")).text();
  const body = JSON.parse(text);
  assert.equal(body.status, "stale");
  assert.equal(body.fallback, true);
  assert.equal(body.stale, true);
  assert.ok(!text.includes("private"));
});
