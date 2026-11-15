"use strict";

// YouTube Intelligence sections (Live Now, Upcoming, Latest Uploads) are
// always open: they keep the shared section-header look but are plain
// headings, not dropdowns, so `sections.js` must not bind to them.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const SECTIONS = ["yt-live", "yt-upcoming", "yt-rss"];

test("every section panel is present", () => {
  const html = read("public/youtube-v2.html");

  for (const id of SECTIONS) {
    assert.match(html, new RegExp(`<div class="yt-section-panel" id="${id}">`));
  }
});

test("section headings are static, not collapsible", () => {
  const html = read("public/youtube-v2.html");

  assert.doesNotMatch(html, /data-section=/);
  assert.doesNotMatch(html, /section-chevron/);
  assert.doesNotMatch(html, /initSections\(/);
  assert.doesNotMatch(html, /sections\.js/);
  assert.equal((html.match(/class="section-header yt-section-heading"/g) || []).length, SECTIONS.length);
});

test("panels carry no collapse styling", () => {
  const css = read("public/assets/styles/youtube-v2.css");

  assert.doesNotMatch(css, /\.yt-section-panel\.collapsed/);
  assert.match(css, /\.section-header\.yt-section-heading \{[^}]*cursor: default;/);
});
