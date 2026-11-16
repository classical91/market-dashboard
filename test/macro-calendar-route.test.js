"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { MemoryCache } = require("../src/services/cache");
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
  assert.equal(body.events[0].title, "US CPI Inflation");
  assert.equal(body.events[0].precision, "unknown");
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
  app.use("/api/macro/calendar", createMacroCalendarRouter({ cache: new MemoryCache(), marketDataService: {
    async getCalendar() {
      reads++;
      return { live: true, timezone: "America/New_York", detail: "private", error: "private", items: [
        { title: "CPI", time: "08:30", at: "2026-11-16T13:30:00.000Z", timezone: "America/New_York", precision: "exact", impact: "High", secret: "private" }
      ] };
    }
  } }));
  const base = await listen(t, app);
  const responses = await Promise.all([fetch(base + "/api/macro/calendar"), fetch(base + "/api/macro/calendar")]);
  const body = await responses[0].json();
  assert.equal(reads, 1);
  assert.equal(body.fallback, false);
  assert.equal(body.events[0].precision, "exact");
  assert.equal(body.timezone, "America/New_York");
  assert.ok(!JSON.stringify(body).includes("private"));
});
