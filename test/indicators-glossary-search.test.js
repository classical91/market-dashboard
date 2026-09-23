"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { ALL_GLOSSARY, searchIndex, queryTokens, matchesQuery } = require("../public/assets/js/indicators.js");

function search(query) {
  const tokens = queryTokens(query);
  return ALL_GLOSSARY.filter((entry) => matchesQuery(searchIndex(entry), tokens)).map((entry) => entry.term);
}

test("glossary search matches natural phrasings of terms written with &", () => {
  assert.ok(search("head and shoulders").includes("Head & Shoulders (H&S)"));
  assert.ok(search("fear and greed").includes("Fear & Greed Index"));
  assert.ok(search("fear & greed").includes("Fear & Greed Index"));
  assert.ok(search("support resistance").includes("Support & Resistance"));
  assert.ok(search("h&s").includes("Head & Shoulders (H&S)"));
});

test("glossary search matches words in any order and ignores plurals", () => {
  assert.deepStrictEqual(search("divergence rsi"), search("rsi divergence"));
  assert.ok(search("stoch").includes("Stochastic Oscillator"));
  assert.ok(search("rsi divergence").includes("RSI (Relative Strength Index)"));
  assert.ok(search("moving averages").some((t) => /Moving Average/.test(t)));
});

test("glossary search matches whole-word prefixes, not fragments inside words", () => {
  const ema = search("ema");
  assert.ok(ema.length > 0);
  for (const term of ema) {
    const entry = ALL_GLOSSARY.find((e) => e.term === term);
    assert.match(searchIndex(entry), / ema/, `${term} should mention EMA as a word`);
  }
  assert.deepStrictEqual(search("zzzz"), []);
  assert.strictEqual(search("").length, ALL_GLOSSARY.length);
});

test("glossary toolbar cannot push the page wider than a phone screen", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "public/indicators.html"), "utf8");
  // The A–Z <select> sizes to its longest option unless it is allowed to shrink.
  assert.match(page, /\.glossary-jump \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(page, /minmax\(min\(300px, 100%\), 1fr\)/);
});

test("category list sits in a side panel, so results follow the search bar directly", () => {
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "public/indicators.html"), "utf8");
  const main = page.slice(page.indexOf('class="glossary-main"'), page.indexOf('class="glossary-side"'));
  assert.ok(main.includes('id="glossarySearch"') && main.includes('id="glossaryContent"'));
  assert.ok(!main.includes('id="glossaryPills"'), "category list must not sit between search and results");
  assert.match(page, /<aside class="glossary-side" id="glossarySide"[\s\S]*id="glossaryPills"/);
  assert.match(page, /id="glossarySideToggle"/);
});
