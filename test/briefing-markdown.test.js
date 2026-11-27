"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/assets/js/briefing-markdown.js"), "utf8"), context);
const { renderMarkdown } = context.window.BriefingMarkdown;

test("pipe tables render with a header row", () => {
  const html = renderMarkdown("| Metric | Value |\n|---|---|\n| RSI | 28 |\n| **Bias** | Bearish |");
  assert.match(html, /<thead><tr><th>Metric<\/th><th>Value<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>RSI<\/td><td>28<\/td>/);
  assert.match(html, /<td><strong>Bias<\/strong><\/td>/);
  assert.doesNotMatch(html, /<p>\|/);
});

test("ChatGPT citation markers are removed", () => {
  const html = renderMarkdown("Price ~$60,700\n\nciteturn683609search10turn683609search11\n\nciteturn1search2Done");
  assert.doesNotMatch(html, /cite|turn\d/);
  assert.match(html, /<p>Done<\/p>/);
});

test("a ChatGPT price card becomes a quote, one key/value table and a sparkline", () => {
  const card = [
    "Bitcoin (BTC)", "", "$60,661.00", "", "Open", "", "+$150.00 (0.25%)", "",
    "|  |  |", "| --- | --- |", "| Open | - |", "| Volume | - |", "",
    "|  |  |", "| --- | --- |", "| Day Low | 59,994 |", "| EPS (TTM) | - |", "",
    "|  |  |", "| --- | --- |", "| Day High | 61,022 |", "",
    "1D", "", "|  |  |", "| --- | --- |",
    "| 12:00 AM | $60,592.00 |", "| 12:05 AM | $60,530.00 |", "| 12:10 AM | $60,458.00 |", "| 1:00 AM | $60,661.00 |", "",
    "# 11/100", "", "Extreme fear", "", "Extreme fear Extreme greed", "",
    "Key price levels — schematic, not to scale.",
  ].join("\n");
  const html = renderMarkdown(card);
  assert.match(html, /briefing-quote-price">\$60,661\.00</);
  assert.match(html, /briefing-quote-change up">\+\$150\.00 \(0\.25%\)</);
  assert.match(html, /briefing-quote-status">Open</);
  assert.equal((html.match(/<table/g) || []).length, 1, "key/value tables merge and the price series is not a table");
  assert.match(html, /<td>Day Low<\/td><td>59,994<\/td>/);
  assert.match(html, /<td>Day High<\/td><td>61,022<\/td>/);
  assert.doesNotMatch(html, /Volume|EPS|<td>-<\/td>/);
  assert.match(html, /briefing-spark up/);
  assert.match(html, /1D · 12:00 AM \$60,592\.00 → 1:00 AM \$60,661\.00/);
  assert.doesNotMatch(html, /<p>1D<\/p>|Extreme fear Extreme greed|schematic/);
  assert.match(html, /<p>Extreme fear<\/p>/);
});

test("plain briefings render as before", () => {
  assert.equal(
    renderMarkdown("1. Story\n- point\n**bold**"),
    '<p class="briefing-story"><span class="briefing-rank">1</span>Story</p><ul><li>point</li></ul><p><strong>bold</strong></p>',
  );
});
