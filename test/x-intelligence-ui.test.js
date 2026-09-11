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

test("the account selector count uses theme accounts rather than post volume", () => {
  const js = read("public/assets/js/x-intelligence.js");

  assert.match(js, /function visibleAccountCount\(\)/);
  assert.match(js, /accountsOf\(state\.feedData\)\.length/);
  assert.doesNotMatch(js, /visiblePostCount/);
});

test("the account panel is opened against the theme selected on the page", () => {
  const js = read("public/assets/js/x-intelligence.js");

  // The regression this guards: the panel was opened with no template, so it
  // edited the global tracked list blind and the server put every add into the
  // default theme — whichever filter was on screen.
  const openAt = js.indexOf("window.XAccountsAdmin.open({");
  assert.ok(openAt > 0, "the page is what opens the panel");
  const call = js.slice(openAt, openAt + 200);
  assert.match(call, /template: activeTemplate\(\)/);
});

test("the panel sends the theme with an add, and can edit one membership at a time", () => {
  const js = read("public/assets/js/x-accounts-admin.js");

  // The account add names the theme, so the server writes the membership there
  // rather than into the default template.
  assert.match(js, /template: template \? template\.id : undefined/);

  // And membership-only edits go to the per-theme endpoints, so pulling an
  // account into a theme or dropping it from one neither re-adds the account
  // nor rewrites the whole template.
  assert.match(js, /"\/api\/x\/templates\/" \+ encodeURIComponent\(template\.id\) \+ "\/accounts"/);
  assert.match(js, /method: "DELETE"/);
});

test("removing from a theme and untracking an account are distinct actions", () => {
  const js = read("public/assets/js/x-accounts-admin.js");

  // Two verbs with different blast radius. Collapsing them would make tidying
  // one theme delete the account out of every other theme that uses it.
  assert.match(js, /function removeMember\(/);
  assert.match(js, /function removeAccount\(/);
  assert.match(js, /removeFromThemeMessage/);
  assert.match(js, /confirmationMessage/);
});
