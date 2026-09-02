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
