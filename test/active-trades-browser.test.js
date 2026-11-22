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
    const context = await browser.newContext({ viewport: { width: 1520, height: 1100 } });
    t.after(() => context.close());
    await context.addInitScript(() => localStorage.setItem("marketDashboardAdminKey", "browser-test-key"));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));
    t.after(() => assert.deepEqual(errors, [], "no uncaught page errors"));
    const deletes = [];
    const cards = [card("BTCUSDT", "1W", "ALIGNED", 3), card("XRPUSDT", "4h", "ALIGNED", 2), card("BTCUSDT", "4h", "QUIET", 1)];
    await page.route("**/api/**", async route => {
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
});
