"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helpers = require("../public/assets/js/kucoin-live-trades");
const { KucoinLiveTradesService } = require("../src/services/kucoin-live-trades/service");
const { createKucoinLiveTradesRouter } = require("../src/routes/kucoin-live-trades");
const { MockKucoinWebSocket, spotTradeFrame, futuresTradeFrame, stubInstruments } = require("./helpers/kucoin-mock-websocket");

const ROOT = path.join(__dirname, "..");
const sidebar = fs.readFileSync(path.join(ROOT, "public/assets/js/sidebar.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public/kucoin-live-trades.html"), "utf8");

// ── Pure frontend helpers ────────────────────────────────────────────────

function t(over) {
  return {
    exchange: "kucoin", marketType: "spot", symbol: "BTC-USDT", tradeId: "1", side: "buy", sideVerified: true,
    price: 61718.8, priceText: "61718.8", quantity: 0.5, quantityText: "0.5", quantityUnit: "BTC", baseQuantity: 0.5,
    notional: 30859.4, exchangeTimeMs: Date.UTC(2026, 10, 20, 6, 0, 0, 123), exchangeTimeNs: "1795154400123000000",
    receivedAt: Date.UTC(2026, 10, 20, 6, 0, 0, 200), ...over,
  };
}

test("the tape filter keeps newest-first order, applies the minimum value and the row cap", () => {
  const trades = [t({ tradeId: "3", notional: 50 }), t({ tradeId: "2", notional: 20000 }), t({ tradeId: "1", notional: null })];
  assert.deepEqual(helpers.visibleTrades(trades, { minValue: 0, rows: 2 }).map((x) => x.tradeId), ["3", "2"]);
  assert.deepEqual(helpers.visibleTrades(trades, { minValue: 100, rows: 200 }).map((x) => x.tradeId), ["2"], "unpriced trades never pass a value filter");
});

test("whale classification requires a computed notional and verified side", () => {
  const trades = [t({ notional: 10000 }), t({ notional: 9999.99 }), t({ notional: null }), t({ notional: 50000, sideVerified: false })];
  assert.equal(helpers.whaleTrades(trades, 10000).length, 1);
});

test("CSV export carries exact identifiers and timestamps", () => {
  const csv = helpers.buildCsv([t({ tradeId: "25376143998074881", symbol: 'BTC,"X"' })]);
  const [header, row] = csv.trim().split("\r\n");
  assert.equal(header, "exchange_time_utc,exchange_time_ns,exchange,market,symbol,trade_id,side_taker,price,quantity,quantity_unit,base_quantity,notional_usdt,received_at_utc");
  assert.match(row, /^2026-11-20T06:00:00\.123Z,1795154400123000000,kucoin,spot,"BTC,""X""",25376143998074881,buy,61718\.8,0\.5,BTC,0\.5,30859\.4,/);
});

test("CVD is drawn relative to its baseline and only after it", () => {
  const minutes = [
    { t: 0, cvdQuote: 100, cvdBase: 1 },
    { t: 60000, cvdQuote: 250, cvdBase: 2 },
    { t: 120000, cvdQuote: 400, cvdBase: 3 },
  ];
  const fromSession = helpers.cvdSeries(minutes, { baseline: { quote: 0, base: 0, at: 0 }, live: { quote: 420, base: 3.1 }, now: 150000 });
  assert.deepEqual(fromSession.map((p) => p.v), [0, 100, 250, 420]);
  const afterReset = helpers.cvdSeries(minutes, { baseline: { quote: 250, base: 2, at: 110000 }, live: { quote: 420, base: 3.1 }, now: 150000, unit: "quote" });
  // The minute ending at 60s is dropped (it ended before the reset); the one
  // ending at 120s is kept relative to the baseline; the live point closes it.
  assert.deepEqual(afterReset.map((p) => p.v), [0, 0, 170]);
  assert.deepEqual(afterReset.map((p) => p.t), [110000, 120000, 150000]);
  const base = helpers.cvdSeries(minutes, { baseline: { quote: 0, base: 0, at: 0 }, unit: "base", now: 130000 });
  assert.deepEqual(base.map((p) => p.v), [0, 1, 2]);
});

test("minute axis fills quiet minutes and ends at the current minute", () => {
  const axis = helpers.minuteAxis([{ t: 60000, tradeCount: 5 }], 250000, 60);
  assert.deepEqual(axis.map((m) => m.t), [60000, 120000, 180000, 240000]);
  assert.equal(axis[1].empty, true);
});

test("formatting keeps prices at tick precision and futures in contracts", () => {
  assert.equal(helpers.fmtPrice(61718.8, "0.1"), "61,718.8");
  assert.equal(helpers.fmtPrice(72.749, "0.001"), "72.749");
  assert.equal(helpers.fmtQuantity(t({ quantityUnit: "contracts", quantity: 1200, quantityText: "1200" })), "1,200");
  assert.equal(helpers.fmtQuantity(t({ quantityText: "0.00008036" })), "0.00008036");
  assert.equal(helpers.fmtCompact(-1234567, { signed: true }), "-$1.23M");
  assert.equal(helpers.fmtDuration(300000), "5m");
  assert.equal(helpers.fmtDuration(130000), "2m 10s");
  assert.equal(helpers.escapeHtml('<b a="1">'), "&lt;b a=&quot;1&quot;&gt;");
});

// ── Navigation ───────────────────────────────────────────────────────────

test("Live Trades sits under TradeHunter, outside the Screeners submenu", () => {
  const start = sidebar.indexOf('label: "TradeHunter"');
  const end = sidebar.indexOf('label: "AI Analysis"', start);
  const tradeHunter = sidebar.slice(start, end);
  assert.match(tradeHunter, /\{ href: "\/kucoin-live-trades\.html", label: "Live Trades" \}/);
  const screeners = tradeHunter.slice(tradeHunter.indexOf('label: "Screeners"'), tradeHunter.indexOf('href: "/tradehunter/market-matrix"'));
  assert.doesNotMatch(screeners, /kucoin-live-trades/);
  assert.ok(tradeHunter.indexOf('label: "Live Trades"') > tradeHunter.indexOf('label: "Market Matrix"'));
  assert.ok(tradeHunter.indexOf('label: "Live Trades"') < tradeHunter.indexOf('label: "Track Record"'));
  assert.equal(sidebar.match(/label: "Live Trades"/g).length, 1);
});

test("the page uses the shared shell and loads no third-party script", () => {
  assert.match(html, /<aside class="cmd-sidebar"><\/aside>/);
  assert.match(html, /\/assets\/js\/sidebar\.js/);
  assert.match(html, /\/assets\/styles\/command\.css/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.every((src) => src.startsWith("/assets/")), scripts.join(", "));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "public/assets/js/kucoin-live-trades.js"), "utf8"), /setInterval\([^)]*location\.reload|location\.reload\(/, "no automatic page refresh");
});

// ── Browser: real page, real service, mock KuCoin socket ─────────────────

function chromiumPath() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch { return null; }
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromium.executablePath()].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

test("live trades page in a browser (desktop and mobile)", {
  skip: !chromiumPath() && "Install Chromium (npx playwright install chromium) or set PLAYWRIGHT_CHROMIUM_EXECUTABLE",
}, async (t) => {
  const { chromium, devices } = require("playwright");
  MockKucoinWebSocket.reset();
  const service = new KucoinLiveTradesService({
    instruments: stubInstruments(),
    WebSocketImpl: MockKucoinWebSocket,
    logger: { log() {}, warn() {}, error() {} },
    flushIntervalMs: 50,
    statsIntervalMs: 200,
    lingerMs: 50,
    socketOptions: { backoffBaseMs: 100000 },
  });
  service.start();
  const app = express();
  app.get("/api/auth/session", (req, res) => res.json({ authenticated: true, role: "owner", identifier: "Owner" }));
  app.use("/api/kucoin-live-trades", createKucoinLiveTradesRouter({ kucoinLiveTradesService: service }));
  app.use(express.static(path.join(ROOT, "public")));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox"] });
  t.after(async () => {
    await browser.close();
    service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const until = async (fn, label, timeoutMs = 5000) => {
    const start = Date.now();
    while (!(await fn())) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const socketFor = (url) => MockKucoinWebSocket.instances.filter((ws) => ws.url === url).pop();
  // Trade ids above 2^53 must be counted as BigInt: Number increments would
  // collapse into duplicates (which the page then — correctly — drops).
  let nextIdBig = 25376143998074900n;
  const newId = () => String(nextIdBig++);
  const nowNs = (offsetMs = 0) => `${Date.now() + offsetMs}000000`;

  await t.test("desktop: tape, highlights, whales, pause, filter, CSV, futures and reconnect", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/kucoin-live-trades.html?market=spot&asset=BTC`);

    // Sidebar: the page's own link is active and sits under TradeHunter.
    const navLink = page.locator('.cmd-sidebar a[data-nav-href="/kucoin-live-trades.html"]');
    await navLink.waitFor();
    assert.equal(await navLink.getAttribute("aria-current"), "page");
    assert.equal(await navLink.textContent(), "Live Trades");

    await page.locator(".klt-empty").first().waitFor();
    assert.equal(await page.locator(".klt-row").count(), 0, "no rows before KuCoin sends anything");
    await until(() => socketFor("wss://x-push-spot.kucoin.com"), "spot socket");
    const spot = socketFor("wss://x-push-spot.kucoin.com");
    spot.welcome();
    spot.ackAll();
    await until(async () => (await page.locator("#klt-conn").textContent()) === "Live", "Live pill");

    spot.receive(spotTradeFrame({ id: newId(), side: "buy", price: "61700.1", qty: "0.01", timeNs: nowNs(-30) }));
    spot.receive(spotTradeFrame({ id: newId(), side: "sell", price: "61700.0", qty: "10", timeNs: nowNs(-20) }));
    spot.receive(spotTradeFrame({ id: newId(), side: "buy", price: "61700.2", qty: "0.002", timeNs: nowNs(-10) }));
    await until(async () => (await page.locator(".klt-row").count()) === 3, "three rows");
    const rows = page.locator(".klt-row");
    assert.match(await rows.nth(0).getAttribute("class"), /klt-row--buy/, "newest first");
    assert.match(await rows.nth(1).getAttribute("class"), /klt-row--sell.*is-large/, "a $617k print is highlighted");
    assert.match(await rows.nth(1).innerText(), /61,700\.0\s+10\s+617,000\.00\s+Sell/i);
    assert.equal(await page.locator("#klt-qty-head").textContent(), "Quantity (BTC)");
    await until(async () => (await page.locator(".klt-whale").count()) === 1, "whale row");
    assert.match(await page.locator(".klt-whale").innerText(), /BTC-USDT\s+Sell\s+\$617\.0K\s+@ 61,700\.0/i);
    await until(async () => /\$617\.0K/.test(await page.locator("#kpi-sell .klt-kpi-value").textContent()), "sell KPI");
    assert.match(await page.locator("#kpi-sell .klt-kpi-sub").innerText(), /partial/);
    assert.match(await page.locator("#klt-coverage").textContent(), /partial/);

    // Pause freezes the tape but the feed keeps arriving.
    await page.click("#klt-pause");
    assert.equal(await page.locator("#klt-pause").getAttribute("aria-pressed"), "true");
    spot.receive(spotTradeFrame({ id: newId(), side: "buy", price: "61701", qty: "0.1", timeNs: nowNs() }));
    await until(async () => /1 new trade received/.test(await page.locator("#klt-paused-banner").textContent()), "paused banner count");
    assert.equal(await page.locator(".klt-row").count(), 3, "rows do not move while paused");
    assert.equal(await page.locator("#klt-conn").textContent(), "Live", "paused rendering is not a disconnected source");
    assert.equal(await page.locator("#klt-paused-pill").isVisible(), true);
    await page.click("#klt-pause");
    await until(async () => (await page.locator(".klt-row").count()) === 4, "catch up after resume");
    assert.equal(await page.locator("#klt-paused-pill").isVisible(), false);

    // Minimum value filter.
    await page.fill("#klt-min-value", "10000");
    await until(async () => (await page.locator(".klt-row").count()) === 1, "filtered rows");
    await page.fill("#klt-min-value", "0");

    // CSV of the buffer.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#klt-export-buffer")]);
    const csv = fs.readFileSync(await download.path(), "utf8").trim().split("\r\n");
    assert.equal(csv.length, 5);
    assert.match(csv[0], /^exchange_time_utc,exchange_time_ns/);
    assert.match(download.suggestedFilename(), /^kucoin-spot-BTC-USDT-buffered-.*\.csv$/);

    // Futures: a different socket, symbol and quantity unit.
    await page.click('[data-market="futures"]');
    await until(() => socketFor("wss://x-push-futures.kucoin.com"), "futures socket");
    const fut = socketFor("wss://x-push-futures.kucoin.com");
    fut.welcome();
    assert.equal(fut.subscriptions()[0].symbol, "XBTUSDTM");
    fut.ackAll();
    fut.receive(futuresTradeFrame({ id: newId(), qty: "12", price: "90551.8", side: "sell", timeNs: nowNs() }));
    await until(async () => (await page.locator(".klt-row").count()) === 1, "futures row");
    assert.equal(await page.locator("#klt-qty-head").textContent(), "Quantity (contracts)");
    assert.match(await page.locator(".klt-row").innerText(), /90,551\.8\s+12\s+1,086\.62\s+Sell/i);
    assert.match(await page.locator("#klt-symbol").textContent(), /XBTUSDTM · 1 contract = 0\.001 BTC/);
    await until(async () => (await page.locator("#klt-pair option[value=BTC]").textContent()) === "BTC · XBTUSDTM", "pair labels follow the market");

    // Upstream drop is shown as reconnecting, not as live.
    fut.serverClose(1006);
    await until(async () => (await page.locator("#klt-conn").textContent()) === "Reconnecting", "reconnecting pill");
    assert.match(await page.locator("#klt-conn-msg").textContent(), /Reconnecting to KuCoin/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("mobile: fits a phone screen without horizontal scrolling", async () => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/kucoin-live-trades.html?market=spot&asset=ETH`);
    await until(() => MockKucoinWebSocket.instances.some((ws) => ws.url.includes("spot") && ws.readyState !== 3 && !ws.closedByClient), "spot socket");
    const ws = MockKucoinWebSocket.instances.filter((s) => s.url.includes("spot") && !s.closedByClient).pop();
    if (ws.readyState !== 1) ws.welcome();
    ws.ackAll();
    ws.receive(spotTradeFrame({ symbol: "ETH-USDT", id: newId(), price: "1749.09", qty: "2", timeNs: nowNs() }));
    await page.locator(".klt-row").first().waitFor();
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(scrollWidth <= innerWidth, `page scrolls sideways (${scrollWidth} > ${innerWidth})`);
    const tableBox = await page.locator(".klt-table-wrap").boundingBox();
    assert.ok(tableBox.width <= innerWidth, "the tape fits the screen");
    for (const selector of ["#klt-pause", '[data-market="futures"]', "#klt-pair", "#klt-export-visible"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box.height >= 32, `${selector} is a usable touch target (${box.height}px)`);
    }
    assert.equal(await page.locator(".cmd-sidebar").isVisible(), false, "desktop sidebar hidden on phones");
    assert.deepEqual(errors, []);
    await context.close();
  });
});
