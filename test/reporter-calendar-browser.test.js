"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");
const { chromium } = require("playwright");
const { createMacroCalendarRouter } = require("../src/routes/macro-calendar");
const { normalizeCalendar } = require("../src/services/calendar-normalize");

test("Reporter calendar: real DOM filters, timezones, precision, states and responsive layout", { timeout: 60000 }, async t => {
  const root = path.join(__dirname, "..", "public");
  const reporter = fs.readFileSync(path.join(root, "reporter.html"), "utf8");
  const start = reporter.lastIndexOf("<article", reporter.indexOf('id="macro-calendar"'));
  const panel = reporter.slice(start, reporter.indexOf("</article>", start) + "</article>".length);
  const now = new Date("2026-11-16T12:00:00Z");
  let mode = "live";
  const rows = [
    { title: "Fixture CPI", date: "2026-11-16T13:30:00Z", country: "US", impact: "High", forecast: "2%", previous: "2.1%" },
    { title: "Fixture PMI", date: "2026-11-16 23:00", country: "JP", impact: "Medium" },
    { title: "Fixture tomorrow", date: "2026-11-17T13:30:00Z", country: "US", impact: "High" },
    { title: "Fixture next week", date: "2026-11-23T13:30:00Z", country: "US", impact: "High" },
    { title: "Fixture released", date: "2026-11-16T10:00:00Z", country: "US", actual: 0 },
    { title: '<img src=x onerror="window.__calendarPwned=1">', date: "2026-11-16T14:00:00Z", country: "US", impact: "Low" },
  ];
  const app = express();
  app.use("/api/macro/calendar", createMacroCalendarRouter({ marketDataService: {
    async getCalendar({ timezone }) {
      return {
        live: mode === "live" || mode === "empty", stale: mode === "stale", source: "Fixture provider", timezone,
        fetchedAt: now.toISOString(), expiresAt: new Date(+now + 300000).toISOString(), staleUntil: new Date(+now + 1800000).toISOString(),
        items: ["empty", "unavailable"].includes(mode) ? [] : normalizeCalendar(rows, { now, timezone, days: 14 }).items,
      };
    }
  } }));
  app.get("/fixture", (req, res) => res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/assets/styles/command.css"><link rel="stylesheet" href="/assets/styles/reporter.css"></head><body><main style="max-width:900px;margin:20px;padding:8px">${panel}</main><script src="/assets/js/reporter-calendar.js"></script><script>ReporterCalendar.init()</script></body></html>`));
  app.use(express.static(root));
  const server = http.createServer(app);
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.clock.install({ time: now });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForSelector(".macro-release");
  assert.match(await page.locator("#macroCalendarStatus").textContent(), /Live.*America\/Los_Angeles/);
  const cpi = page.locator(".macro-release").filter({ hasText: "Fixture CPI" });
  assert.match(await cpi.textContent(), /05:30/);
  assert.match(await cpi.textContent(), /In 1h 30m/);
  assert.match(await page.locator(".macro-release").filter({ hasText: "Fixture PMI" }).textContent(), /Time assumed/);
  assert.equal(await page.locator(".macro-release").filter({ hasText: "Fixture released" }).locator("dd").last().textContent(), "0");
  assert.equal(await page.locator("#catalystList img").count(), 0);
  assert.equal(await page.evaluate(() => window.__calendarPwned), undefined);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.locator("#macroCalendarStatus").isVisible(), "quality must stay visible on phones");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    assert.ok(await page.locator(".intel-panel").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    if (process.env.CALENDAR_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CALENDAR_SCREENSHOT_DIR, `calendar-${width}.png`), fullPage: true });
  }
  await page.selectOption("#macroCalendarTimezone", "UTC");
  await page.waitForFunction(() => document.querySelector("#macroCalendarStatus").textContent === "Live · UTC");
  assert.match(await cpi.textContent(), /01:30 PM/);
  await page.selectOption("#macroCalendarImpact", "High");
  assert.equal(await page.locator(".macro-release").count(), 1);
  await page.selectOption("#macroCalendarCountry", "JP");
  assert.match(await page.locator("#catalystList").textContent(), /No scheduled events/);
  await page.selectOption("#macroCalendarCountry", "");
  await page.selectOption("#macroCalendarRange", "tomorrow");
  assert.match(await page.locator("#catalystList").textContent(), /Fixture tomorrow/);
  await page.selectOption("#macroCalendarRange", "nextweek");
  assert.match(await page.locator("#catalystList").textContent(), /Fixture next week/);
  await page.selectOption("#macroCalendarRange", "14d");
  mode = "stale";
  await page.evaluate(() => ReporterCalendar.refresh());
  assert.match(await page.locator("#macroCalendarStatus").textContent(), /Stale data/);
  assert.doesNotMatch(await page.locator("#catalystList").textContent(), /In \d+/);
  mode = "unavailable";
  await page.evaluate(() => ReporterCalendar.refresh());
  assert.match(await page.locator("#catalystList").textContent(), /Live calendar unavailable/);
  mode = "empty";
  await page.evaluate(() => ReporterCalendar.refresh());
  assert.match(await page.locator("#macroCalendarStatus").textContent(), /Live/);
  assert.match(await page.locator("#catalystList").textContent(), /No scheduled events/);
  assert.deepEqual(errors, []);
});
