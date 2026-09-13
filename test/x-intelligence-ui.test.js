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

test("the account sidebar is a flat list in template order, with no section headings", () => {
  const js = read("public/assets/js/x-intelligence.js");
  const css = read("public/assets/styles/x-intelligence.css");

  // Templates are the only filter now. The sidebar used to group accounts
  // under headings taken from each template's sections; nothing derives a
  // grouping any more, so neither the grouper nor its heading style remains.
  assert.doesNotMatch(js, /groupAccounts/);
  assert.doesNotMatch(js, /x-account-group-title/);
  assert.doesNotMatch(css, /\.x-account-group-title/);

  // The render walks accounts directly rather than groups of them.
  assert.match(js, /function renderList\(root, accounts,/);
  assert.match(js, /renderList\(listRoot, accountsOf\(state\.feedData\)/);
});

/* Source with comments removed. These guards are about what the code does,
   and "section" and "membership" are still ordinary words to use in a comment
   explaining why they are gone. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("a template is a flat list of handles, with no sections anywhere in the X stack", () => {
  for (const file of [
    "public/assets/js/x-intelligence.js",
    "public/assets/js/x-templates-admin.js",
    "public/assets/js/x-accounts-admin.js",
    "src/services/x-template-registry.js",
    "src/config/x-themes.js",
  ]) {
    const source = codeOf(read(file));
    // Field access and object keys only — "membership" and "section" are still
    // fair words to use in a comment, and the registry still reads the old
    // `memberships` field to upgrade a file written before the change.
    const readsLegacyShape = file.endsWith("x-template-registry.js");
    if (!readsLegacyShape) {
      assert.doesNotMatch(source, /\.memberships\b/, file + " must not read memberships");
      assert.doesNotMatch(source, /\bmemberships:/, file + " must not write memberships");
    }
    assert.doesNotMatch(source, /\.sections\b/, file + " must not read sections");
    assert.doesNotMatch(source, /\bsections:/, file + " must not write sections");
    assert.doesNotMatch(source, /\bsection:/, file + " must not write a section");
  }
});

test("the switcher counts a theme by its handles", () => {
  const js = read("public/assets/js/x-intelligence.js");
  assert.match(js, /\(template\.handles \|\| \[\]\)\.length \+ " accounts"/);
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

test("the template editor offers every accent the stylesheet defines", () => {
  const css = read("public/assets/styles/x-intelligence.css");
  const templatesAdmin = require("../public/assets/js/x-templates-admin");

  const styled = [...new Set(
    [...css.matchAll(/data-x-accent="([a-z]+)"/g)].map((match) => match[1]),
  )].sort();

  // The select is the only way to set an accent, so an accent the stylesheet
  // supports but the list omits is both unreachable and lossy: the Conspiracy
  // theme opened showing "Market" and saving repainted it.
  assert.deepEqual(templatesAdmin.ACCENTS.slice().sort(), styled);
});

test("a post card cannot grow wider than the pane it sits in", () => {
  const css = read("public/assets/styles/x-intelligence.css");
  const command = read("public/assets/styles/command.css");

  // What broke: a grid item's automatic minimum size is its min-content
  // width, and the widest thing on a card is the permalink — an unbroken URL
  // with white-space: nowrap. On a phone that made the card wider than the
  // pane, and because command.css sets overflow-x: hidden on the body the
  // overhang was clipped rather than scrollable: every line of post text
  // ended mid-word at the screen edge with no way to reach the rest.
  assert.match(command, /body \{[^}]*overflow-x: hidden;/s, "the clipping this guards against");

  const grid = css.match(/\.x-post-grid \{[^}]*\}/s)[0];
  assert.match(
    grid,
    /minmax\(min\(260px, 100%\), 1fr\)/,
    "the track floor must collapse below 260px rather than force the container wider",
  );

  const card = css.match(/\.x-post-card \{[^}]*\}/s)[0];
  assert.match(card, /min-width: 0;/, "opts the card out of the min-content minimum");
  assert.match(card, /max-width: 100%;/);

  // And the two children with the widest intrinsic content stay breakable or
  // clamped, so neither can set the card's width on its own.
  const text = css.match(/\.x-post-text \{[^}]*\}/s)[0];
  assert.match(text, /overflow-wrap: anywhere;/, "bare t.co links must break");
  const image = css.match(/\.x-post-image \{[^}]*\}/s)[0];
  assert.match(image, /max-width: 100%;/);
});

test("iOS is not left to pick its own text sizes", () => {
  const command = read("public/assets/styles/command.css");

  // Safari on iOS inflates text in narrow blocks unless the adjustment is
  // pinned, which rendered the cards a size or two above what the layout was
  // measured against and was what pushed them past the viewport.
  const html = command.match(/html \{[^}]*\}/s)[0];
  assert.match(html, /-webkit-text-size-adjust: 100%;/);
  assert.match(html, /\btext-size-adjust: 100%;/);
});
