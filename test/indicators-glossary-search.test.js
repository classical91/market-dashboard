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

test("every glossary concept has its own page with a unique, known id", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const glossary = require("../public/assets/js/indicators.js");
  const ids = glossary.ALL_GLOSSARY.map((e) => e.id);
  assert.deepStrictEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "concept ids must be unique");
  for (const entry of glossary.ALL_GLOSSARY) {
    assert.ok(glossary.CATEGORY_ORDER.includes(entry.category), `${entry.id} has an unlisted category`);
  }
  assert.strictEqual(glossary.orderedEntries().length, glossary.ALL_GLOSSARY.length);
  assert.strictEqual(glossary.conceptHref({ id: "parabolic-sar" }), "/concept.html?id=parabolic-sar");

  const page = fs.readFileSync(path.join(__dirname, "..", "public/concept.html"), "utf8");
  assert.ok(page.indexOf("/assets/js/indicators.js") < page.indexOf("/assets/js/concept.js"), "concept.js needs the glossary data first");
  assert.match(fs.readFileSync(path.join(__dirname, "..", "public/assets/js/indicators.js"), "utf8"), /class="glossary-term" href="/);
});

test("glossary covers the Definitions Indicators list", () => {
  const { ALL_GLOSSARY } = require("../public/assets/js/indicators.js");
  const ids = new Set(ALL_GLOSSARY.map((e) => e.id));
  for (const id of [
    "fair-value-gap", "order-blocks", "liquidity", "liquidations", "rsi", "macd", "impulse-macd", "bollinger",
    "sma", "ema", "atr", "stochastic-oscillator", "parabolic-sar", "fibonacci-retracement", "ichimoku-cloud",
    "cumulative-volume-delta", "aggregated-cvd", "open-interest", "aggregated-open-interest", "crvol", "volume-delta",
    "aggregated-liquidations", "previous-day-high", "previous-day-low", "previous-week-high", "previous-month-high",
    "social-media-sentiment", "on-chain-metrics", "position-sizing", "diversification", "risk-reward-ratio",
    "project-fundamentals", "regulatory-news",
  ]) {
    assert.ok(ids.has(id), `missing concept ${id}`);
  }
});

test("library reading list is merged into the glossary under Library categories", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const library = require("../public/assets/js/glossary-library.js");
  const glossary = require("../public/assets/js/indicators.js");
  const ids = new Set(glossary.ALL_GLOSSARY.map((e) => e.id));

  assert.ok(library.entries.length > 150);
  for (const entry of library.entries) {
    assert.ok(ids.has(entry.id), `${entry.id} missing from glossary`);
    assert.ok(entry.category.startsWith("Library · "), `${entry.id} is outside a Library category`);
    assert.ok(entry.term && entry.def && entry.read, `${entry.id} is incomplete`);
  }
  for (const category of library.categories) assert.ok(glossary.CATEGORY_ORDER.includes(category));

  // Duplicates in the source list are merged into one page each.
  for (const id of ["book-tanakh", "book-attached", "book-intention-experiment", "book-supernatural", "book-divine-matrix"]) {
    assert.strictEqual(library.entries.filter((e) => e.id === id).length, 1);
  }

  for (const page of ["public/indicators.html", "public/concept.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", page), "utf8");
    assert.ok(html.indexOf("/assets/js/glossary-library.js") < html.indexOf("/assets/js/indicators.js"), `${page} must load the library first`);
  }
});
