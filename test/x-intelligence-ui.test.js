"use strict";

// The X Intelligence page layout, asserted where it is easy to break by
// accident. The property that matters here is reachability on a phone: the
// account list collapses on mobile, so anything that must stay usable while it
// is folded away cannot live inside it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Manage Accounts sits outside the account list, which mobile collapses", () => {
  const html = read("public/x-intelligence.html");
  const css = read("public/assets/styles/x-intelligence.css");
  const js = read("public/assets/js/x-intelligence.js");

  const manageAt = html.indexOf('id="xManageAccounts"');
  const listAt = html.indexOf('id="xAccountList"');
  const panelAt = html.indexOf('id="xAccountPanel"');
  assert.ok(manageAt > 0, "the button is in the markup, not built by the list render");
  assert.ok(panelAt > 0 && panelAt < manageAt, "it belongs to the account panel");
  assert.ok(
    manageAt < listAt,
    "it must precede the collapsible list rather than live inside it — the list " +
      "is display:none whenever the panel is collapsed, which on mobile is the " +
      "default state",
  );

  // The collapse rule is the reason for the placement above: it hides the
  // list, so anything inside the list goes with it.
  assert.match(css, /\.x-account-panel\.is-collapsed \.x-account-list \{ display: none; \}/);

  // And the render that fills the list must not put it back.
  assert.doesNotMatch(js, /manage\.className = "x-account-manage"/);
  assert.match(js, /getElementById\("xManageAccounts"\)/);
});

test("the account panel starts collapsed on mobile and opens from its toggle", () => {
  const html = read("public/x-intelligence.html");

  assert.match(html, /class="x-account-panel is-collapsed"/);
  assert.match(html, /id="xAccountToggle"[\s\S]*?aria-controls="xAccountList"/);
});
