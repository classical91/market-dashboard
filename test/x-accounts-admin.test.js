"use strict";

// The Manage Accounts panel's validation helpers. These are the fast, local
// half of the duplicate rule — the registry in src/services/x-account-registry.js
// is the half that actually guards the store — so the two must agree on what
// counts as the same account.

const test = require("node:test");
const assert = require("node:assert");

const accountsAdmin = require("../public/assets/js/x-accounts-admin");

const TRACKED = [
  { handle: "Barchart", label: "Barchart", category: "Market Data" },
  { handle: "TechDev_52", label: "TechDev", category: "Crypto Traders" },
];

test("a leading @ and stray whitespace are not part of the handle", () => {
  assert.equal(accountsAdmin.normalizeHandle("  @Barchart "), "Barchart");
  assert.equal(accountsAdmin.validateHandle(" @spaced ").handle, "spaced");
  assert.equal(accountsAdmin.validateHandle("has space").ok, false);
  assert.equal(accountsAdmin.validateHandle("toolonghandle1234").ok, false);
  assert.equal(accountsAdmin.validateHandle("").ok, false);
});

test("a handle already tracked is recognized however it is typed", () => {
  for (const typed of ["Barchart", "barchart", "@BARCHART", "  @BarChart  "]) {
    assert.equal(accountsAdmin.isDuplicate(TRACKED, typed), true, typed);
  }
  assert.equal(accountsAdmin.isDuplicate(TRACKED, "newhandle"), false);
  assert.equal(accountsAdmin.isDuplicate(TRACKED, ""), false, "an empty box is not a duplicate");
  assert.equal(accountsAdmin.isDuplicate([], "Barchart"), false);
});

test("the duplicate is reported as it is already stored, not as it was typed", () => {
  const existing = accountsAdmin.findDuplicate(TRACKED, "@BARCHART");
  assert.equal(existing.handle, "Barchart");
  assert.equal(
    accountsAdmin.duplicateMessage(existing),
    "@Barchart is already tracked under Market Data.",
  );
});

test("deleting an account says what else goes with it", () => {
  assert.match(accountsAdmin.confirmationMessage("Barchart"), /@Barchart/);
  assert.match(accountsAdmin.confirmationMessage("Barchart"), /cached feed data/);
});

// The panel is scoped to the theme selected on the page. "Tracked" and "in
// this theme" are different questions, and answering the first when asked the
// second is what let an account be added from the Conspiracy filter and land
// in Crypto & Stocks.

const CONSPIRACY = {
  id: "conspiracy",
  name: "Conspiracy",
  handles: ["VigilantFox"],
};

test("membership is a separate question from being tracked", () => {
  const tracked = TRACKED.concat({
    handle: "VigilantFox", label: "The Vigilant Fox", category: "Medical",
  });

  assert.equal(accountsAdmin.isDuplicate(tracked, "Barchart"), true, "tracked globally");
  assert.equal(accountsAdmin.isMember(CONSPIRACY, "Barchart"), false, "but not in this theme");
  assert.equal(accountsAdmin.isMember(CONSPIRACY, "VigilantFox"), true);
});

test("theme membership is matched however the handle is written", () => {
  for (const typed of ["VigilantFox", "vigilantfox", "@VIGILANTFOX", " @VigilantFox "]) {
    assert.equal(accountsAdmin.isMember(CONSPIRACY, typed), true, typed);
  }
  assert.equal(accountsAdmin.isMember(CONSPIRACY, ""), false, "an empty box is not a member");
  assert.equal(accountsAdmin.isMember({ handles: [] }, "VigilantFox"), false);
});

test("the theme scope lists the template's accounts in the order it lists them", () => {
  const tracked = [
    { handle: "Barchart", label: "Barchart", category: "Market Data" },
    { handle: "VigilantFox", label: "The Vigilant Fox", category: "Medical" },
    { handle: "dom_lucre", label: "Dom Lucre", category: "Epstein & Elites" },
  ];
  // Deliberately not the tracked-list order: the template's order is what the
  // page's sidebar renders, so it is what the panel must show.
  const template = { id: "conspiracy", name: "Conspiracy", handles: ["dom_lucre", "VigilantFox"] };

  const rows = accountsAdmin.accountsInTemplate(tracked, template);
  assert.deepEqual(rows.map((row) => row.handle), ["dom_lucre", "VigilantFox"]);
  assert.equal(rows[0].label, "Dom Lucre");
  assert.equal(rows[0].category, "Epstein & Elites", "the account's own category, as metadata");
  assert.equal(
    rows.some((row) => row.handle === "Barchart"),
    false,
    "an account this theme does not hold is not in its scope",
  );
});

test("a handle naming an untracked account is dropped, not shown as a dead row", () => {
  const rows = accountsAdmin.accountsInTemplate(TRACKED, {
    name: "Conspiracy",
    handles: ["Barchart", "DeletedAccount"],
  });

  // Matches resolveAccounts on the server: a row whose feed can never fill
  // would read as a broken account rather than a stale reference.
  assert.deepEqual(rows.map((row) => row.handle), ["Barchart"]);
});

test("a handle tracked but missing from this theme is told so, and pointed at the fix", () => {
  const existing = accountsAdmin.findDuplicate(TRACKED, "@BARCHART");
  const message = accountsAdmin.trackedElsewhereMessage(existing, CONSPIRACY);

  assert.match(message, /@Barchart/);
  assert.match(message, /already tracked/);
  assert.match(message, /not in Conspiracy/);
  // The dead end this replaces: "already tracked", full stop, when adding it
  // to the theme on screen was the whole intent.
  assert.match(message, /Add it to this theme/);
});

test("an account already in this theme is reported against the theme", () => {
  const message = accountsAdmin.alreadyInThemeMessage(
    { handle: "VigilantFox", category: "Medical" },
    CONSPIRACY,
  );

  assert.match(message, /already in Conspiracy/);
  // No section to name any more — a template is a flat list.
  assert.doesNotMatch(message, /under/);
});

test("the two removals are worded by blast radius, not interchangeably", () => {
  const fromTheme = accountsAdmin.removeFromThemeMessage("VigilantFox", CONSPIRACY);
  const everywhere = accountsAdmin.confirmationMessage("VigilantFox");

  assert.match(fromTheme, /from Conspiracy/);
  assert.match(fromTheme, /stays tracked/);
  assert.doesNotMatch(fromTheme, /cached feed data/);

  assert.match(everywhere, /from X Intelligence/);
  assert.match(everywhere, /cached feed data/);
  assert.notEqual(fromTheme, everywhere);
});
