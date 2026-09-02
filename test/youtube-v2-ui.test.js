"use strict";

// YouTube Intelligence section collapsing. `sections.js` toggles a `collapsed`
// class on the panel each header controls, so a panel only actually folds if
// the page ships CSS for that class. These panels are plain wrappers rather
// than `.cards` lists, which is where the shared rule lives — without their
// own rule the chevron rotated while the content stayed on screen.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const SECTIONS = ["yt-live", "yt-upcoming", "yt-rss"];

test("every section header points at a panel that carries the collapse class", () => {
  const html = read("public/youtube-v2.html");

  for (const id of SECTIONS) {
    assert.match(
      html,
      new RegExp(`<div class="section-header" data-section="${id}">`),
      `${id} needs a header for sections.js to bind`,
    );
    assert.match(
      html,
      new RegExp(`<div class="yt-section-panel" id="${id}">`),
      `${id}'s panel must carry yt-section-panel, or nothing hides it`,
    );
  }
});

test("the panel class actually folds the panel away", () => {
  const css = read("public/assets/styles/youtube-v2.css");

  assert.match(css, /\.yt-section-panel \{[^}]*grid-template-rows: 1fr;/);
  assert.match(css, /\.yt-section-panel\.collapsed \{[^}]*grid-template-rows: 0fr;/);
  assert.match(css, /\.yt-section-panel\.collapsed \{[^}]*pointer-events: none;/);
  // overflow:hidden is what makes the 0fr row clip its content.
  assert.match(css, /\.yt-section-panel \{[^}]*overflow: hidden;/);
});

test("sections.js resolves each panel by its section id", () => {
  const js = read("public/assets/js/sections.js");

  assert.match(js, /document\.getElementById\(id\)/);
  assert.match(js, /cards\.classList\.toggle\("?'?collapsed'?"?\)/);
});
