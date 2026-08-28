"use strict";

// The persistent tracked-account registry. The property that matters most
// here is that a delete stays deleted: the old list was compiled into the
// bundle, so anything that only removed an account in memory or in a browser
// would quietly restore it on the next redeploy.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { XAccountRegistry } = require("../src/services/x-account-registry");
const { X_ACCOUNTS } = require("../src/config/x-accounts");
const { MemoryCache } = require("../src/services/cache");

const quietLogger = { warn() {}, error() {}, log() {} };

function tempRegistry(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-x-registry-"));
  const registry = new XAccountRegistry({ dataDir, logger: quietLogger, ...options });
  return { dataDir, registry, file: path.join(dataDir, "x-accounts.json") };
}

test("the static config seeds the persistent registry on first boot", () => {
  const { registry, file } = tempRegistry();

  assert.equal(fs.existsSync(file), false, "nothing is written before the first use");
  assert.equal(registry.ensureSeeded(), true);
  assert.equal(fs.existsSync(file), true);

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.accounts.length, X_ACCOUNTS.length);
  assert.deepEqual(
    registry.list().map((a) => a.handle),
    X_ACCOUNTS.map((a) => a.handle),
    "seeded order is preserved so the sidebar sections do not reshuffle",
  );
});

test("seeding is idempotent and never overwrites an edited registry", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  registry.remove("Barchart");

  const reopened = new XAccountRegistry({ dataDir, logger: quietLogger });
  assert.equal(reopened.ensureSeeded(), false, "an existing file is left alone");
  assert.ok(
    !reopened.list().some((a) => a.handle === "Barchart"),
    "a re-seed must not resurrect a deleted account",
  );
});

test("version-one registries gain war accounts without losing entries or duplicating handles by case", () => {
  const { registry, file } = tempRegistry({ seed: [] });
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [
    { handle: "custom", label: "Custom", category: "Local" },
    { handle: "REUTERSWORLD", label: "Existing Reuters", category: "Local" },
  ] }));

  assert.equal(registry.ensureSeeded(), true);
  const accounts = registry.list();
  assert.ok(accounts.some((entry) => entry.handle === "custom"));
  assert.equal(accounts.filter((entry) => entry.handle.toLowerCase() === "reutersworld").length, 1);
  assert.equal(accounts.length, 18);
  assert.equal(registry.ensureSeeded(), false);
});

test("an added account persists across a restart", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  registry.add({ handle: "newtrader", label: "New Trader", category: "Crypto Traders" });

  const reopened = new XAccountRegistry({ dataDir, logger: quietLogger });
  const added = reopened.list().find((a) => a.handle === "newtrader");
  assert.ok(added, "the account survives a fresh process");
  assert.equal(added.label, "New Trader");
  assert.equal(added.category, "Crypto Traders");
});

test("a deleted account stays deleted across a restart", () => {
  const { dataDir, registry } = tempRegistry();
  registry.ensureSeeded();
  registry.remove("TechDev_52");

  const reopened = new XAccountRegistry({ dataDir, logger: quietLogger });
  assert.ok(!reopened.list().some((a) => a.handle === "TechDev_52"));
});

test("a leading @ is normalized away", () => {
  const { registry } = tempRegistry({ seed: [] });
  const added = registry.add({ handle: "  @Spaced  ", category: "Market Data" });
  assert.equal(added.handle, "Spaced");
  assert.equal(registry.list()[0].handle, "Spaced");
});

test("duplicate handles are rejected case-insensitively", () => {
  const { registry } = tempRegistry({ seed: [] });
  registry.add({ handle: "Trader", category: "Crypto Traders" });

  assert.throws(
    () => registry.add({ handle: "@TRADER", category: "TA & Signals" }),
    /already tracked/,
  );
  assert.equal(registry.list().length, 1, "the rejected add left nothing behind");
});

test("malformed handles are rejected before they can reach the feed", () => {
  const { registry } = tempRegistry({ seed: [] });
  for (const bad of ["", "  ", "has space", "toolonghandle1234", "bad-dash", "dot.dot"]) {
    assert.throws(() => registry.add({ handle: bad, category: "Market Data" }), /valid X handle|handle is required/);
  }
  assert.equal(registry.list().length, 0);
});

test("a missing category is rejected, and a blank label falls back to the handle", () => {
  const { registry } = tempRegistry({ seed: [] });
  assert.throws(() => registry.add({ handle: "someone" }), /category is required/);

  const added = registry.add({ handle: "someone", label: "  ", category: "Custom Desk" });
  assert.equal(added.label, "someone");
  assert.equal(added.category, "Custom Desk", "a custom category is allowed");
});

test("deleting an account clears its cached feed state", () => {
  const cache = new MemoryCache();
  const { registry } = tempRegistry({ seed: [{ handle: "gone", label: "Gone", category: "Market Data" }], cache });
  registry.ensureSeeded();

  cache.set("x:feed:gone", { handle: "gone", posts: [] }, 60000);
  cache.set("x:feed:latest:gone", { handle: "gone", posts: [] }, 60000);
  cache.set("x:userid:gone", "12345", 60000);

  registry.remove("gone");

  // Without this the account keeps returning from cache, which reads exactly
  // like the delete having silently failed.
  assert.equal(cache.get("x:feed:gone"), null);
  assert.equal(cache.get("x:feed:latest:gone"), null);
  assert.equal(cache.get("x:userid:gone"), null);
});

test("removing an untracked handle reports 404 rather than silently succeeding", () => {
  const { registry } = tempRegistry({ seed: [] });
  assert.throws(() => registry.remove("nobody"), /not tracked/);
});

/* ── Failing safely ────────────────────────────────────────────────────── */

test("a corrupt registry serves the seed, says so, and is preserved on repair", () => {
  const { dataDir, registry, file } = tempRegistry();
  fs.writeFileSync(file, "{ this is not json", "utf8");

  // Must not throw: a bad file cannot be allowed to take the server down.
  const list = registry.list();
  assert.equal(list.length, X_ACCOUNTS.length, "the seed keeps the dashboard usable");

  const described = registry.describe();
  assert.equal(described.loadState, "corrupt");
  assert.ok(described.loadError, "the problem is visible in diagnostics");

  registry.add({ handle: "recovered", category: "Market Data" });
  assert.equal(
    fs.readFileSync(path.join(dataDir, "x-accounts.json.corrupt"), "utf8"),
    "{ this is not json",
    "the unreadable file is kept rather than thrown away by the repair",
  );
  assert.equal(registry.describe().loadState, "loaded");
});

test("a registry holding malformed rows drops just those rows", () => {
  const { registry, file } = tempRegistry();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      accounts: [
        { handle: "good", label: "Good", category: "Market Data" },
        { handle: "bad handle", label: "Bad", category: "Market Data" },
        { handle: "alsogood", category: "TA & Signals" },
      ],
    }),
    "utf8",
  );

  const list = registry.list();
  assert.deepEqual(list.map((a) => a.handle), ["good", "alsogood"]);
  assert.equal(registry.describe().loadState, "partial");
});

test("a registry file that is valid JSON but the wrong shape is treated as corrupt", () => {
  const { registry, file } = tempRegistry();
  fs.writeFileSync(file, JSON.stringify({ version: 1, notAccounts: true }), "utf8");

  assert.equal(registry.list().length, X_ACCOUNTS.length);
  assert.equal(registry.describe().loadState, "corrupt");
});
