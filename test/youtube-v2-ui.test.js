"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const SECTIONS = [
  ["yt-live", "ytLiveHeading", "ytLiveFeeds", "Live Now"],
  ["yt-upcoming", "ytUpcomingHeading", "ytUpcomingFeeds", "Upcoming"],
  ["yt-rss", "ytUploadsHeading", "ytChannelFeeds", "Latest Uploads"],
];

test("video sections have static headings and working jump links", () => {
  const html = read("public/youtube-v2.html");

  for (const [id, heading, feed, label] of SECTIONS) {
    assert.match(html, new RegExp(`<a href="#${id}">`));
    const section = html.match(new RegExp(`<section[^>]* id="${id}" aria-labelledby="${heading}">([\\s\\S]*?)</section>`));
    assert.ok(section, `Missing section ${id}`);
    assert.match(section[1], new RegExp(`<h2 id="${heading}">.*${label}</h2>`));
    assert.match(section[1], new RegExp(`id="${feed}"`));
  }
});

test("the video sections have no collapse binding or styles", () => {
  const html = read("public/youtube-v2.html");
  const css = read("public/assets/styles/youtube-v2.css");

  assert.doesNotMatch(html, /data-section=|section-chevron|initSections\(|sections\.js/);
  assert.doesNotMatch(css, /\.collapsed/);
});
