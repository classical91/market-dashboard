"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { select } = require("../public/assets/js/top-news-selection");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
function desks() {
  return ["economics", "stocks", "crypto", "geopolitics"].map((key) => ({ key, label: key, icon: "", runs: [{
    id: key + "-run", source: "phone", at: "2026-11-15T12:00:00Z",
    stories: Array.from({ length: 10 }, (_, index) => ({ number: index + 1, title: key + " news " + (index + 1), body: "Details" })),
  }] }));
}

test("30 market stories become ten total, ordered by source rank across desks, without geopolitics", () => {
  const stories = select(desks());
  assert.equal(stories.length, 10);
  assert.deepEqual(stories.slice(0, 6).map((s) => [s.desk, s.sourceRank]), [
    ["economics", 1], ["stocks", 1], ["crypto", 1], ["economics", 2], ["stocks", 2], ["crypto", 2],
  ]);
  assert.ok(stories.every((s) => s.desk !== "geopolitics"));
  assert.deepEqual(stories.map((s) => s.number), [1,2,3,4,5,6,7,8,9,10]);
});

test("duplicate headlines and article links are skipped and replaced by the next source stories", () => {
  const sources = desks();
  sources[1].runs[0].stories[0].title = "ECONOMICS: news 1!";
  sources[0].runs[0].stories[1].body = "https://example.com/article?utm_source=phone";
  sources[2].runs[0].stories[1].body = "[Source](https://example.com/article?utm_source=crypto)";
  const stories = select(sources);
  assert.equal(stories.length, 10);
  assert.ok(!stories.some((s) => s.desk === "stocks" && s.sourceRank === 1));
  assert.ok(!stories.some((s) => s.desk === "crypto" && s.sourceRank === 2));
});

test("missing desks, fewer than ten stories and selected historical runs work without padding", () => {
  const sources = desks().slice(0,1);
  sources[0].runs.push({ id: "older", source: "reporter", at: "2026-11-14T12:00:00Z", stories: [{ number: 1, title: "Older story", body: "" }] });
  assert.equal(select(sources, { economics: "older" }).length, 1);
  assert.equal(select(sources, { economics: "older" })[0].title, "Older story");
  assert.deepEqual(select([]), []);
});

test("the page renders and copies only the combined ten, including historical dates", async () => {
  const nodes = {};
  let copied = "";
  const writes = [];
  const sources = desks().slice(0,3);
  const context = {
    window: {
      location: { search: "?date=2026-11-13", href: "http://x/briefings/top-10?date=2026-11-13" },
      history: { replaceState() {} },
      AdminKey: { async fetch(url, options) {
        writes.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ logged: 10 }) };
      } },
    },
    document: { getElementById(id) { return nodes[id] ||= {
      innerHTML: "", textContent: "", hidden: false, events: {},
      addEventListener(event, fn) { this.events[event] = fn; },
    }; } },
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    URL, URLSearchParams, Intl, setTimeout() {},
    fetch: async (url) => ({ ok: true, json: async () => url.includes("/farmbot") ? { configured: true } : {
      date: "2026-11-13", today: "2026-11-15", timeZone: "UTC", desks: sources,
      top10Run: { id: "top10-1", createdAt: "2026-11-13T18:00:00Z", runIds: { economics: "economics-run", stocks: "stocks-run", crypto: "crypto-run" } },
    } }),
  };
  for (const name of ["briefing-markdown", "briefing-freshness", "top-news-selection", "top-news"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public/assets/js", name + ".js"), "utf8"), context);
  }
  await new Promise(setImmediate);
  const html = nodes.topNewsSections.innerHTML;
  assert.equal((html.match(/class="topnews-story"/g) || []).length, 10);
  assert.ok(!html.includes("economics news 5"));
  assert.equal(nodes.topNewsFarmbot.hidden, true);
  nodes.topNewsCopyAll.events.click();
  await new Promise(setImmediate);
  assert.equal((copied.match(/^\d+\. /gm) || []).length, 10);
  assert.ok(!copied.includes("economics news 5"));
  nodes.topNewsLog.events.click();
  await new Promise(setImmediate);
  assert.deepEqual(writes.map((entry) => entry.url), ["/api/daily-top-news/intake"]);
  assert.equal(writes[0].body.date, "2026-11-13");
  assert.deepEqual(writes[0].body.runs, { economics: "economics-run", stocks: "stocks-run", crypto: "crypto-run" });
  assert.match(nodes.topNewsRunMessage.textContent, /10 stories recorded/);
});

test("a day without a recorded Run shows no Top 10 and offers nothing to copy, log or send", async () => {
  const nodes = {};
  const context = {
    window: {
      location: { search: "", href: "http://x/briefings/top-10" },
      history: { replaceState() {} },
      AdminKey: { async fetch() { throw new Error("must not write"); } },
    },
    document: { getElementById(id) { return nodes[id] ||= {
      innerHTML: "", textContent: "", hidden: false, disabled: false, events: {},
      addEventListener(event, fn) { this.events[event] = fn; },
    }; } },
    navigator: {},
    URL, URLSearchParams, Intl, setTimeout() {},
    fetch: async (url) => ({ ok: true, json: async () => url.includes("/farmbot") ? { configured: true } : {
      date: "2026-11-15", today: "2026-11-15", timeZone: "UTC", desks: desks().slice(0, 3), top10Run: null,
    } }),
  };
  for (const name of ["briefing-markdown", "briefing-freshness", "top-news-selection", "top-news"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public/assets/js", name + ".js"), "utf8"), context);
  }
  await new Promise(setImmediate);
  assert.equal((nodes.topNewsSections.innerHTML.match(/class="topnews-story"/g) || []).length, 0);
  assert.match(nodes.topNewsSections.innerHTML, /No Top 10 yet\. Hit ⚡ Run News/);
  assert.equal(nodes.topNewsCopyAll.disabled, true);
  assert.equal(nodes.topNewsLog.disabled, true);
  assert.equal(nodes.topNewsFarmbot.disabled, true);
  assert.equal(nodes.topNewsRun.hidden, false);
});

test("Run News writes only the desks missing today, then records the Run", async () => {
  const nodes = {};
  const writes = [];
  let recorded = false;
  const sources = desks().slice(0, 3);
  sources[1].runs = [];
  sources[2].runs = [];
  const context = {
    window: {
      location: { search: "", href: "http://x/briefings/top-10" },
      history: { replaceState() {} },
      AdminKey: { async fetch(url) {
        writes.push(url);
        if (url === "/api/daily-top-news/run") recorded = true;
        return { ok: true, json: async () => (url.includes("/run") ? { run: { id: "top10-1" } } : { logged: 10 }) };
      } },
    },
    document: { getElementById(id) { return nodes[id] ||= {
      innerHTML: "", textContent: "", hidden: false, disabled: false, events: {},
      addEventListener(event, fn) { this.events[event] = fn; },
    }; } },
    navigator: {},
    URL, URLSearchParams, Intl, setTimeout() {},
    fetch: async (url) => ({ ok: true, json: async () => url.includes("/farmbot") ? { configured: true } : {
      date: "2026-11-15", today: "2026-11-15", timeZone: "UTC", desks: sources,
      top10Run: recorded ? { id: "top10-1", createdAt: "2026-11-15T18:00:00Z", runIds: {} } : null,
    } }),
  };
  for (const name of ["briefing-markdown", "briefing-freshness", "top-news-selection", "top-news"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public/assets/js", name + ".js"), "utf8"), context);
  }
  await new Promise(setImmediate);
  nodes.topNewsRun.events.click();
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
  assert.deepEqual(writes, [
    "/api/daily-report/generate?section=markets",
    "/api/daily-report/generate?section=crypto",
    "/api/daily-top-news/run",
    "/api/daily-top-news/intake",
  ]);
  assert.match(nodes.topNewsRunMessage.textContent, /Economics: already done today · Stocks: done · Crypto: done · Top 10 made\./);
});
