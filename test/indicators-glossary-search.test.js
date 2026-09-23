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
