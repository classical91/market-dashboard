"use strict";

// The Intelligence Portal's category sync: X templates and YouTube categories
// paired into one dropdown, and the page wired to both live registries.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { mergeCategories, pickEntry, normalizedName, destinationHref } = require("../public/assets/js/intelligence-portal-sync");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const xTemplates = [
  { id: "markets", name: "Crypto & Stocks", handles: new Array(24).fill("h"), description: "Crypto, stocks" },
  { id: "war", name: "War", handles: new Array(21).fill("h") },
  { id: "conspiracy", name: "Conspiracy", handles: new Array(29).fill("h") },
  { id: "positivity", name: "Positivity", handles: new Array(10).fill("h") },
  { id: "love", name: "Love", handles: [] },
];
const ytCategories = [
  { id: "category:tech", name: "Tech", channelCount: 21 },
  { id: "category:crypto", name: "Crypto", channelCount: 16 },
  { id: "category:war", name: "War", channelCount: 11 },
  { id: "category:mentors", name: "Mentors", channelCount: 5 },
  { id: "category:underworld", name: "Underworld", channelCount: 36 },
  { id: "category:sales", name: "Sales", channelCount: 2 },
];

test("same-named categories pair exactly, with counts from each side", () => {
  const entries = mergeCategories(xTemplates, ytCategories);
  const war = entries.find((entry) => entry.name === "War");
  assert.equal(war.match, "exact");
  assert.deepEqual([war.x.id, war.x.count, war.youtube.id, war.youtube.count], ["war", 21, "category:war", 11]);
  assert.equal(war.key, "x:war|yt:category:war");
});

test("an unambiguous word match pairs Crypto with Crypto & Stocks", () => {
  const entries = mergeCategories(xTemplates, ytCategories);
  const crypto = entries.find((entry) => entry.x && entry.x.id === "markets");
  assert.equal(crypto.match, "partial");
  assert.equal(crypto.youtube.id, "category:crypto");
  assert.equal(crypto.name, "Crypto");
});

test("every category from both sides is listed exactly once", () => {
  const entries = mergeCategories(xTemplates, ytCategories);
  const xIds = entries.filter((e) => e.x).map((e) => e.x.id);
  const ytIds = entries.filter((e) => e.youtube).map((e) => e.youtube.id);
  assert.deepEqual(xIds, xTemplates.map((t) => t.id));
  assert.deepEqual(ytIds.slice().sort(), ytCategories.map((c) => c.id).sort());
  // X order first, YouTube-only after in YouTube order.
  assert.deepEqual(
    entries.map((e) => e.name),
    ["Crypto", "War", "Conspiracy", "Positivity", "Love", "Tech", "Mentors", "Underworld", "Sales"],
  );
  assert.equal(entries.find((e) => e.name === "Underworld").x, null);
  assert.equal(entries.find((e) => e.name === "Love").youtube, null);
});

test("an ambiguous partial match is left unpaired rather than guessed", () => {
  const entries = mergeCategories(
    [{ id: "a", name: "Tech News", handles: [] }, { id: "b", name: "Tech Stack", handles: [] }],
    [{ id: "category:tech", name: "Tech", channelCount: 3 }],
  );
  assert.ok(entries.every((entry) => entry.match === "single"));
  assert.equal(entries.length, 3);
});

test("exact matches win over partial ones and names normalize", () => {
  assert.equal(normalizedName("Crypto & Stocks"), normalizedName("crypto and  stocks"));
  const entries = mergeCategories(
    [{ id: "cs", name: "Crypto and Stocks", handles: [] }, { id: "c", name: "Crypto", handles: [] }],
    [{ id: "category:crypto", name: "crypto", channelCount: 1 }, { id: "category:cs", name: "Crypto & Stocks", channelCount: 1 }],
  );
  assert.equal(entries.find((e) => e.x.id === "c").youtube.id, "category:crypto");
  assert.equal(entries.find((e) => e.x.id === "cs").youtube.id, "category:cs");
});

test("selection prefers the URL, then the remembered key, then a synced entry", () => {
  const entries = mergeCategories(xTemplates, ytCategories);
  assert.equal(pickEntry(entries, { x: "love", key: "x:war|yt:category:war" }).x.id, "love");
  assert.equal(pickEntry(entries, { youtube: "category:sales" }).youtube.id, "category:sales");
  assert.equal(pickEntry(entries, { key: "x:war|yt:category:war" }).name, "War");
  assert.equal(pickEntry(entries, { key: "gone" }).key, entries[0].key);
  assert.equal(pickEntry([], {}), null);
  assert.deepEqual(mergeCategories(null, undefined), []);
});

test("each destination opens its page on the paired category, or not at all", () => {
  const entries = mergeCategories(xTemplates, ytCategories);
  const war = entries.find((entry) => entry.name === "War");
  assert.equal(destinationHref(war, "x"), "/x-intelligence.html?template=war");
  assert.equal(destinationHref(war, "youtube"), "/youtube-v2.html?category=category%3Awar");
  const underworld = entries.find((entry) => entry.name === "Underworld");
  assert.equal(destinationHref(underworld, "x"), null);
  assert.equal(destinationHref(underworld, "youtube"), "/youtube-v2.html?category=category%3Aunderworld");
  assert.equal(destinationHref(null, "x"), null);
  assert.equal(destinationHref(war, "elsewhere"), null);
});

test("the portal holds two launchers, each with its own dropdown and no feeds", () => {
  const html = read("public/intelligence-portal.html");
  const js = read("public/assets/js/intelligence-portal.js");
  assert.match(html, /<form class="ip-portal ip-portal--x" id="x" data-portal="x"/);
  assert.match(html, /<form class="ip-portal ip-portal--youtube" id="youtube" data-portal="youtube"/);
  assert.match(html, /<select id="ipXCategory"/);
  assert.match(html, /<select id="ipYoutubeCategory"/);
  assert.equal(html.match(/class="ip-go"/g).length, 2);
  assert.ok(html.indexOf("intelligence-portal-sync.js") < html.indexOf("intelligence-portal.js\""));
  // Each portal reads only its own registry; neither loads posts or videos.
  assert.match(js, /url: "\/api\/x\/templates"/);
  assert.match(js, /url: "\/api\/youtube\/channels\/config"/);
  assert.doesNotMatch(js, /\/api\/x\/accounts/);
  assert.doesNotMatch(js, /\/api\/youtube\/channels\?/);
  assert.doesNotMatch(html, /x-posts\.js|iframe/);
  assert.match(js, /window\.location\.assign\(hrefFor\(kind/);
  assert.match(js, /addEventListener\("hashchange"/);
});

test("YouTube Intelligence opens on the category a ?category= link names", () => {
  const js = read("public/assets/js/youtube-v2.js");
  assert.match(js, /searchParams\.get\("category"\)/);
});
