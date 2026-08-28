"use strict";

const test = require("node:test");
const assert = require("node:assert");

const templatesAdmin = require("../public/assets/js/x-templates-admin");

test("template ids are bookmark-safe slugs", () => {
  assert.equal(templatesAdmin.slugify(" Wars & Geopolitics "), "wars-geopolitics");
  assert.equal(templatesAdmin.slugify("Tech / AI"), "tech-ai");
});

test("template drafts retain ordered sections and unique account memberships", () => {
  const draft = templatesAdmin.normalizeDraft({
    name: "Wars & Geopolitics",
    accent: "World",
    sections: ["Official Sources", "official sources", "Conflict Monitors"],
    memberships: [
      { handle: "Barchart", section: "official sources" },
      { handle: "barchart", section: "Conflict Monitors" },
      { handle: "TechDev_52", section: "Conflict Monitors" },
    ],
  });

  assert.equal(draft.id, "wars-geopolitics");
  assert.equal(draft.accent, "world");
  assert.deepEqual(draft.sections, ["Official Sources", "Conflict Monitors"]);
  assert.deepEqual(draft.memberships, [
    { handle: "Barchart", section: "Official Sources" },
    { handle: "TechDev_52", section: "Conflict Monitors" },
  ]);
});

test("an account already in the draft is recognized however its handle is written", () => {
  const draft = { memberships: [{ handle: "Barchart", section: "Market Data" }] };

  for (const typed of ["Barchart", "barchart", "@BARCHART", " @BarChart "]) {
    assert.equal(templatesAdmin.isMember(draft, typed), true, typed);
  }
  assert.equal(templatesAdmin.isMember(draft, "TechDev_52"), false);
  assert.equal(templatesAdmin.isMember({ memberships: [] }, "Barchart"), false);
});
