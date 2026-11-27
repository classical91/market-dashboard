"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { chromium } = require("playwright");

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
const KEEP = /src="\/assets\/js\/(settings|watchlists|watchlist-card|watchlist-settings)\.js"/;

test("Watchlists: edit in Settings, browse on Overview v2", {
  skip: !fs.existsSync(executablePath) && "Install Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE",
}, async (t) => {
  const publicDir = path.join(__dirname, "..", "public");
  const app = express();
  // Real markup and styles with only the watchlist scripts; no API is needed.
  app.get(["/", "/settings.html"], (req, res) => {
    const html = fs.readFileSync(path.join(publicDir, req.path === "/" ? "overview-v2.html" : "settings.html"), "utf8");
    res.type("html").send(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => (KEEP.test(tag) ? tag : "")));
  });
  app.use(express.static(publicDir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("dialog", (dialog) => dialog.accept());
  const base = `http://127.0.0.1:${server.address().port}`;

  // Settings: new folder, symbols (one invalid), red bookmark.
  await page.goto(`${base}/settings.html#watchlists`);
  await page.fill("#wlsNewFolderName", "Kucoin trades");
  await page.click("#wlsNewFolder button");
  assert.equal(await page.inputValue("#wlsName"), "Kucoin trades");
  assert.equal(await page.evaluate(() => document.activeElement.id), "wlsAddInput");
  await page.fill("#wlsAddInput", "kucoin:btcusdt, bad$ KUCOIN:PENDLEUSDT");
  await page.press("#wlsAddInput", "Enter");
  assert.match(await page.textContent("#wlsNote"), /Added KUCOIN:BTCUSDT, KUCOIN:PENDLEUSDT\..*Not a valid symbol: bad\$/);
  assert.equal(await page.locator(".wls-ticker").count(), 2);
  await page.check('input[name="wlsBookmark"][value="red"]');
  assert.deepEqual(
    await page.locator(".wls-folder .wls-folder-name").allTextContents(),
    ["Kucoin trades", "My watchlist"],
    "the bookmarked folder moves to the top",
  );
  await page.click('[data-symbol="KUCOIN:PENDLEUSDT"] [data-act="up"]');
  assert.deepEqual(await page.locator(".wls-ticker").evaluateAll((els) => els.map((el) => el.dataset.symbol)),
    ["KUCOIN:PENDLEUSDT", "KUCOIN:BTCUSDT"]);

  // Overview: the active folder, its pin and TradingView links.
  await page.goto(base);
  const card = page.locator("#ov2-watchlist");
  assert.equal(await card.locator(".wl-title-name").textContent(), "Kucoin trades");
  assert.equal(await card.locator(".wl-pin").count(), 1);
  assert.equal(await card.locator(".wl-row").count(), 2);
  assert.equal(await card.locator(".wl-row").first().getAttribute("href"),
    "https://www.tradingview.com/chart/?symbol=KUCOIN%3APENDLEUSDT");
  assert.equal(await card.locator(".wl-add").getAttribute("href").then((h) => h.endsWith("#watchlists")), true);

  // Folder menu: bookmarked group first, keyboard close, switch folders.
  await card.locator(".wl-title-btn").click();
  assert.deepEqual(await card.locator(".wl-menu-group").allTextContents(), ["Bookmarked", "Watchlists", "Add a starter watchlist"]);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-checked")), "true");
  await page.keyboard.press("Escape");
  assert.equal(await card.locator(".wl-menu").isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("wl-title-btn")), true);
  await card.locator(".wl-title-btn").click();
  await card.locator('.wl-menu-item:has-text("My watchlist")').click();
  assert.equal(await card.locator(".wl-title-name").textContent(), "My watchlist");
  assert.equal(await card.locator(".wl-row").count(), 3);

  await page.reload();
  assert.equal(await card.locator(".wl-title-name").textContent(), "My watchlist", "the chosen folder persists");

  // Deleting the last folders leaves an empty state, not a broken card.
  await page.goto(`${base}/settings.html#watchlists`);
  await page.click("#wlsDelete");
  await page.click("#wlsDelete");
  await page.goto(base);
  assert.match(await card.locator(".wl-empty").textContent(), /No watchlists yet/);
  assert.deepEqual(errors, []);
});

test("Overview watchlist menu adds a starter watchlist in one click", {
  skip: !fs.existsSync(executablePath) && "Install Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE",
}, async (t) => {
  const publicDir = path.join(__dirname, "..", "public");
  const html = fs.readFileSync(path.join(publicDir, "overview-v2.html"), "utf8")
    .replace(/<script\b[^>]*src="[^"]*"[^>]*><\/script>/g, (tag) => (KEEP.test(tag) ? tag : ""));
  const app = express();
  app.get(["/", "/overview-v2.html"], (req, res) => res.type("html").send(html));
  app.use(express.static(publicDir));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/overview-v2.html`);

  await page.click("#ov2-watchlist .wl-title-btn");
  await page.click('#ov2-watchlist [data-preset="altcoins"]');
  assert.equal(await page.textContent("#ov2-watchlist .wl-title-name"), "Alt coins");
  assert.ok((await page.locator("#ov2-watchlist .wl-row").count()) > 0);
  await page.click("#ov2-watchlist .wl-title-btn");
  assert.equal(await page.locator('#ov2-watchlist [data-preset="altcoins"]').count(), 0, "an added starter leaves the menu");
  assert.equal(await page.locator("#ov2-watchlist [data-preset]").count(), 2);
});
