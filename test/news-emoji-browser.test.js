"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { chromium } = require("playwright");

test("news emojis survive asynchronous reports, refreshes, copy, and image failures", {
  timeout: 30000,
  skip: !fs.existsSync(chromium.executablePath()) && "Install Chromium with npx playwright install chromium",
}, async t => {
  const publicDir = path.join(__dirname, "..", "public");
  const app = express();
  app.get("/briefings/geopolitics", (req, res) => res.sendFile(path.join(publicDir, "briefing.html")));
  const server = http.createServer(app.use(express.static(publicDir)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText(text) { window.copiedText = text; return Promise.resolve(); }
    } });
  });
  let report = "## 🌍 Geopolitics\n1. **🇺🇸 United States** — Talks continue\n- ⚠️ Risk: 👩🏽‍💻 briefed leaders\n<script>window.injected = true</script>";
  const now = new Date().toISOString();
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    let data = {};
    if (pathname === "/api/phone-briefings") data = { categories: [
      { key: "geopolitics", label: "Geopolitics", icon: "🌍", latest: { receivedAt: now } }
    ] };
    else if (pathname === "/api/phone-briefings/geopolitics") data = { runs: [{ id: "fixture", receivedAt: now }] };
    else if (pathname === "/api/phone-briefings/geopolitics/fixture") data = { id: "fixture", text: report, receivedAt: now };
    return route.fulfill({ json: data });
  });
  let imageRequests = 0;
  await page.route("https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/**", route => {
    imageRequests++;
    if (route.request().url().endsWith("1f680.svg")) return route.abort();
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><circle cx="18" cy="18" r="18" fill="#ffcc00"/></svg>' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/briefings/geopolitics`);
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll("#briefingBody img.news-emoji"));
    return images.length === 4 && images.every(img => img.complete && img.naturalWidth > 0);
  });
  assert.deepEqual(await page.locator("#briefingBody img.news-emoji").evaluateAll(images => images.map(img => img.alt)), ["🌍", "🇺🇸", "⚠️", "👩🏽‍💻"]);
  assert.match(await page.locator('img[alt="🇺🇸"]').getAttribute("src"), /1f1fa-1f1f8\.svg$/);
  assert.match(await page.locator('img[alt="👩🏽‍💻"]').getAttribute("src"), /1f469-1f3fd-200d-1f4bb\.svg$/);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator("#briefingCopy").click();
  assert.equal(await page.evaluate(() => window.copiedText), report);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('img[alt="🇺🇸"]').evaluate(img => {
      const rect = img.getBoundingClientRect();
      return rect.width === rect.height && rect.width > 0 && rect.width <= 24;
    }), true);
  }
  // A failed asset falls back once, rather than entering an observer loop.
  report = "🇬🇧 Updated report 🚀";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector("#briefingBody .news-emoji-fallback")?.textContent === "🚀");
  assert.equal(await page.locator('#briefingBody img[alt="🇬🇧"]').count(), 1);
  assert.equal(await page.locator("#briefingBody img.news-emoji").count(), 1);
  const requestsAfterFallback = imageRequests;
  await page.locator("#briefingCopy").click();
  assert.equal(await page.evaluate(() => window.copiedText), report);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(imageRequests, requestsAfterFallback);
  // Inputs/code retain literal Unicode. A text-node update is observed too.
  await page.evaluate(() => {
    const holder = document.createElement("div");
    holder.id = "emojiFixture";
    holder.innerHTML = '<textarea>🇺🇸</textarea><code>⚠️</code><span contenteditable="true">🌍</span><button>Ready</button>';
    document.querySelector(".cmd-main").appendChild(holder);
    holder.querySelector("button").addEventListener("click", () => { window.fixtureClicked = true; });
    holder.querySelector("button").firstChild.data = "✅ Ready";
  });
  await page.waitForSelector('#emojiFixture button img[alt="✅"]');
  assert.equal(await page.locator("#emojiFixture img").count(), 1);
  await page.locator("#emojiFixture button").click();
  assert.equal(await page.evaluate(() => window.fixtureClicked), true);
  assert.deepEqual(errors, []);
});
