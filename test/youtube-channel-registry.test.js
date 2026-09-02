"use strict";

// Covers the persisted YouTube channel registry: that the seed survives a
// restart, that one channel stays one row, and that a file the server cannot
// read never silently untracks everything.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  YoutubeChannelRegistry,
  normalizeChannel,
  dedupeChannels,
} = require("../src/services/youtube-channel-registry");

const quietLogger = { warn() {}, error() {}, log() {} };

const SEED = [
  { handle: "stockmoe", label: "StockMoe", category: "Stocks", channelId: "" },
  { handle: "cryptosrus", label: "CryptosRUs", category: "Crypto", channelId: "" },
];

function tempRegistry(seed = SEED) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-yt-channels-"));
  const registry = new YoutubeChannelRegistry({
    dataDir,
    seed,
    categorySeed: ["Stocks", "Crypto", "Archaeology"],
    logger: quietLogger,
  });
  return { dataDir, registry, file: path.join(dataDir, "youtube-channels.json") };
}

test("the static config seeds the registry once, then the file is the source of truth", () => {
  const { dataDir, registry, file } = tempRegistry();

  assert.equal(registry.ensureSeeded(), true);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(registry.list().map((c) => c.handle), ["stockmoe", "cryptosrus"]);

  // A second boot with a different seed must not resurrect or replace anything.
  const reopened = new YoutubeChannelRegistry({ dataDir, seed: [], categorySeed: [], logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), false, "an existing file is left alone");
  assert.deepEqual(reopened.list().map((c) => c.handle), ["stockmoe", "cryptosrus"]);
});

test("adds and deletes persist across a restart", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();

  const added = registry.add({ handle: "@Diggers", label: "Diggers", category: "Archaeology" });
  assert.equal(added.handle, "Diggers");
  assert.ok(added.addedAt, "the add is timestamped");
  registry.remove("stockmoe");

  const reopened = new YoutubeChannelRegistry({ dataDir, seed: SEED, categorySeed: ["Stocks", "Crypto", "Archaeology"], logger: quietLogger });
  const handles = reopened.list().map((c) => c.handle);
  assert.deepEqual(handles, ["cryptosrus", "Diggers"]);
});

test("one channel is one row, however the handle is spelled", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  assert.throws(
    () => registry.add({ handle: "@STOCKMOE", category: "Stocks" }),
    /already tracked/,
  );
  assert.equal(registry.list().length, 2, "the rejected add saved nothing");

  // The write path de-duplicates regardless of caller, not only through add().
  const { channels, dropped } = dedupeChannels([
    { handle: "a" }, { handle: "A" }, { handle: "b" },
  ]);
  assert.equal(channels.length, 2);
  assert.equal(dropped, 1);
});

test("a malformed channel is refused rather than persisted", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();

  assert.throws(() => registry.add({ handle: "", category: "Stocks" }), /handle is required/);
  assert.throws(() => registry.add({ handle: "no", category: "Stocks" }), /not a valid YouTube handle/);
  assert.throws(() => registry.add({ handle: "valid_handle", category: "" }), /category is required/);
  assert.throws(
    () => registry.add({ handle: "valid_handle", category: "Stocks", channelId: "not-an-id" }),
    /not a valid channel ID/,
  );
  assert.equal(registry.list().length, 2, "nothing was saved");
});

test("a blank channel ID is stored empty so the feed resolves it instead", () => {
  const channel = normalizeChannel(
    { handle: "someone", categoryId: "category:stocks", channelId: "   " },
    [{ id: "category:stocks", name: "Stocks" }],
  );
  assert.equal(channel.channelId, "");
  assert.equal(channel.label, "someone", "an empty label falls back to the handle");
});

test("categories are canonical, rename centrally, and survive restart", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  assert.throws(() => registry.addCategory({ name: " stocks " }), /already exists/);
  const added = registry.addCategory({ name: "Research" });
  registry.add({ handle: "researcher", categoryId: added.id });
  registry.updateCategory(added.id, { name: "Deep Research" });
  assert.equal(registry.list().find((item) => item.handle === "researcher").category, "Deep Research");
  const reopened = new YoutubeChannelRegistry({ dataDir, seed: [], logger: quietLogger });
  assert.equal(reopened.listCategories().find((item) => item.id === added.id).name, "Deep Research");
});

test("deleting a used category requires and applies a safe reassignment", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  const category = registry.addCategory({ name: "Temporary" });
  registry.add({ handle: "temporary", categoryId: category.id });
  assert.throws(() => registry.removeCategory(category.id), /choose where to move/);
  registry.removeCategory(category.id, { reassignToCategoryId: "uncategorized" });
  const channel = registry.list().find((item) => item.handle === "temporary");
  assert.equal(channel.categoryId, "uncategorized");
  assert.equal(channel.category, "Uncategorized");
  assert.equal(registry.listCategories().find((item) => item.id === "uncategorized").channelCount, 1);
});

test("editing a channel changes its canonical category assignment", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  const crypto = registry.listCategories().find((item) => item.name === "Crypto");
  const updated = registry.update("stockmoe", { handle: "stockmoe", label: "Stock Moe", categoryId: crypto.id });
  assert.equal(updated.categoryId, crypto.id);
  assert.equal(registry.list().find((item) => item.handle === "stockmoe").category, "Crypto");
});

test("removing a channel that is not tracked is a 404, not a silent success", () => {
  const { registry } = tempRegistry();
  registry.ensureSeeded();
  assert.throws(() => registry.remove("nobody"), /is not tracked/);
});

test("an unreadable registry serves the seed instead of untracking everything", () => {
  const { registry, file } = tempRegistry();
  registry.ensureSeeded();
  fs.writeFileSync(file, "{ this is not json");

  assert.deepEqual(registry.list().map((c) => c.handle), ["stockmoe", "cryptosrus"]);
  assert.equal(registry.describe().loadState, "corrupt");

  // The next write preserves the unreadable file rather than losing it to the repair.
  registry.add({ handle: "diggers", category: "Archaeology" });
  assert.ok(fs.existsSync(`${file}.corrupt`), "the unreadable file is backed up");
  assert.equal(registry.describe().loadState, "loaded");
});

test("one bad row does not take the readable rows down with it", () => {
  const { registry, file } = tempRegistry();
  registry.ensureSeeded();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      channels: [
        { handle: "stockmoe", label: "StockMoe", category: "Stocks" },
        { handle: "", category: "Broken" },
        { handle: "cryptosrus", label: "CryptosRUs", category: "Crypto" },
      ],
    }),
  );

  assert.deepEqual(registry.list().map((c) => c.handle), ["stockmoe", "cryptosrus"]);
  assert.equal(registry.describe().loadState, "partial");
});

test("version 1 category strings migrate without losing custom or Test data", () => {
  const { dataDir, file } = tempRegistry();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    channels: [
      { handle: "testerone", label: "Tester One", category: " Test " },
      { handle: "testertwo", label: "Tester Two", category: "test" },
      { handle: "customdesk", label: "Custom Desk", category: "Custom" },
    ],
  }));
  const registry = new YoutubeChannelRegistry({ dataDir, seed: SEED, categorySeed: ["Stocks", "Crypto"], logger: quietLogger });
  assert.equal(registry.ensureSeeded(), false);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.categories.filter((category) => category.name.toLowerCase() === "test").length, 1);
  assert.equal(registry.list().filter((channel) => channel.category === "Test").length, 2);
  assert.ok(registry.listCategories().some((category) => category.name === "Custom"));
});
