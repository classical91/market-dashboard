"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const pages = [
  ["public/ai-analysis.html", 'id="aia-log"'],
  ["public/layout-analysis.html", 'id="aia-log"'],
  ["public/trading-lab.html", 'id="tl-history-tbody"'],
  ["public/signal-diagnostics.html", 'id="sd-legacy-books"'],
  ["public/pattern-scanner.html", 'class="ps-beta-section"'],
  ["public/pattern-scanner-trades.html", 'id="ps-grid"'],
  ["public/pattern-scanner-stats.html", 'id="ts-recent"'],
  ["public/signal-screener.html", 'id="ss-tbody-flat"'],
];

test("AI Analysis and TradeHunter pages explain themselves at the bottom", () => {
  for (const [file, finalContentMarker] of pages) {
    const html = read(file);
    const explainer = html.indexOf("How this page works");
    const footer = html.indexOf("<footer>");

    assert.ok(explainer > html.indexOf(finalContentMarker), `${file} explainer must follow its working content`);
    assert.equal(html.match(/How this page works/g)?.length, 1, `${file} must have one explainer`);
    if (footer > -1) assert.ok(explainer < footer, `${file} explainer must sit immediately above the footer area`);
  }
});

test("every local page states whether AI performs its analysis", () => {
  const aiPages = new Set(["public/ai-analysis.html", "public/layout-analysis.html"]);

  for (const [file] of pages) {
    const html = read(file);
    assert.match(html, /<strong>AI use: (Yes|No)\.<\/strong>/, `${file} must disclose AI use`);
    assert.match(
      html,
      new RegExp(`<strong>AI use: ${aiPages.has(file) ? "Yes" : "No"}\\.<\\/strong>`),
      `${file} has the wrong AI-use disclosure`,
    );
  }
});
