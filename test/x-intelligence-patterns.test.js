"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const patterns = require("../public/assets/js/x-patterns");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

test("the existing four template identities select their own visual pattern", () => {
  const cases = [
    [{ id: "markets", name: "Crypto & Stocks" }, "markets"],
    [{ id: "war", name: "War" }, "war"],
    [{ id: "conspiracy", name: "Conspiracy" }, "conspiracy"],
    [{ id: "positivity", name: "Positivity" }, "positivity"],
  ];
  for (const [template, expected] of cases) {
    assert.equal(patterns.patternForTemplate(template), expected);
  }
});

test("admin-created templates with those names get a matching skin", () => {
  assert.equal(patterns.patternForTemplate({ id: "custom-1", name: " WAR " }), "war");
  assert.equal(patterns.patternForTemplate({ id: "custom-2", name: "positivity" }), "positivity");
  assert.equal(patterns.patternForTemplate({ id: "custom-3", name: "Crypto and Stocks" }), "markets");
});

test("other templates keep their old look and switching clears a previous skin", () => {
  const body = {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
  };
  assert.equal(patterns.apply(body, { id: "war" }), "war");
  assert.equal(body.attrs["data-x-pattern"], "war");
  assert.equal(patterns.apply(body, { id: "stack", name: "Tech Stack" }), null);
  assert.equal(body.attrs["data-x-pattern"], undefined);
  assert.equal(patterns.patternForTemplate(null), null);
});

test("X page loads the pattern skin and updates it on template selection", () => {
  const html = read("public/x-intelligence.html");
  const js = read("public/assets/js/x-intelligence.js");
  const css = read("public/assets/styles/x-patterns.css");
  assert.match(html, /assets\/styles\/x-patterns\.css/);
  assert.match(html, /assets\/js\/x-patterns\.js/);
  assert.ok(html.indexOf("x-patterns.js") < html.indexOf("x-intelligence.js"));
  assert.match(js, /XIntelligencePatterns\.apply\(document\.body, current\)/);
  for (const name of ["markets", "war", "conspiracy", "positivity"]) {
    assert.ok(css.includes('body[data-x-pattern="' + name + '"] .cmd-main'), name + " canvas is styled");
    assert.ok(css.includes('body[data-x-pattern="' + name + '"] {'), name + " pane is styled");
  }
  assert.match(css, /\.x-timeline-pane/);
});
