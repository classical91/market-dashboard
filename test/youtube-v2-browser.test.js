"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { chromium } = require("playwright");

const categories = [{ id: "markets", name: "Markets", channelCount: 1 }, { id: "tech", name: "Technology", channelCount: 1 }];
const channels = [
  { handle: "marketdesk", label: "Market Desk", categoryId: "markets", category: "Markets" },
  { handle: "techdesk", label: "Tech Desk", categoryId: "tech", category: "Technology" },
];
const thumbnail = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#23314d"/></svg>');
const videos = [
  { id: "live1234567", title: "Markets live", state: "live", concurrentViewers: 1200 },
  { id: "next1234567", title: "Tomorrow briefing", state: "upcoming", scheduledStartTime: "2099-01-01T12:00:00Z" },
  { id: "clip1234567", title: "Weekly market outlook", state: "video", publishedAt: "2026-11-14T12:00:00Z" },
].map((video) => ({ ...video, channelHandle: "marketdesk", channelLabel: "Market Desk", thumbnail }));
const feed = { channels, videos, live: [videos[0]], upcoming: [videos[1]], failedFeeds: [], meta: { liveDetection: "api", generatedAt: "2026-11-15T12:00:00Z" } };

// Uses only a local static server and intercepted fixture APIs. No credentials,
// upstream YouTube calls or production mutations are involved.
test("YouTube page browser regressions", { skip: !fs.existsSync(chromium.executablePath()) && "Install Chromium with npx playwright install chromium" }, async (t) => {
  const app = express();
  app.use(express.static(path.join(__dirname, "..", "public")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  async function open(t, handler, suffix = "") {
    const page = await browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], "no uncaught page errors"));
    await page.route("https://www.youtube.com/**", (route) => route.abort());
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const result = await handler?.(url, route.request());
      const body = result?.body ?? (url.pathname.endsWith("/channels/config") ? { categories, channels }
        : url.pathname === "/api/youtube/channels" ? feed : { role: "owner", authenticated: true });
      await route.fulfill({ status: result?.status || 200, json: body }).catch(() => {});
    });
    await page.goto(base + "/youtube-v2.html" + suffix);
    return page;
  }

  async function ready(page) {
    await page.waitForFunction(() => !document.getElementById("ytRefresh").disabled);
  }
  async function manager(page) {
    await page.getByRole("button", { name: "Manage channels", exact: true }).click();
    await page.getByRole("tab", { name: "Channels", exact: true }).waitFor();
  }

  await t.test("search, inline playback and focus restoration", async (t) => {
    const page = await open(t);
    await ready(page);
    assert.equal(await page.locator(".yt-feed-card").count(), 3);
    await page.locator("#ytSearch").fill("@marketdesk outlook");
    assert.equal(await page.locator(".yt-feed-card").count(), 1);
    assert.match(await page.locator("#ytFeedStatus").textContent(), /1 matching video/);
    await page.locator(".yt-feed-card").click();
    assert.match(await page.locator("#ytPlayer").getAttribute("src"), /embed\/clip1234567/);
    assert.equal(await page.locator("#ytWatchTitle").evaluate((node) => node === document.activeElement), true);
    await page.getByRole("button", { name: "Close player" }).click();
    assert.equal(await page.locator("#ytPlayer").getAttribute("src"), null);
    assert.equal(await page.locator(".yt-feed-card").evaluate((node) => node === document.activeElement), true);
    await page.locator("#ytSearch").fill("nonexistent");
    assert.match(await page.locator("#ytFeedStatus").textContent(), /0 matching videos/);
  });

  await t.test("queue: add, reorder, persist, play and auto-advance", async (t) => {
    const page = await open(t);
    // A stand-in embed that speaks just enough of the iframe API protocol.
    await page.route("https://www.youtube.com/embed/**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><script>addEventListener('message', function () { parent.postMessage(JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }), '*'); });</script>",
    }));
    await ready(page);
    const queueRows = page.locator("#ytQueueList .yt-queue-item");
    const order = () => queueRows.evaluateAll((rows) => rows.map((row) => row.dataset.rowId));
    assert.equal(await page.locator("#ytQueue").isVisible(), false);

    await page.getByRole("button", { name: "Add to queue: Weekly market outlook" }).click();
    await page.getByRole("button", { name: "Add to queue: Tomorrow briefing" }).click();
    assert.equal(await page.locator("#ytQueue").isVisible(), true);
    assert.equal(await page.locator("#ytQueueCount").textContent(), "2 videos");
    assert.deepEqual(await order(), ["clip1234567", "next1234567"]);
    assert.equal(await page.getByRole("button", { name: "Remove from queue: Tomorrow briefing" }).getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => /Added to queue: Tomorrow briefing/.test(document.getElementById("ytQueueAnnounce").textContent));

    await page.getByRole("button", { name: "Move up: Tomorrow briefing" }).click();
    assert.deepEqual(await order(), ["next1234567", "clip1234567"]);
    assert.equal(await queueRows.first().evaluate((row) => row.contains(document.activeElement)), true, "focus stays on the moved row");

    await page.reload();
    await ready(page);
    assert.deepEqual(await order(), ["next1234567", "clip1234567"], "queue survives a reload");

    await page.getByRole("button", { name: "Play queue" }).click();
    assert.match(await page.locator("#ytPlayer").getAttribute("src"), /embed\/next1234567\?autoplay=1&enablejsapi=1/);
    assert.deepEqual(await order(), ["clip1234567"]);
    assert.equal(await page.getByRole("button", { name: "Play queue" }).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Play next: Weekly market outlook" }).isVisible(), true);

    // The embed reports the video ended; the queue advances on its own.
    const frame = page.frameLocator("#ytPlayer");
    await frame.locator("script").waitFor({ state: "attached" });
    await page.waitForFunction(() => document.getElementById("ytPlayer").contentWindow && true);
    const embed = page.frames().find((f) => f.url().includes("/embed/next1234567"));
    await embed.evaluate(() => parent.postMessage(JSON.stringify({ event: "onStateChange", info: 0 }), "*"));
    await page.waitForFunction(() => /embed\/clip1234567/.test(document.getElementById("ytPlayer").src));
    assert.equal(await page.locator("#ytWatchTitle").textContent(), "Weekly market outlook");
    assert.equal(await page.locator("#ytQueue").isVisible(), false);
    assert.equal(await page.locator("#ytPlayNext").isVisible(), false);

    // Messages from anywhere but the player frame are ignored.
    await page.getByRole("button", { name: "Add to queue: Markets live" }).click();
    await page.evaluate(() => window.postMessage(JSON.stringify({ event: "onStateChange", info: 0 }), "*"));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.match(await page.locator("#ytPlayer").getAttribute("src"), /embed\/clip1234567/);

    // Autoplay off: an ended video stays put; Shift+N still skips ahead.
    await page.getByRole("checkbox", { name: "Autoplay" }).uncheck();
    const clip = page.frames().find((f) => f.url().includes("/embed/clip1234567"));
    await clip.evaluate(() => parent.postMessage(JSON.stringify({ event: "onStateChange", info: 0 }), "*"));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.match(await page.locator("#ytPlayer").getAttribute("src"), /embed\/clip1234567/);
    await page.locator("#ytWatchTitle").focus();
    await page.keyboard.press("Shift+N");
    assert.match(await page.locator("#ytPlayer").getAttribute("src"), /embed\/live1234567/);

    await page.getByRole("button", { name: "Add to queue: Tomorrow briefing" }).click();
    await page.getByRole("button", { name: "Remove: Tomorrow briefing" }).click();
    assert.equal(await page.locator("#ytQueue").isVisible(), false);
    await page.getByRole("button", { name: "Add to queue: Weekly market outlook" }).click();
    await page.getByRole("button", { name: "Clear" }).click();
    assert.equal(await queueRows.count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("yt:queue:v1")), null);
  });

  await t.test("queue layout fits and sits beside the player on wide screens", async (t) => {
    const page = await open(t);
    await ready(page);
    await page.getByRole("button", { name: "Add to queue: Weekly market outlook" }).click();
    await page.getByRole("button", { name: "Add to queue: Tomorrow briefing" }).click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `idle queue fits at ${width}px`);
    }
    await page.locator(".yt-feed-card").filter({ hasText: "Markets live" }).click();
    for (const width of [320, 390, 768, 1025, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `playing queue fits at ${width}px`);
      const watch = await page.locator("#ytWatch").boundingBox();
      const queue = await page.locator("#ytQueue").boundingBox();
      if (width >= 1440) {
        assert.ok(Math.abs(queue.y - watch.y) < 2 && queue.x > watch.x + watch.width - 1, `queue beside the player at ${width}px`);
        assert.ok(queue.height <= watch.height + 1, `queue no taller than the player at ${width}px`);
      } else if (width < 1180) {
        assert.ok(queue.y >= watch.y + watch.height, `queue under the player at ${width}px`);
      }
    }
  });

  await t.test("Gemini summary popup renders, seeks the player and closes", async (t) => {
    const posts = [];
    const page = await open(t, (url, request) => {
      if (!url.pathname.startsWith("/api/youtube/summary/")) return;
      if (request.method() === "GET") return { body: { provider: "gemini", configured: true, summary: null } };
      posts.push(url.pathname);
      return { body: { configured: true, summary: { videoId: "clip1234567", summary: "TL;DR: Rates matter.\n\n## Key points\n- [01:05] Fed holds <b>steady</b>\n\n## Market calls\n- None", model: "gemini-test", generatedAt: "2026-11-15T12:00:00Z", cached: false } } };
    });
    await ready(page);
    // Only finished uploads can be summarized: not the live or upcoming stream.
    assert.equal(await page.locator(".yt-summary-chip").count(), 1);
    await page.getByRole("button", { name: "Summarize Weekly market outlook with Gemini" }).click();
    const dialog = page.getByRole("dialog", { name: "Weekly market outlook" });
    await dialog.getByRole("heading", { name: "Key points" }).waitFor();
    assert.deepEqual(posts, ["/api/youtube/summary/clip1234567"]);
    assert.match(await dialog.locator(".yts-tldr").textContent(), /Rates matter/);
    // Summary text is never parsed as HTML.
    assert.equal(await dialog.locator("b").count(), 0);
    assert.match(await dialog.textContent(), /<b>steady<\/b>/);
    assert.equal(await page.locator("#ytPlayer").getAttribute("src"), null);
    await dialog.getByRole("link", { name: "Jump to 01:05" }).click();
    assert.match(await page.locator("#ytPlayer").getAttribute("src"), /embed\/clip1234567\?autoplay=1&enablejsapi=1.*&start=65$/);
    assert.equal(await page.locator(".yts-overlay").count(), 0);
    // The player bar offers the same popup, and Escape closes it without leaving focus mode.
    await page.getByRole("button", { name: "Summarize", exact: true }).click();
    await dialog.getByRole("heading", { name: "Key points" }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".yts-overlay").count(), 0);
    assert.equal(await page.locator("#ytWatch").isVisible(), true);
  });

  await t.test("summary popup explains a missing Gemini key", async (t) => {
    const page = await open(t, (url) => url.pathname.startsWith("/api/youtube/summary/") ? { body: { configured: false, summary: null } } : undefined);
    await ready(page);
    await page.locator(".yt-summary-chip").click();
    await page.getByText("Video summaries aren't set up yet.").waitFor();
    assert.match(await page.locator(".yts-dialog").textContent(), /GEMINI_API_KEY/);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await page.locator(".yts-overlay").count(), 0);
  });

  await t.test("configuration failure is recoverable without a reload", async (t) => {
    let failing = true;
    const page = await open(t, (url) => url.pathname.endsWith("/channels/config") && failing ? { status: 503, body: {} } : undefined);
    await ready(page);
    assert.match(await page.locator("#ytFeedStatus").textContent(), /Refresh feeds to try again/);
    failing = false;
    await page.getByRole("button", { name: "Refresh feeds" }).click();
    await page.locator(".yt-feed-card").first().waitFor();
    await ready(page);
    assert.equal(await page.locator("#ytCategoryFilter").isEnabled(), true);
  });

  await t.test("cached uploads and partial failures are disclosed", async (t) => {
    const page = await open(t, (url) => url.pathname === "/api/youtube/channels" ? { body: { ...feed, channels: [{ ...channels[0], stale: true }], failedFeeds: [{ label: "Tech Desk", reason: "rss-failed" }] } } : undefined);
    await ready(page);
    assert.match(await page.locator("#ytFeedStatus").textContent(), /1 channel is showing cached uploads/);
    assert.match(await page.locator("#ytFeedStatus").textContent(), /1 channel could not be loaded/);
    assert.equal(await page.locator(".yt-feed-card").count(), 3);
  });

  await t.test("expired sessions offer a login link", async (t) => {
    const page = await open(t, (url) => url.pathname === "/api/youtube/channels" ? { status: 401, body: {} } : undefined);
    await ready(page);
    assert.equal(await page.getByRole("link", { name: "Log in again" }).isVisible(), true);
    assert.match(await page.locator("#ytFeedStatus").textContent(), /session expired/);
  });

  await t.test("a deleted category falls back to all and releases the loading state", async (t) => {
    const requested = [];
    const page = await open(t, (url) => {
      if (url.pathname !== "/api/youtube/channels") return;
      requested.push(url.searchParams.get("categoryId"));
      if (requested.at(-1) === "markets") return { status: 400, body: { error: "Unknown YouTube category" } };
    }, "?category=markets");
    await page.locator(".yt-feed-card").first().waitFor();
    await ready(page);
    assert.deepEqual(requested, ["markets", "all"]);
    assert.equal(await page.locator("#ytCategoryFilter").inputValue(), "all");
    assert.equal(await page.locator("[aria-busy=true]").count(), 0);
  });

  await t.test("manager search keeps focus and preserves an open draft", async (t) => {
    const page = await open(t);
    await manager(page);
    await page.getByRole("button", { name: "+ Add Channel", exact: true }).click();
    await page.getByRole("textbox", { name: "YouTube handle", exact: false }).fill("@newdesk");
    assert.equal(await page.getByRole("textbox", { name: "New category name", exact: false }).isVisible(), false);
    const search = page.getByRole("textbox", { name: "Search channels", exact: true });
    await search.click();
    await search.pressSequentially("@market");
    assert.equal(await search.inputValue(), "@market");
    assert.equal(await search.evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.locator(".ytm-channel-row").count(), 1);
    assert.equal(await page.getByRole("textbox", { name: "YouTube handle", exact: false }).inputValue(), "@newdesk");
    await page.locator(".ytm-editor select").selectOption("__create__");
    assert.equal(await page.getByRole("textbox", { name: "New category name", exact: false }).isVisible(), true);
  });

  await t.test("failed channel saves retain the draft and reuse an inline-created category", async (t) => {
    let creates = 0;
    let saves = 0;
    const added = { id: "newcategory", name: "New category", channelCount: 0 };
    const page = await open(t, (url, request) => {
      if (request.method() !== "POST") return;
      if (url.pathname === "/api/youtube/categories/config") {
        creates++;
        return { body: { added, categories: [...categories, added] } };
      }
      if (url.pathname === "/api/youtube/channels/config") {
        saves++;
        assert.equal(request.postDataJSON().categoryId, added.id);
        return saves === 1 ? { status: 503, body: { error: "Temporary save failure" } }
          : { body: { channels, categories: [...categories, added] } };
      }
    });
    await manager(page);
    await page.getByRole("button", { name: "+ Add Channel", exact: true }).click();
    await page.getByRole("textbox", { name: "YouTube handle", exact: false }).fill("@newdesk");
    await page.locator(".ytm-editor select").selectOption("__create__");
    await page.getByRole("textbox", { name: "New category name", exact: false }).fill(added.name);
    await page.getByRole("button", { name: "Add channel", exact: true }).click();
    await page.locator(".ytm-inline-error").filter({ hasText: "Temporary save failure" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "YouTube handle", exact: false }).inputValue(), "@newdesk");
    assert.equal(await page.locator(".ytm-editor select").inputValue(), added.id);
    await page.getByRole("button", { name: "Add channel", exact: true }).click();
    await page.locator(".ytm-status").filter({ hasText: "Channel added." }).waitFor();
    assert.equal(creates, 1);
    assert.equal(saves, 2);
  });

  await t.test("delete confirmation traps focus and Escape cancels just the confirmation", async (t) => {
    const page = await open(t);
    await manager(page);
    await page.locator(".ytm-channel-row").first().getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove Market Desk?" });
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Shift+Tab");
    assert.equal(await dialog.getByRole("button", { name: "Remove", exact: true }).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.locator(".ytm-overlay").count(), 1);
    assert.equal(await page.locator(".ytm-channel-row").first().getByRole("button", { name: "Delete", exact: true }).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ytm-overlay").count(), 0);
  });

  await t.test("layouts fit phone, tablet and desktop widths", async (t) => {
    const page = await open(t);
    await ready(page);
    for (const width of [320, 390, 720, 768, 1025, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page fits at ${width}px`);
      assert.equal(await page.locator(".yt-header").evaluate((node) => node.scrollWidth <= node.clientWidth), true, `header fits at ${width}px`);
      await manager(page);
      assert.equal(await page.locator(".ytm-box").evaluate((node) => node.scrollWidth <= node.clientWidth), true, `manager fits at ${width}px`);
      assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
      await page.getByRole("button", { name: "+ Add Channel", exact: true }).click();
      assert.equal(await page.locator(".ytm-content").evaluate((node) => node.getBoundingClientRect().bottom <= node.parentElement.getBoundingClientRect().bottom), true, `manager scroll area stays inside the dialog at ${width}px`);
      await page.getByRole("button", { name: "Close source manager" }).click();
      assert.equal(await page.evaluate(() => document.body.style.overflow), "");
    }
  });

  await t.test("an in-flight deletion stays contained and submits once", async (t) => {
    let release;
    let deletes = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const page = await open(t, async (_url, request) => {
      if (request.method() !== "DELETE") return;
      deletes++;
      await pending;
      return { body: { channels: [channels[1]], categories } };
    });
    await manager(page);
    await page.locator(".ytm-channel-row").first().getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ytm-confirm button:last-child").disabled);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
    assert.equal(deletes, 1);
    release();
    await page.locator(".ytm-status").filter({ hasText: "Channel removed." }).waitFor();
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.locator(".ytm-channel-row").count(), 1);
  });

  await t.test("closing the manager during loading does not steal focus later", async (t) => {
    let release;
    let configs = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const page = await open(t, async (url) => {
      if (url.pathname.endsWith("/channels/config") && ++configs === 2) await pending;
    });
    await ready(page);
    await page.getByRole("button", { name: "Manage channels", exact: true }).click();
    await page.getByRole("button", { name: "Close source manager" }).click();
    await page.locator("#ytSearch").focus();
    const response = page.waitForResponse((res) => res.url().endsWith("/channels/config"));
    release();
    await response;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.locator("#ytSearch").evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.locator(".app").evaluate((node) => node.inert), false);
  });
});
