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

test("each skin animates its own ambient layers, behind the content", () => {
  const html = read("public/x-intelligence.html");
  const css = read("public/assets/styles/x-patterns.css");
  assert.match(html, /<div class="x-ambient" aria-hidden="true">/);
  assert.ok(html.indexOf('class="x-ambient"') < html.indexOf('class="cmd-page-header"'));

  const ambient = css.match(/body\[data-x-pattern\] \.x-ambient \{[^}]*\}/s)[0];
  assert.match(ambient, /position: fixed;/);
  assert.match(ambient, /z-index: -1;/);
  assert.match(ambient, /pointer-events: none;/);

  for (const name of ["markets", "war", "conspiracy", "positivity"]) {
    const rules = css.match(new RegExp('body\\[data-x-pattern="' + name + '"\\] \\.x-ambient-[abc][^{]*\\{[^}]*\\}', "g")) || [];
    assert.ok(rules.some((rule) => /animation: x-amb-/.test(rule)), name + " has an animated layer");
  }
  // Templates without a skin keep their old look: no ambient layer at all.
  assert.match(css, /^\.x-ambient \{ display: none; \}/m);
});

test("ambient motion is transform and opacity only, from inline sources", () => {
  const css = read("public/assets/styles/x-patterns.css");
  // The keyframes close the file, so each one runs to the next.
  const keyframes = css.split("@keyframes ").slice(1).map((block) => "@keyframes " + block);
  assert.ok(keyframes.length >= 6);
  assert.ok(keyframes.every((block) => block.startsWith("@keyframes x-amb-")));
  for (const block of keyframes) {
    const props = [...block.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    for (const prop of props) assert.ok(["opacity", "transform"].includes(prop), block.split("{")[0] + " animates " + prop);
  }
  assert.doesNotMatch(css, /url\((?!"data:)/, "no network-fetched backgrounds");
});

test("motion can be switched off and respects reduced motion", () => {
  const css = read("public/assets/styles/x-patterns.css");
  const js = read("public/assets/js/x-intelligence.js");
  assert.match(css, /body\[data-x-motion="off"\] \.x-ambient-layer \{ animation: none !important; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*body:not\(\[data-x-motion="on"\]\) \.x-ambient-layer \{ animation: none !important; \}/);
  assert.match(css, /body\[data-x-motion-paused\] \.x-ambient-layer/);
  assert.match(js, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(js, /document\.body\.setAttribute\("data-x-motion", motion\)/);
  assert.match(js, /visibilitychange/);
});
