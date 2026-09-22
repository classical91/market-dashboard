"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const overviewPage = read("public/index.html");
const overviewJs = read("public/assets/js/overview.js");
const heatmapsPage = read("public/heatmaps.html");
const heatmapsJs = read("public/assets/js/heatmaps.js");

test("the heatmaps live on the Heatmaps page, not on Overview", () => {
  for (const marker of ['id="heatmap"', 'id="market-heatmap"', 'id="ovh-heatmap"', "embed-widget-crypto-coins-heatmap.js", "LiquidationHeatMap"]) {
    assert.ok(!overviewPage.includes(marker), `${marker} should no longer be on Overview`);
  }
  assert.doesNotMatch(overviewJs, /renderHeatmap|els\.heatmap/);

  for (const id of ["market-heatmap", "crypto-heatmap", "stock-heatmap", "forex-heatmap"]) {
    assert.ok(heatmapsPage.includes(`id="${id}"`), `${id} must be on the Heatmaps page`);
  }
  assert.match(heatmapsPage, /embed-widget-crypto-coins-heatmap\.js/);
  assert.match(heatmapsPage, /embed-widget-stock-heatmap\.js/);
  assert.match(heatmapsPage, /embed-widget-forex-heat-map\.js/);
  assert.match(heatmapsPage, /LiquidationHeatMap/);
  assert.match(heatmapsPage, /src="\/assets\/js\/heatmaps\.js"/);
  assert.match(heatmapsJs, /fetch\("\/api\/overview/);
  assert.match(heatmapsJs, /function renderHeatmap/);
});

test("Overview no longer carries its own Watchlist; Terminal Suite still reads the feed", () => {
  assert.ok(!overviewPage.includes('id="watchlist"'), "the Watchlist card left Overview");
  assert.ok(!overviewPage.includes('id="watchlistBody"'));
  assert.doesNotMatch(overviewJs, /renderWatchlist|els\.watchlistBody/);
  assert.doesNotMatch(read("public/assets/js/sidebar.js"), /href: "\/#watchlist"/);
  // The payload field stays: Cross-Asset · I on the Terminal Suite uses it.
  assert.match(read("public/assets/js/terminal-suite.js"), /data\.watchlist/);
});
