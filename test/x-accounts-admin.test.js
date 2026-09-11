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
  sections: ["Deep State", "Medical"],
  memberships: [{ handle: "VigilantFox", section: "Medical" }],
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
  assert.equal(accountsAdmin.isMember({ memberships: [] }, "VigilantFox"), false);
  assert.equal(accountsAdmin.findMembership(CONSPIRACY, "@vigilantfox").section, "Medical");
});

test("the theme scope lists membership order and the section, not the global category", () => {
  const tracked = [
    { handle: "Barchart", label: "Barchart", category: "Market Data" },
    { handle: "VigilantFox", label: "The Vigilant Fox", category: "Medical" },
    { handle: "dom_lucre", label: "Dom Lucre", category: "Epstein & Elites" },
  ];
  const template = {
    id: "conspiracy",
    name: "Conspiracy",
    sections: ["Deep State", "Medical"],
    memberships: [
      { handle: "dom_lucre", section: "Deep State" },
      { handle: "VigilantFox", section: "Medical" },
    ],
  };

  const rows = accountsAdmin.accountsInTemplate(tracked, template);
  assert.deepEqual(rows.map((row) => row.handle), ["dom_lucre", "VigilantFox"]);
  // The sidebar groups by section, so the panel must show the section rather
  // than the account's global category — here they disagree on purpose.
  assert.equal(rows[0].category, "Deep State");
  assert.equal(rows[0].label, "Dom Lucre");
  assert.equal(
    rows.some((row) => row.handle === "Barchart"),
    false,
    "an account this theme does not hold is not in its scope",
  );
});

test("a membership pointing at an untracked account is dropped, not shown as a dead row", () => {
  const rows = accountsAdmin.accountsInTemplate(TRACKED, {
    name: "Conspiracy",
    memberships: [
      { handle: "Barchart", section: "Deep State" },
      { handle: "DeletedAccount", section: "Deep State" },
    ],
  });

  // Matches resolveAccounts on the server: a row whose feed can never fill
  // would read as a broken account rather than a stale membership.
  assert.deepEqual(rows.map((row) => row.handle), ["Barchart"]);
});

test("the section box offers the theme's own sections before the global categories", () => {
  const options = accountsAdmin.sectionOptions(CONSPIRACY, ["Market Data", "medical"]);

  // The account is joining this theme, so its sections are the drop targets
  // that exist. "medical" is dropped as a case variant of a section already
  // offered rather than listed twice.
  assert.deepEqual(options, ["Deep State", "Medical", "Market Data"]);
  assert.deepEqual(accountsAdmin.sectionOptions(null, ["Market Data"]), ["Market Data"]);
  assert.deepEqual(accountsAdmin.sectionOptions({ sections: [] }, []), []);
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

test("an account already in this theme is reported against the theme, with its section", () => {
  const message = accountsAdmin.alreadyInThemeMessage(
    { handle: "VigilantFox", category: "Medical" },
    CONSPIRACY,
  );

  assert.match(message, /already in Conspiracy/);
  assert.match(message, /under Medical/);
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
