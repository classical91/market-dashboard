"use strict";
// Potential Buys' Chart ↗ links in the page: on ticker stacks, single
// screenshot cards, an opened folder's heading and the full-size viewer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const { PotentialBuysStore } = require("../src/services/potential-buys");
const { createPotentialBuysRouter } = require("../src/routes/potential-buys");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const TV = "https://www.tradingview.com/chart/?symbol=";

async function start(t, labels) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-potential-buys-charts-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new PotentialBuysStore({ dataDir, logger: { error() {} } });
  for (const label of labels) store.add(PNG, { label });
  const app = express();
  app.use("/api/potential-buys", createPotentialBuysRouter({ potentialBuysStore: store }));
  app.use("/potential-buys-images", express.static(path.join(dataDir, "potential-buys")));
  app.use(express.static(path.join(__dirname, "..", "public")));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("each ticker links to its TradingView chart", async (t) => {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch { t.skip("Playwright is not installed here"); return; }
  const base = await start(t, ["$BTC", "$BTC retest", "$NVDA", "$ZRO #crypto", "no ticker", "#crypto"]);
  let browser;
  try { browser = await chromium.launch(); } catch { t.skip("no browser to launch"); return; }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(base + "/potential-buys.html");
  await page.waitForSelector('#pbGrid .pb-stack[data-folder="BTC"]');
  const hrefs = await page.$$eval("#pbGrid .pb-chart", (links) => links.map((a) => a.href));
  assert.ok(hrefs.includes(TV + "BINANCE%3ABTCUSDT"), "the $BTC stack links to BINANCE:BTCUSDT");
  assert.ok(hrefs.includes(TV + "NVDA"), "a stock stays bare");
  assert.ok(hrefs.includes(TV + "BINANCE%3AZROUSDT"), "#crypto in the label makes ZRO a Binance pair");
  assert.equal(hrefs.length, 3, "no chart for an untagged screenshot or a bare #crypto category");
  assert.equal(await page.getAttribute('#pbGrid .pb-chart[href*="NVDA"]', "target"), "_blank");

  // Opening the folder puts the chart beside its heading.
  assert.equal(await page.isHidden("#pbHeadingChart"), true);
  await page.click('#pbGrid .pb-stack[data-folder="BTC"] [data-action="open-folder"].pb-btn');
  assert.equal(await page.textContent("#pbHeading"), "$BTC");
  assert.equal(await page.getAttribute("#pbHeadingChart", "href"), TV + "BINANCE%3ABTCUSDT");
  assert.equal(await page.isVisible("#pbHeadingChart"), true);

  // And the full-size viewer has it too.
  await page.click('#pbGrid .pb-card[data-id] [data-action="view"]');
  assert.equal(await page.isVisible("#pbViewerChart"), true);
  assert.equal(await page.getAttribute("#pbViewerChart", "href"), TV + "BINANCE%3ABTCUSDT");
  await page.click("#pbViewerClose");

  await page.click("#pbBack");
  assert.equal(await page.isHidden("#pbHeadingChart"), true);
  assert.deepEqual(errors, []);
});
