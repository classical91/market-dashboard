"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const SITE_PASSWORD = "site-password";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-daily-top-news-routes-"));
process.env.BROADCAST_LEDGER_API_KEY = "test-ledger-key";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.MARKET_DASHBOARD_LOGIN_PASSWORD = SITE_PASSWORD;

const { createApp } = require("../src/app");
const { PhoneBriefingStore } = require("../src/services/phone-briefings");
const { buildDailyTopNews, splitStories, localDateKey } = require("../src/services/daily-top-news");

function newStore() {
  return new PhoneBriefingStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-daily-top-news-")),
    logger: { error() {} },
  });
}

function numbered(count, format) {
  return Array.from({ length: count }, (_, i) => format(i + 1)).join("\n");
}

test("the reporter prompt format splits into ten stories with their bullets", () => {
  const text = "🗓️ Nov 14\n💹 TOP 10 GLOBAL ECONOMIC DEVELOPMENTS\n\n" +
    numbered(10, (n) => `**#${n} US — Story ${n}**\n- What happened ${n}\n- Why it matters`);
  const { intro, stories } = splitStories(text);
  assert.equal(stories.length, 10);
  assert.match(intro, /TOP 10 GLOBAL/);
  assert.deepEqual(stories[0], { number: 1, title: "US — Story 1", body: "- What happened 1\n- Why it matters" });
  assert.equal(stories[9].title, "US — Story 10");
});

test("numbered sub-points inside a story are not taken for the next story", () => {
  // The markets prompt numbers each story's fields 1-4; bold story numbers win.
  const text = numbered(3, (n) => `**${n}. Market story ${n}**\n1. Title\n2. Why it matters\n3. Assets: SPX`);
  const { stories } = splitStories(text);
  assert.deepEqual(stories.map((s) => s.title), ["Market story 1", "Market story 2", "Market story 3"]);
  assert.match(stories[0].body, /2\. Why it matters/);
});

test("plain, heading and keycap numbering all work; more than ten is cut to ten", () => {
  assert.equal(splitStories(numbered(12, (n) => `${n}) Plain ${n}\nbody`)).stories.length, 10);
  assert.equal(splitStories(numbered(4, (n) => `### ${n}. Heading ${n}`)).stories[3].title, "Heading 4");
  const keycaps = ["1️⃣", "2️⃣", "3️⃣"].map((cap, i) => `${cap} Token ${i + 1}`).join("\n");
  assert.deepEqual(splitStories(keycaps).stories.map((s) => s.number), [1, 2, 3]);
});

test("text without usable numbering is left whole", () => {
  assert.deepEqual(splitStories("Just a paragraph.\nAnother one."), { intro: "", stories: [] });
  assert.deepEqual(splitStories("1. Only one story"), { intro: "", stories: [] });
});

test("the day's phone run comes first, the Reporter Room run is the backup, other days are left out", () => {
  const store = newStore();
  const tz = "America/Vancouver";
  // Both still the 14th in Vancouver, whether BC is on UTC-8 or permanent UTC-7.
  store.receive("economics", { text: numbered(10, (n) => `${n}. Econ ${n}`) }, new Date("2026-11-14T16:00:00Z"));
  store.receive("crypto", { text: numbered(10, (n) => `${n}. Old ${n}`) }, new Date("2026-11-13T16:00:00Z"));
  store.receive("crypto", { text: numbered(10, (n) => `${n}. Late ${n}`) }, new Date("2026-11-15T06:30:00Z"));
  const reporterService = {
    listGenerations: () => [
      { section: "markets", content: numbered(10, (n) => `**#${n} Stock ${n}**`), generatedAt: "2026-11-14T18:00:00.000Z", model: "m" },
      { section: "economics", content: numbered(10, (n) => `**#${n} Backup ${n}**`), generatedAt: "2026-11-14T17:00:00.000Z" },
      { section: "geopolitics", content: "1. a\n2. b", generatedAt: "2026-11-14T17:00:00.000Z" },
    ],
  };

  const day = buildDailyTopNews({ briefingStore: store, reporterService, date: "2026-11-14", timeZone: tz, now: new Date("2026-11-15T20:00:00Z") });
  assert.equal(day.date, "2026-11-14");
  assert.equal(day.today, "2026-11-15");
  assert.deepEqual(day.desks.map((d) => d.key), ["economics", "stocks", "crypto"]);

  assert.equal(day.top10.length, 10, "one combined ten, not thirty");
  assert.ok(day.top10.every((story) => story.desk !== "geopolitics"));
  const [economics, stocks, crypto] = day.desks;
  assert.deepEqual(economics.runs.map((r) => r.source), ["phone", "reporter"]);
  assert.equal(economics.runs[0].stories[0].title, "Econ 1");
  assert.equal(stocks.runs.length, 1);
  assert.equal(stocks.runs[0].source, "reporter");
  assert.equal(stocks.runs[0].stories[9].title, "Stock 10");
  assert.equal(crypto.runs.length, 1, "the 13th's crypto run is another day");
  assert.equal(crypto.runs[0].stories[0].title, "Late 1");
});

test("a bad date or time zone falls back to today in Vancouver", () => {
  const now = new Date("2026-11-15T05:00:00Z"); // still the 14th in Vancouver
  const day = buildDailyTopNews({ briefingStore: newStore(), date: "2026-02-30", timeZone: "Not/AZone", now });
  assert.equal(day.timeZone, "America/Vancouver");
  assert.equal(day.date, "2026-11-14");
  assert.equal(localDateKey(now, "UTC"), "2026-11-15");
  assert.ok(day.desks.every((d) => d.runs.length === 0));
});

test("the page and its API sit behind the site login", async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/briefings/top-10`, { redirect: "manual" });
    assert.equal(page.status, 302);
    const api = await fetch(`${base}/api/daily-top-news`, { redirect: "manual", headers: { Accept: "application/json" } });
    assert.ok([302, 401].includes(api.status), `expected login, got ${api.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Run News writes the three desks through the Reporter Room, crypto as news", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public/top-news.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/top-news.js"), "utf8");
  assert.match(page, /id="topNewsRun"[^>]*>⚡ Run News</);
  assert.match(page, /admin-key\.js/, "Run News needs the admin key helper");
  assert.match(script, /\/api\/daily-report\/generate\?section=/);
  for (const section of ["economics", "markets", "crypto"]) {
    assert.match(script, new RegExp(`section: "${section}"`));
  }
  assert.doesNotMatch(script, /section: "geopolitics"/);
  assert.match(script, /window\.DeskPrompts\.crypto/, "crypto uses the shared crypto-news prompt");
  assert.doesNotMatch(script, /\/broadcast/, "Run News never broadcasts");
});
