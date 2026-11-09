"use strict";

// Developing Stories in a real browser: the page's own scripts against
// stubbed /api/x feeds. Skipped (not failed) where Chromium cannot launch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PUBLIC = path.join(__dirname, "..", "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function staticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const MIN = 60e3;
let seq = 0;
function post(handle, minutesAgo, text, extra) {
  seq += 1;
  return Object.assign({
    id: String(9000 + seq),
    handle,
    text,
    url: "https://x.com/" + handle + "/status/" + (9000 + seq),
    publishedAt: new Date(Date.now() - minutesAgo * MIN).toISOString(),
  }, extra || {});
}

function feed(templateId, posts) {
  const handles = [...new Set(posts.map((p) => p.handle))];
  const now = new Date().toISOString();
  return {
    status: "live",
    generatedAt: now,
    lastCheckedAt: now,
    mostRecentSuccessfulFetchAt: now,
    oldestSuccessfulFetchAt: now,
    newestPostAt: posts[0] && posts[0].publishedAt,
    counts: {},
    template: { id: templateId },
    posts,
    accounts: handles.map((handle) => ({
      handle, label: handle, dataState: "live", lastCheckedAt: now, lastSuccessfulFetchAt: now,
    })),
    failedFeeds: [],
    staleFeeds: [],
  };
}

const MARKET_POSTS = [
  post("alpha", 20, "ECB raises rates by 50bps, Lagarde signals more hikes ahead"),
  post("beta", 35, "BREAKING: ECB hikes 50bps; Lagarde says further tightening likely"),
  post("gamma", 50, "Lagarde press conference: ECB 50bps hike was unanimous, euro rallies"),
  post("alpha", 180, "Nvidia $NVDA beats earnings, data center revenue up 112% year over year",
    { image: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }),
  post("beta", 190, "$NVDA earnings beat: data center revenue +112%, guidance strong"),
  post("delta", 40, "Netflix shares slide after subscriber guidance cut"),
];
const WORLD_POSTS = [
  post("eps", 30, "Baltimore Key Bridge collapse: Dali cargo ship struck pier, Maryland officials respond"),
  post("zeta", 45, "Key Bridge in Baltimore collapsed after Dali ship strike; Maryland closes Patapsco channel"),
];
const TEMPLATES = {
  defaultTemplateId: "markets",
  templates: [
    { id: "markets", name: "Crypto & Stocks", description: "Markets", accent: "market", handles: ["alpha", "beta", "gamma", "delta"] },
    { id: "world", name: "World News", description: "World", accent: "world", handles: ["eps", "zeta"] },
  ],
};

async function launch(t) {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (err) { t.skip("playwright not installed"); return null; }
  try {
    return await chromium.launch();
  } catch (err) {
    try { return await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }); } catch (err2) {}
    t.skip("chromium unavailable: " + String(err.message).split("\n")[0]);
    return null;
  }
}

async function openPage(browser, base, options) {
  const opts = options || {};
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const accountRequests = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  await page.route("**/api/x/templates", (route) => route.fulfill({ json: TEMPLATES }));
  await page.route("**/api/x/accounts?**", async (route) => {
    const template = new URL(route.request().url()).searchParams.get("template");
    accountRequests.push(template);
    if (opts.failFeed) return route.fulfill({ status: 503, body: "down" });
    const delay = (opts.delays && opts.delays[template]) || 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return route.fulfill({ json: template === "world" ? feed("world", WORLD_POSTS) : feed("markets", MARKET_POSTS) });
  });
  if (opts.storage) {
    await page.addInitScript((entries) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      for (const [k, v] of entries) localStorage.setItem(k, v);
    }, Object.entries(opts.storage));
  }
  await page.goto(base + "/x-intelligence.html");
  await page.waitForSelector("#xTimelinePane .x-post-card");
  return { page, context, errors, accountRequests };
}

const mainFeedKeys = (page) => page.$$eval("#xTimelinePane > .x-post-grid .x-post-card .x-post-open", (as) => as.map((a) => a.href));
const storyLabels = (page) => page.$$eval(".x-story-label", (els) => els.map((e) => e.textContent));

async function setStories(page, on) {
  const open = await page.getAttribute("#xFeedSettingsToggle", "aria-expanded");
  if (open !== "true") await page.click("#xFeedSettingsToggle");
  const pressed = (await page.getAttribute("#xFeedStories", "aria-pressed")) === "true";
  if (pressed !== on) await page.click("#xFeedStories");
}

test("Developing Stories in the browser", async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  const server = await staticServer();
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { await browser.close(); server.close(); });

  await t.test("off by default; the feed is unchanged and nothing is grouped", async () => {
    const { page, context, errors } = await openPage(browser, base);
    assert.equal(await page.getAttribute("#xFeedStories", "aria-pressed"), "false");
    assert.equal(await page.textContent("#xFeedStories"), "Developing Stories: Off");
    assert.equal(await page.$(".x-stories"), null);
    const before = await mainFeedKeys(page);
    assert.equal(before.length, MARKET_POSTS.length);

    await setStories(page, true);
    assert.ok(await page.$(".x-stories"));
    assert.deepEqual(await mainFeedKeys(page), before, "the feed below keeps every post, in order");
    // The feed's own cards keep Broadcast and FarmClaw; only story cards lack them.
    assert.equal(await page.$$eval("#xTimelinePane > .x-post-grid .x-post-broadcast", (b) => b.length), MARKET_POSTS.length);
    assert.equal(await page.$$eval("#xTimelinePane > .x-post-grid .x-post-farmclaw", (b) => b.length), MARKET_POSTS.length);

    await setStories(page, false);
    assert.equal(await page.$(".x-stories"), null);
    assert.deepEqual(await mainFeedKeys(page), before);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("groups start collapsed, expand to the original posts, and the choice is remembered", async () => {
    const { page, context, errors, accountRequests } = await openPage(browser, base);
    const requestsBefore = accountRequests.length;
    await setStories(page, true);
    assert.equal(await page.evaluate(() => localStorage.getItem("xIntelligence:developingStories:v1")), "on");
    assert.equal(accountRequests.length, requestsBefore, "turning it on fetches nothing");

    const labels = await storyLabels(page);
    assert.equal(labels.length, 2);
    assert.ok(labels.some((l) => /ECB/.test(l) && /Lagarde/.test(l)));
    assert.ok(labels.some((l) => /\$NVDA/.test(l)));
    assert.equal(await page.$$eval(".x-story-toggle[aria-expanded='true']", (b) => b.length), 0, "collapsed");
    assert.equal(await page.$$eval(".x-stories .x-post-card", (c) => c.length), 0, "no cards until opened");

    const ecb = page.locator(".x-story", { hasText: "Lagarde" });
    await expectText(ecb.locator(".x-story-meta"), /^3 posts · 3 accounts · first .+ · latest .+$/);
    await ecb.locator(".x-story-toggle").click();
    assert.equal(await ecb.locator(".x-story-toggle").getAttribute("aria-expanded"), "true");
    const cards = ecb.locator(".x-post-card");
    assert.equal(await cards.count(), 3);
    const shown = await cards.evaluateAll((els) => els.map((el) => ({
      handle: el.querySelector(".x-tag").textContent,
      text: el.querySelector(".x-post-text").textContent,
      href: el.querySelector(".x-post-open").href,
      time: el.querySelector("time") && el.querySelector("time").getAttribute("datetime"),
      broadcast: !!el.querySelector(".x-post-broadcast, .x-post-farmclaw"),
    })));
    for (const p of MARKET_POSTS.slice(0, 3)) {
      const card = shown.find((c) => c.href === p.url);
      assert.ok(card, "original link " + p.url);
      assert.equal(card.handle, "@" + p.handle);
      assert.equal(card.text, p.text);
      assert.equal(card.time, p.publishedAt);
      assert.equal(card.broadcast, false);
    }
    // No duplicate ids between story cards and the feed.
    const dupIds = await page.evaluate(() => {
      const seen = {}; const dups = [];
      document.querySelectorAll("[id]").forEach((el) => { if (seen[el.id]) dups.push(el.id); seen[el.id] = true; });
      return dups;
    });
    assert.deepEqual(dupIds, []);

    // Keyboard: the group toggle is a real button.
    await ecb.locator(".x-story-toggle").focus();
    await page.keyboard.press("Enter");
    assert.equal(await ecb.locator(".x-story-toggle").getAttribute("aria-expanded"), "false");
    await page.keyboard.press("Space");
    assert.equal(await ecb.locator(".x-story-toggle").getAttribute("aria-expanded"), "true");

    // The whole section folds too.
    await page.click(".x-stories-toggle");
    assert.equal(await page.isHidden("#xStoriesBody"), true);
    await page.click(".x-stories-toggle");

    await page.reload();
    await page.waitForSelector(".x-stories");
    assert.equal(await page.getAttribute("#xFeedStories", "aria-pressed"), "true");
    assert.equal(await page.$$eval(".x-story-toggle[aria-expanded='true']", (b) => b.length), 0,
      "groups start collapsed again on a new visit");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("search, time, media and account filters change the groups", async () => {
    const { page, context, errors } = await openPage(browser, base);
    await setStories(page, true);
    assert.equal((await storyLabels(page)).length, 2);

    await page.fill("#xFeedSearch", "lagarde");
    await page.waitForFunction(() => document.querySelectorAll(".x-story").length === 1);
    assert.match((await storyLabels(page))[0], /Lagarde/);
    await page.fill("#xFeedSearch", "");
    await page.waitForFunction(() => document.querySelectorAll(".x-story").length === 2);

    await page.click("#xFeedTime button[data-time='1h']");
    assert.equal((await storyLabels(page)).length, 1, "NVDA posts are 3h old");
    await page.click("#xFeedTime button[data-time='all']");

    await page.click("#xFeedMedia");
    assert.equal(await page.$(".x-stories"), null, "one media post is not a group, and no empty section is drawn");
    await page.click("#xFeedMedia");

    await page.selectOption("#xFeedAccount", "alpha");
    assert.equal(await page.$(".x-stories"), null, "a single account never forms a group");
    await page.selectOption("#xFeedAccount", "");
    assert.equal((await storyLabels(page)).length, 2);

    // Display modes keep working with a group open.
    await page.locator(".x-story-toggle").first().click();
    for (const view of ["cards", "focus", "compact"]) {
      await page.click("#xFeedView button[data-view='" + view + "']");
      assert.equal(await page.getAttribute("#xTimelinePane", "data-x-view"), view);
      assert.ok(await page.$(".x-stories .x-post-card"), "the open group survives a view change");
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("switching templates replaces the groups", async () => {
    const { page, context, errors } = await openPage(browser, base);
    await setStories(page, true);
    assert.ok((await storyLabels(page)).some((l) => /ECB/.test(l)));
    await page.click("#xTemplateTrigger");
    await page.click(".x-template-option:has-text('World News')");
    await page.waitForFunction(() => document.querySelector("#xTemplateTriggerLabel").textContent === "World News");
    await page.waitForFunction(() => /Bridge|Baltimore|Maryland|Dali/.test((document.querySelector(".x-story-label") || {}).textContent || ""));
    const labels = await storyLabels(page);
    assert.equal(labels.length, 1);
    assert.doesNotMatch(labels.join(" "), /ECB|Lagarde|NVDA/);
    const storyHrefs = await page.$$eval(".x-stories .x-post-open", (as) => as.map((a) => a.href));
    assert.deepEqual(storyHrefs, [], "collapsed after the switch");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("a late response for the template the reader left is not shown under the new one", async () => {
    const delays = {};
    const { page, context, errors } = await openPage(browser, base, {
      delays,
      storage: { "xIntelligence:developingStories:v1": "on" },
    });
    const pick = async (name) => {
      await page.click("#xTemplateTrigger");
      await page.click(".x-template-option:has-text('" + name + "')");
    };
    await pick("World News");
    await page.waitForFunction(() => /Bridge/.test((document.querySelector(".x-story-label") || {}).textContent || ""));
    delays.markets = 1200;
    await pick("Crypto & Stocks");
    await pick("World News");
    await page.waitForTimeout(1800);
    assert.equal(await page.textContent("#xTemplateTriggerLabel"), "World News");
    const hrefs = await mainFeedKeys(page);
    assert.deepEqual(hrefs.sort(), WORLD_POSTS.map((p) => p.url).sort());
    assert.doesNotMatch((await storyLabels(page)).join(" "), /ECB|NVDA/);
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("xIntelligence:feedCache:v5:world")));
    assert.deepEqual(cached.payload.posts.map((p) => p.url).sort(), WORLD_POSTS.map((p) => p.url).sort(),
      "the world cache was not overwritten with market posts");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("cached data is labelled as cached, never as live", async () => {
    const savedAt = Date.now() - 20 * MIN;
    const { page, context, errors } = await openPage(browser, base, {
      failFeed: true,
      storage: {
        "xIntelligence:developingStories:v1": "on",
        "xIntelligence:feedCache:v5:markets": JSON.stringify({ savedAt, payload: feed("markets", MARKET_POSTS) }),
      },
    });
    await page.waitForSelector(".x-stories-caveat");
    const caveat = await page.textContent(".x-stories-caveat");
    assert.match(caveat, /browser-cached posts saved 20 minutes ago/);
    assert.match(caveat, /not a live view/);
    const section = await page.textContent(".x-stories");
    assert.doesNotMatch(section, /\b(confirmed|verified|live)\b(?! view)/i);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test("phone width: no horizontal overflow with a group open", async () => {
    const { page, context, errors } = await openPage(browser, base, {
      viewport: { width: 390, height: 844 },
      storage: { "xIntelligence:developingStories:v1": "on" },
    });
    await page.waitForSelector(".x-stories");
    await page.locator(".x-story-toggle").first().click();
    const overflow = await page.evaluate(() => {
      const section = document.querySelector(".x-stories").getBoundingClientRect();
      return { right: section.right, width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
    });
    assert.ok(overflow.right <= overflow.width + 1, JSON.stringify(overflow));
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
    assert.deepEqual(errors, []);
    await context.close();
  });
});

async function expectText(locator, pattern) {
  const text = (await locator.textContent()).replace(/\s+/g, " ").trim();
  assert.match(text, pattern);
}
