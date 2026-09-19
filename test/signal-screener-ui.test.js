"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "..", "public", "signal-screener.html"), "utf8");

test("Signal Screener exposes directional and local-extreme engines as separate views", () => {
  assert.match(page, /role="tab"[^>]+ss-tab-signals/);
  assert.match(page, /role="tab"[^>]+ss-tab-extremes/);
  assert.match(page, /id="ss-view-signals"/);
  assert.match(page, /id="ss-view-extremes"/);
});

test("Local Extremes keeps bottom and top scores independent and explains confirmation", () => {
  assert.match(page, /<th>Bottom<\/th><th>Top<\/th>/);
  assert.match(page, /A high bottom score can coexist with a strong SHORT signal/);
  assert.match(page, /A candidate has exhaustion evidence/);
  assert.doesNotMatch(page, /combined extreme score/i);
});
