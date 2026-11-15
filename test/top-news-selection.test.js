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
  const sources = desks().slice(0,3);
  const context = {
    window: {
      location: { search: "?date=2026-11-13", href: "http://x/briefings/top-10?date=2026-11-13" },
      history: { replaceState() {} },
    },
    document: { getElementById(id) { return nodes[id] ||= {
      innerHTML: "", textContent: "", hidden: false, events: {},
      addEventListener(event, fn) { this.events[event] = fn; },
    }; } },
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    URL, URLSearchParams, Intl, setTimeout() {},
    fetch: async (url) => ({ ok: true, json: async () => url.includes("/farmbot") ? { configured: true } : {
      date: "2026-11-13", today: "2026-11-15", timeZone: "UTC", desks: sources,
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
});
