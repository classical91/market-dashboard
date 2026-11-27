"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { chromium } = require("playwright");

const executablePath = fs.existsSync(chromium.executablePath()) ? chromium.executablePath()
  : fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : null;

function card(symbol, interval, state, rank) {
  return {
    symbol, interval, price: symbol === "BTCUSDT" ? 61137.03 : 0.9283,
    context: { state, summary: state === "ALIGNED" ? "Bearish across bias — nothing currently reads the other way." : "No directional read on any engine right now." },
    attention: { rank, tags: [state], changeCount: 0 },
    freshness: { state: "FRESH", summary: interval + " candle closed 3h 6m ago · context calculated just now" },
    changes: { state: "UNCHANGED", lines: [] },
    directionalBias: { bias: state === "ALIGNED" ? "BEARISH" : "NEUTRAL", score: state === "ALIGNED" ? 100 : 50, trendRegime: "TREND_DOWN", rsi: 47.2, adx: 25.6 },
    extremes: { bottomScore: 0, topScore: 20, state: "NONE" },
    patterns: symbol === "XRPUSDT" ? { pattern: "Falling Wedge", patternBias: "bullish", patternScore: 32, status: "breakout" } : {},
    openInterest: { state: { label: "Quiet", tone: "quiet", meaning: "No meaningful change in open interest on this horizon" }, horizon: "4h", oiChangePct: 0.42, priceChangePct: -0.18, oiUsd: 61500000, source: "OKX Swap", horizons: [{ key: "15m", label: "Quiet" }, { key: "1h", label: "Quiet" }, { key: "4h", label: "Quiet" }] },
    rsi: { cells: [{ label: "1W", value: 38.6, state: "weak-bearish" }, { label: "1D", value: 22.5, state: "bearish" }, { label: "4H", value: 47.6 }, { label: "1H", value: 60.5, state: "weak-bullish" }], average: 42.3 },
    evidence: symbol === "XRPUSDT" ? ["Falling Wedge · Breakout", "EMA structure bearish", "Additional chart context for this longer card"] : ["EMA structure bearish"],
  };
}

test("Active Trades removal and responsive cards", { skip: !executablePath && "Chromium unavailable" }, async (t) => {
  const app = express();
  app.use(express.static(path.join(__dirname, "..", "public")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const screenshotDir = process.env.ACTIVE_TRADES_SCREENSHOT_DIR;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  async function open(t, options = {}) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 1520, height: 1100 } });
    t.after(() => context.close());
    await context.addInitScript(() => {
      if (location.protocol === "http:") localStorage.setItem("marketDashboardAdminKey", "browser-test-key");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));
    t.after(() => assert.deepEqual(errors, [], "no uncaught page errors"));
    const deletes = [];
    const cards = [card("BTCUSDT", "1W", "ALIGNED", 3), card("XRPUSDT", "4h", "ALIGNED", 2), card("BTCUSDT", "4h", "QUIET", 1)];
    await context.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "DELETE") {
        deletes.push(request.postDataJSON());
        if (options.beforeDelete) await options.beforeDelete();
        await route.fulfill({ status: options.status || 200, json: options.status ? { error: "Removal unavailable" } : { items: [] } });
      } else if (url.pathname === "/api/trade-context") {
        await route.fulfill({ json: { cards, tagCounts: { ALIGNED: 2, QUIET: 1 } } });
      } else if (url.pathname === "/api/watchlist/tokens") {
        await route.fulfill({ json: { tokens: ["BTCUSDT", "XRPUSDT"] } });
      } else if (url.pathname === "/api/watchlist") {
        await route.fulfill({ json: { items: cards.map(({ symbol, interval }) => ({ symbol, interval })) } });
      } else if (url.pathname === "/api/active-trade-shots") {
        await route.fulfill({ json: { items: options.notes || [] } });
      } else {
        await route.fulfill({ json: { authenticated: true, role: "owner" } });
      }
    });
    await page.goto(base + "/pattern-scanner-trades.html");
    await page.locator(".tc-card").last().waitFor();
    return { page, deletes };
  }

  await t.test("Cancel and Escape never send a deletion and restore focus", async t => {
    const { page, deletes } = await open(t);
    const remove = page.getByRole("button", { name: "Remove BTCUSDT 1W from Active Trades", exact: true });
    const dialog = page.getByRole("dialog");
    await remove.click();
    assert.match(await dialog.textContent(), /BTCUSDT · 1W/);
    assert.equal(await dialog.getByRole("button", { name: "Cancel" }).evaluate(node => node === document.activeElement), true);
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "confirmation.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await remove.evaluate(node => node === document.activeElement), true);
    await remove.click();
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.deepEqual(deletes, []);
    assert.equal(await page.locator(".tc-card").count(), 3);
  });

  await t.test("confirmation removes only the chosen timeframe after sorting and updates counts", async t => {
    let release;
    const response = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { page, deletes } = await open(t, { beforeDelete: () => response });
    await page.locator("#tc-sort").selectOption("interval");
    await page.getByRole("button", { name: "Remove BTCUSDT 4h from Active Trades", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-role="remove"]').disabled);
    assert.equal(await page.locator('.tc-head-tools [data-role="remove"]:disabled').count(), 3);
    release();
    await page.getByRole("status").filter({ hasText: "Removed BTCUSDT 4h" }).waitFor();
    assert.deepEqual(deletes, [{ symbol: "BTCUSDT", interval: "4h" }]);
    assert.equal(await page.locator(".tc-card").count(), 2);
    assert.equal(await page.getByRole("button", { name: "Remove BTCUSDT 1W from Active Trades", exact: true }).count(), 1);
    assert.equal(await page.locator('[data-filter="ALL"] .tc-filter-count').textContent(), "2");
  });

  await t.test("failed removals show an error, keep the card and permit retry", async t => {
    const { page, deletes } = await open(t, { status: 403 });
    await page.getByRole("button", { name: "Remove XRPUSDT 4h from Active Trades", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Could not remove XRPUSDT 4h: Removal unavailable" }).waitFor();
    assert.equal(await page.locator(".tc-card").count(), 3);
    assert.equal(await page.getByRole("button", { name: "Remove XRPUSDT 4h from Active Trades", exact: true }).isEnabled(), true);
    assert.equal(deletes.length, 1);
  });

  await t.test("cards use natural heights and controls fit desktop and phone widths", async t => {
    const { page } = await open(t);
    const heights = await page.locator(".tc-card").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(heights[1] > heights[0], "short cards have no stretched blank footer area");
    await page.locator("#tc-updated").evaluate(node => {
      node.textContent = "Page refreshed 11:59:59 PM · 3 cards changed · 1 card on stale data";
    });
    await page.evaluate(() => AppSettings.applyTheme("terminal"));
    for (const width of [1520, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
      const fits = await page.locator(".tc-card").evaluateAll(nodes => nodes.every(card => {
        const bounds = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll("button, a, .tc-price")).every(node => {
          const box = node.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right;
        });
      }));
      assert.equal(fits, true, `card actions fit at ${width}px`);
      if (screenshotDir && [1520, 390].includes(width)) await page.screenshot({ path: path.join(screenshotDir, `cards-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Remove BTCUSDT 1W from Active Trades", exact: true }).click();
    assert.equal(await page.getByRole("dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  });

  await t.test("an opened ticker fits its first note preview on a short laptop screen", async t => {
    const chart = "/assets/images/market-command-mark.png";
    const notes = [
      { id: "shot-1", label: "$BTC\n## Latest outlook\n\n" + "Context for the next session. ".repeat(20), createdAt: 1700000003000, url: chart },
      { id: "shot-2", label: "$BTC Prior session", createdAt: 1700000000000, url: chart },
      { id: "shot-3", batch: "eth-shots", label: "$ETH", createdAt: 1699999999000, url: chart },
      { id: "shot-4", batch: "eth-shots", label: "$ETH", createdAt: 1699999998000, url: chart },
      { id: "shot-5", label: "$SOL", createdAt: 1699999997000, url: chart },
      { id: "shot-6", label: "$XRP", createdAt: 1699999996000, url: chart },
    ];
    const { page } = await open(t, { notes, viewport: { width: 1366, height: 620 } });
    const panel = page.locator("#ts-panel");
    const composer = panel.getByText("Add a trade note", { exact: true });
    const noteInput = panel.getByRole("textbox", { name: "Note for these screenshots" });
    assert.equal(await noteInput.isVisible(), false);

    const folder = panel.locator(".ts-folder-head").first();
    await folder.click();
    assert.equal(await panel.locator("#ts-count").textContent(), "5 entries · 6 images");
    const firstEntry = panel.locator(".ts-entry").first();
    const screenshot = firstEntry.locator("img[data-zoomable]");
    await screenshot.scrollIntoViewIfNeeded();
    await screenshot.evaluate(image => image.decode());
    for (const viewport of [{ width: 1366, height: 620 }, { width: 1280, height: 600 }]) {
      await page.setViewportSize(viewport);
      await panel.evaluate(node => node.scrollIntoView({ block: "start" }));
      assert.equal(await firstEntry.evaluate(node => {
        const entry = node.getBoundingClientRect();
        const list = node.closest(".ts-list").getBoundingClientRect();
        return entry.top >= list.top && entry.bottom <= Math.min(list.bottom, innerHeight);
      }), true, `the chart, note preview, and reader link fit at ${viewport.width}×${viewport.height}`);
    }
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "trade-notes-laptop.png") });

    await page.evaluate(async url => {
      const chart = await (await fetch(url)).blob();
      const data = new DataTransfer();
      data.items.add(new File([chart], "chart.png", { type: "image/png" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, chart);
    await panel.getByRole("button", { name: "Post note", exact: true }).waitFor();
    await noteInput.fill("Laptop draft");
    await composer.click();
    assert.equal(await noteInput.isVisible(), false);
    await composer.click();
    assert.equal(await noteInput.inputValue(), "Laptop draft");
    assert.equal(await panel.locator("#ts-staged img").count(), 1);
  });

  await t.test("the Trade Notes page shows the full notes and charts without leaving Active Trades", async t => {
    const body = "## Trade outlook\n\n" + "Context for the next session. ".repeat(14) + "\n\nEnd of write-up";
    const chart = "/assets/images/market-command-mark.png";
    const notes = [
      { id: "shot-1", batch: "batch-1", label: "$BTC\n" + body, outcome: "tp", createdAt: 1700000003000, url: chart },
      { id: "shot-2", batch: "batch-1", label: "$BTC\n" + body, outcome: "tp", createdAt: 1700000004000, url: chart },
      { id: "shot-3", label: "$BTC Prior session", outcome: "sl", createdAt: 1700000000000, url: chart },
    ];
    const { page } = await open(t, { notes });
    await page.getByRole("button", { name: /\$BTC/ }).first().click();
    await page.getByRole("button", { name: /Read full note/ }).click();
    const reader = page.getByRole("dialog", { name: "Trade note" });
    await reader.getByText("End of write-up").waitFor();
    await reader.getByRole("button", { name: "Close note" }).click();
    const draft = page.getByRole("textbox", { name: "Note for these screenshots" });
    await draft.fill("Draft in Active Trades");
    const [notesPage] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("link", { name: /Open full page for Trade Notes/ }).click(),
    ]);
    const errors = [];
    notesPage.on("pageerror", err => errors.push(err.message));
    await notesPage.getByRole("heading", { name: "Trade notes", exact: true }).waitFor();
    assert.equal(new URL(notesPage.url()).pathname, "/trade-notes.html");
    assert.equal(await draft.inputValue(), "Draft in Active Trades");

    const folder = notesPage.getByRole("button", { name: /\$BTC/ }).first();
    const firstEntry = notesPage.locator(".ts-entry").first();
    await folder.waitFor();
    assert.equal(await folder.getAttribute("aria-expanded"), "false");
    assert.equal(await firstEntry.count(), 0);
    await folder.click();
    await firstEntry.getByRole("heading", { name: "Trade outlook" }).waitFor();
    assert.equal(await notesPage.locator("#ts-count").textContent(), "2 entries · 3 images");
    assert.equal(await firstEntry.getByText("End of write-up").isVisible(), true);
    assert.equal(await notesPage.locator(".ts-note--clamped").count(), 0);
    assert.equal(await folder.getAttribute("aria-expanded"), "true");
    await folder.click();
    assert.equal(await firstEntry.count(), 0);
    await folder.click();

    const compact = notesPage.getByRole("button", { name: "Compact view" });
    const charts = firstEntry.locator("img[data-zoomable]");
    const firstChart = charts.first();
    assert.equal(await charts.count(), 2);
    await firstChart.evaluate(image => image.decode());
    const fullCard = await firstEntry.boundingBox();
    const fullChart = await firstChart.boundingBox();
    assert.equal(await compact.getAttribute("aria-pressed"), "false");
    await compact.click();
    assert.equal(await compact.getAttribute("aria-pressed"), "true");
    assert.ok((await firstEntry.boundingBox()).width < fullCard.width);
    assert.ok((await firstChart.boundingBox()).height < fullChart.height);

    await notesPage.reload();
    await folder.waitFor();
    assert.equal(await folder.getAttribute("aria-expanded"), "false");
    assert.equal(await firstEntry.count(), 0);
    assert.equal(await compact.getAttribute("aria-pressed"), "true");
    await folder.click();
    await firstChart.click();
    await notesPage.getByRole("dialog", { name: "Image viewer" }).waitFor();
    await notesPage.keyboard.press("Escape");

    for (const width of [1520, 390, 320]) {
      await notesPage.setViewportSize({ width, height: 900 });
      assert.equal(await notesPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await notesPage.locator("#ts-list").evaluate(list => getComputedStyle(list).overflowY), "visible");
      if (screenshotDir && width !== 320) await notesPage.screenshot({ path: path.join(screenshotDir, `trade-notes-${width}.png`) });
    }
    await notesPage.setViewportSize({ width: 1520, height: 900 });
    await compact.click();
    assert.equal(await compact.getAttribute("aria-pressed"), "false");
    assert.equal((await firstEntry.boundingBox()).width, fullCard.width);
    await notesPage.getByText("Add a trade note", { exact: true }).click();
    assert.equal(await notesPage.getByRole("textbox", { name: "Note for these screenshots" }).isVisible(), true);
    await notesPage.getByRole("link", { name: "Back to Active Trades", exact: true }).click();
    await notesPage.waitForURL("**/pattern-scanner-trades.html");
    assert.deepEqual(errors, []);
  });
});
