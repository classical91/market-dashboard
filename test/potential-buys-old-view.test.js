"use strict";
// The "Older than 3 days" view: Main Hub's System Logs links to
// /potential-buys.html?view=old when anything is past the line, and the red
// card on the page opens the same view.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const { PotentialBuysStore } = require("../src/services/potential-buys");
const { createPotentialBuysRouter } = require("../src/routes/potential-buys");

const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function start(t, ages) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-potential-buys-old-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = 0;
  const store = new PotentialBuysStore({ dataDir, logger: { error() {} }, now: () => clock });
  for (const [label, daysAgo] of ages) {
    clock = Date.now() - daysAgo * DAY;
    store.add(PNG, { label });
  }
  clock = Date.now();
  const app = express();
  app.use("/api/potential-buys", createPotentialBuysRouter({ potentialBuysStore: store }));
  app.use("/potential-buys-images", express.static(path.join(dataDir, "potential-buys")));
  app.use(express.static(path.join(__dirname, "..", "public")));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("?view=old shows only screenshots past 3 days, and the red card opens it", async (t) => {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch { t.skip("Playwright is not installed here"); return; }
  const base = await start(t, [["$BTC", 5], ["$BTC", 1], ["$ETH", 4], ["$SOL", 0.5], ["no ticker", 10]]);
  let browser;
  try { browser = await chromium.launch(); } catch { t.skip("no browser to launch"); return; }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Straight from a link.
  await page.goto(base + "/potential-buys.html?view=old");
  await page.waitForFunction(() => document.getElementById("pbCount").textContent === "3 screenshots");
  assert.equal(await page.textContent("#pbHeading"), "Older than 3 days");
  assert.equal(await page.isVisible("#pbBack"), true);
  assert.equal(await page.isHidden("#pbStats"), true);
  assert.equal(await page.locator("#pbGrid .pb-stack").count(), 0, "one card per screenshot, not ticker stacks");

  // Back to All drops the view from the address.
  await page.click("#pbBack");
  assert.equal(await page.textContent("#pbHeading"), "Watching");
  assert.equal(new URL(page.url()).search, "");

  // The red card is a button while anything is old, and opens the same view.
  assert.equal(await page.getAttribute("#pbStatStaleCard", "role"), "button");
  await page.click("#pbStatStaleCard");
  assert.equal(await page.textContent("#pbHeading"), "Older than 3 days");
  assert.equal(new URL(page.url()).searchParams.get("view"), "old");
  assert.deepEqual(errors, []);
});

test("with nothing past 3 days the card is not a button and the view says so", async (t) => {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch { t.skip("Playwright is not installed here"); return; }
  const base = await start(t, [["$BTC", 1]]);
  let browser;
  try { browser = await chromium.launch(); } catch { t.skip("no browser to launch"); return; }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base + "/potential-buys.html?view=old");
  await page.waitForFunction(() => /Nothing older than 3 days/.test(document.getElementById("pbGrid").textContent));
  await page.click("#pbBack");
  assert.equal(await page.getAttribute("#pbStatStaleCard", "role"), null);
});
