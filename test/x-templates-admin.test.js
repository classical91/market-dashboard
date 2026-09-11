"use strict";

const test = require("node:test");
const assert = require("node:assert");

const templatesAdmin = require("../public/assets/js/x-templates-admin");

test("template ids are bookmark-safe slugs", () => {
  assert.equal(templatesAdmin.slugify(" Wars & Geopolitics "), "wars-geopolitics");
  assert.equal(templatesAdmin.slugify("Tech / AI"), "tech-ai");
});

test("template drafts keep their account order and drop repeats", () => {
  const draft = templatesAdmin.normalizeDraft({
    name: "Wars & Geopolitics",
    accent: "World",
    // Order is the only arrangement a template has, so it must survive
    // normalization exactly as given.
    handles: ["Barchart", "@barchart", "TechDev_52", " jasonpizzino "],
  });

  assert.equal(draft.id, "wars-geopolitics");
  assert.equal(draft.accent, "world");
  assert.deepEqual(draft.handles, ["Barchart", "TechDev_52", "jasonpizzino"]);
  assert.equal("sections" in draft, false, "templates have no sections");
});

test("an account already in the draft is recognized however its handle is written", () => {
  const draft = { handles: ["Barchart"] };

  for (const typed of ["Barchart", "barchart", "@BARCHART", " @BarChart "]) {
    assert.equal(templatesAdmin.isMember(draft, typed), true, typed);
  }
  assert.equal(templatesAdmin.isMember(draft, "TechDev_52"), false);
  assert.equal(templatesAdmin.isMember({ handles: [] }, "Barchart"), false);
});
