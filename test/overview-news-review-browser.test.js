"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { chromium } = require("playwright");

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();

test("Overview report review browser flow", {
  skip: !fs.existsSync(executablePath) && "Install Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE",
}, async (t) => {
  const publicDir = path.join(__dirname, "..", "public");
  const app = express();
  let unavailable = false;
  let writes = 0;
  const now = new Date().toISOString();
  const content = "# Latest economics report\n\n" +
    "**Verified headlines** with a [source](https://example.com/news).\n\n" +
    "<script>window.unsafeReport = true</script>\n\n" +
    Array.from({ length: 25 }, (_, i) => `${i + 1}. Report detail with enough text to scroll through the review.`).join("\n\n");
  app.use((req, _res, next) => { if (req.method !== "GET") writes++; next(); });
  // Real markup and styles, with only the news/status scripts enabled. All
  // data is local fixture data; this never runs a model or contacts production.
  app.get(["/", "/briefings/:desk"], (req, res) => {
    const html = fs.readFileSync(path.join(publicDir, req.path === "/" ? "overview-v2.html" : "briefing.html"), "utf8");
    res.type("html").send(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) =>
      /src="\/assets\/js\/(settings|screener-ui|briefing-freshness|briefing-markdown|overview-news-review|overview-v2-status)\.js"/.test(tag) &&
        (req.path === "/" || /settings\.js/.test(tag)) ? tag : ""));
  });
  app.get("/api/phone-briefings", (_req, res) => {
    if (unavailable) return res.status(503).json({ error: "Source unavailable" });
    res.json({ categories: [{ key: "geopolitics", latest: { receivedAt: now, title: "Phone briefing", text: "Phone report content" } }] });
  });
  app.get("/api/daily-report/generations", (req, res) => {
    if (unavailable) return res.status(503).json({ error: "Source unavailable" });
    res.json({ generations: req.query.section === "economics" ? [{ generatedAt: now, content }] : [] });
  });
  app.get("/api/*", (_req, res) => res.status(503).json({ error: "Unrelated fixture source unavailable" }));
  app.use(express.static(publicDir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dialog = page.locator("#ov2-news-review");
  const tile = (key) => page.locator(`[data-news-desk="${key}"]`);

  await page.goto(base);
  await tile("economics").click();
  assert.equal(await dialog.isVisible(), true);
  assert.match(await dialog.textContent(), /Latest economics report/);
  assert.equal(await dialog.locator("script").count(), 0, "report HTML is escaped");
  assert.equal(await dialog.locator('a[href="https://example.com/news"]').count(), 1);
  assert.equal(await page.locator("#ov2-review-close").evaluate((el) => el === document.activeElement), true);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true, "keyboard focus stays in review");
  }
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await tile("economics").evaluate((el) => el === document.activeElement), true);

  for (const [width, height] of [[1440, 900], [390, 700], [320, 568], [768, 360]]) {
    await page.setViewportSize({ width, height });
    await tile("economics").click();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, "review fits the viewport");
    assert.equal(await page.locator("#ov2-review-body").evaluate((el) => el.scrollHeight > el.clientHeight), true);
    await page.locator("#ov2-review-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const footer = await page.locator("#ov2-review-run").boundingBox();
    assert.ok(footer.y >= bounds.y && footer.y + footer.height <= bounds.y + bounds.height, "run link stays visible below scrolling content");
    if (process.env.NEWS_REVIEW_SCREENSHOT_DIR && (width === 1440 || width === 390)) {
      await page.locator("#ov2-review-body").evaluate((el) => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(process.env.NEWS_REVIEW_SCREENSHOT_DIR, `news-review-${width}.png`) });
    }
    await page.locator("#ov2-review-close").click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await tile("geopolitics").click();
  assert.match(await dialog.textContent(), /Phone briefing[\s\S]*Phone report content/);
  await page.mouse.click(2, 2);
  assert.equal(await dialog.isVisible(), false, "backdrop closes review");
  await tile("stocks").click();
  assert.match(await dialog.textContent(), /No report recorded/);
  await page.locator("#ov2-review-run").click();
  await page.waitForURL(base + "/briefings/stocks#briefingRun");
  assert.equal(await page.locator("#briefingRun").isVisible(), true, "link opens the actual desk run control");
  assert.equal(writes, 0, "reading and navigating never start a run");
  unavailable = true;
  await page.goto(base);
  await tile("crypto").click();
  assert.match(await dialog.textContent(), /Could not load reports/);
  assert.deepEqual(errors, []);
});
