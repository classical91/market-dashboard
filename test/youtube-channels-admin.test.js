"use strict";

// The Manage YouTube Sources panel's local validation and copy. These are the
// fast half of the rules the registry in src/services/youtube-channel-registry.js
// enforces for real, so the two have to agree on what counts as valid.

const test = require("node:test");
const assert = require("node:assert");

const admin = require("../public/assets/js/youtube-channels-admin");

const TRACKED = [
  { handle: "stockmoe", label: "StockMoe", categoryId: "category:crypto", category: "Crypto" },
  { handle: "iReviewsVideos", label: "iReviews", categoryId: "category:tech", category: "Tech" },
];

const CATEGORIES = [
  { id: "category:crypto", name: "Crypto", channelCount: 1 },
  { id: "category:tech", name: "Tech", channelCount: 1 },
];

test("a handle is taken from an @ prefix, stray whitespace or a channel URL", () => {
  assert.equal(admin.normalizeHandle("  @stockmoe "), "stockmoe");
  assert.equal(admin.normalizeHandle("https://www.youtube.com/@tradersreality"), "tradersreality");
  assert.equal(admin.normalizeHandle("https://youtube.com/c/CryptosRUs?sub=1"), "CryptosRUs");
  assert.equal(admin.validateHandle("has space").ok, false);
  assert.equal(admin.validateHandle("").ok, false);
});

test("a channel already tracked is recognized however it is typed", () => {
  for (const typed of ["stockmoe", "@STOCKMOE", " https://youtube.com/@StockMoe "]) {
    assert.equal(admin.isDuplicate(TRACKED, typed), true, typed);
  }
  assert.equal(admin.isDuplicate(TRACKED, "newchannel"), false);
  // Editing a channel must not report the channel itself as its own duplicate.
  assert.equal(admin.findDuplicate(TRACKED, "stockmoe", "stockmoe"), null);
});

test("a channel ID is optional, but a malformed one is refused", () => {
  assert.equal(admin.validateChannelId("").ok, true);
  assert.equal(admin.validateChannelId("UC" + "a".repeat(22)).ok, true);
  assert.equal(admin.validateChannelId("not-an-id").ok, false);
});

test("categories collide on case and whitespace, not on exact spelling", () => {
  assert.equal(admin.categoryDuplicate(CATEGORIES, " crypto ").id, "category:crypto");
  assert.equal(admin.categoryDuplicate(CATEGORIES, "CRYPTO").id, "category:crypto");
  assert.equal(admin.categoryDuplicate(CATEGORIES, "Crypto", "category:crypto"), null, "renaming a category to itself is allowed");
  assert.equal(admin.categoryDuplicate(CATEGORIES, "Geopolitics"), null);
});

test("the channel form reports the first thing the user can act on", () => {
  const ok = { handle: { ok: true, handle: "newchannel" }, channelId: { ok: true, channelId: "" } };
  assert.equal(admin.channelFormProblem(ok), null);

  assert.match(admin.channelFormProblem({ ...ok, handle: { ok: false, reason: "Enter a YouTube handle." } }), /handle/);
  assert.match(admin.channelFormProblem({ ...ok, channelId: { ok: false, reason: "A channel ID is UC followed by 22 characters." } }), /channel ID/);
  assert.match(admin.channelFormProblem({ ...ok, duplicate: TRACKED[0] }), /@stockmoe is already tracked/);
});

test("creating a category inline is validated before the channel is saved", () => {
  const base = { handle: { ok: true, handle: "newchannel" }, channelId: { ok: true, channelId: "" }, creatingCategory: true };

  assert.match(admin.channelFormProblem({ ...base, categoryName: "   " }), /name for the new category/);
  assert.match(
    admin.channelFormProblem({ ...base, categoryName: "crypto", categoryClash: CATEGORIES[0] }),
    /"Crypto" already exists/,
    "the clash is reported as the category is stored, not as it was typed",
  );
  assert.equal(admin.channelFormProblem({ ...base, categoryName: "Geopolitics" }), null);
});

test("an empty channel list says which view is empty", () => {
  assert.match(admin.emptyChannelsMessage(CATEGORIES, "category:tech", ""), /No channels in Tech yet/);
  assert.match(admin.emptyChannelsMessage(CATEGORIES, "category:tech", "moe"), /No channels match "moe" in Tech/);
  assert.match(admin.emptyChannelsMessage(CATEGORIES, "all", "moe"), /No channels match "moe"/);
  assert.match(admin.emptyChannelsMessage(CATEGORIES, "all", ""), /No channels match/);
});
