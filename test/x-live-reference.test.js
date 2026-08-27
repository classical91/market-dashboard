"use strict";

// The browser-side pieces of account management and the Live X Reference
// panel. These are the same modules the page loads.

const test = require("node:test");
const assert = require("node:assert");

const live = require("../public/assets/js/x-live-reference");
const admin = require("../public/assets/js/x-accounts-admin");

const NOW = Date.parse("2026-08-27T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* ── Live X Reference ──────────────────────────────────────────────────── */

test("the reference panel points at the selected handle", () => {
  const described = live.describeReference(
    "TechDev_52",
    { lastCheckedAt: ago(12 * MINUTE), newestPostAt: ago(13 * HOUR) },
    NOW,
  );

  assert.equal(described.handle, "TechDev_52");
  assert.equal(described.profileUrl, "https://x.com/TechDev_52");
  assert.equal(described.title, "Live X — @TechDev_52");
  assert.equal(described.openLabel, "Open @TechDev_52 on X ↗");
});

test("the panel states how current our capture is, so a difference can be read", () => {
  const described = live.describeReference(
    "TechDev_52",
    { lastCheckedAt: ago(12 * MINUTE), newestPostAt: ago(13 * HOUR) },
    NOW,
  );

  assert.equal(described.trackedLine, "Tracked by Intelligence: last checked 12 minutes ago");
  assert.equal(described.newestLine, "Newest captured post: 13 hours ago");
});

test("switching accounts produces a reference for the new handle", () => {
  const first = live.describeReference("alpha", {}, NOW);
  const second = live.describeReference("beta", {}, NOW);

  assert.notEqual(first.profileUrl, second.profileUrl);
  assert.equal(second.profileUrl, "https://x.com/beta");
  assert.equal(second.title, "Live X — @beta");
});

test("missing capture timestamps read as unknown, never as fresh", () => {
  const described = live.describeReference("quiet", {}, NOW);
  assert.match(described.trackedLine, /last checked at an unknown time/);
  assert.match(described.newestLine, /none captured yet/);
  assert.ok(!/just now/.test(described.trackedLine));
});

test("an unavailable embed falls back to opening the account on X", () => {
  const described = live.describeReference("protected_user", {}, NOW);
  assert.equal(
    described.unavailableMessage,
    "Live X timeline unavailable. Open @protected_user on X to compare manually.",
  );
  // The external link is always present, so the fallback has somewhere to go.
  assert.equal(described.profileUrl, "https://x.com/protected_user");
});

test("the widget script is loaded once however many accounts are opened", async () => {
  let loads = 0;
  const loader = live.createWidgetLoader(() => {
    loads += 1;
    return Promise.resolve({ widgets: { load() {} } });
  });

  await Promise.all([loader.load(), loader.load(), loader.load()]);
  await loader.load();

  assert.equal(loads, 1, "re-injecting widgets.js on every switch races copies of it");
  assert.equal(loader.attempts(), 1);
});

test("a blocked widget script stays rejected instead of retrying on every switch", async () => {
  let loads = 0;
  const loader = live.createWidgetLoader(() => {
    loads += 1;
    return Promise.reject(new Error("blocked"));
  });

  await assert.rejects(() => loader.load());
  await assert.rejects(() => loader.load());
  assert.equal(loads, 1, "a blocked host stays blocked; retrying just delays the fallback");
});

/* ── Manage Accounts validation ────────────────────────────────────────── */

test("handles are normalized and validated before a request is made", () => {
  assert.deepEqual(admin.validateHandle("  @TechDev_52 "), { ok: true, handle: "TechDev_52" });
  assert.equal(admin.validateHandle("").ok, false);
  assert.equal(admin.validateHandle("has space").ok, false);
  assert.equal(admin.validateHandle("waytoolongahandle").ok, false);
  assert.equal(admin.normalizeHandle("@@doubled"), "doubled");
});

test("duplicates are caught case-insensitively before hitting the server", () => {
  const accounts = [{ handle: "TechDev_52" }, { handle: "Barchart" }];
  assert.equal(admin.isDuplicate(accounts, "@techdev_52"), true);
  assert.equal(admin.isDuplicate(accounts, "BARCHART"), true);
  assert.equal(admin.isDuplicate(accounts, "someoneelse"), false);
});

test("deletion is confirmed with what will actually be removed", () => {
  assert.equal(
    admin.confirmationMessage("TechDev_52"),
    "Remove @TechDev_52 from X Intelligence? Existing cached feed data for this account will also be removed.",
  );
});

/* ── The details popup ─────────────────────────────────────────────────────
   The title, profile link and capture timestamps moved off the panel and
   behind a button. What matters is that nothing was lost in the move, and
   that the feed's own Live/Degraded banner is untouched by it. */

test("the popup carries every detail that used to sit above the timeline", () => {
  const described = live.describeReference(
    "trader1sz",
    { lastCheckedAt: ago(4 * MINUTE), newestPostAt: ago(2 * HOUR) },
    NOW,
  );

  assert.equal(described.title, "Live X — @trader1sz");
  assert.equal(described.openLabel, "Open @trader1sz on X ↗");
  assert.equal(described.trackedLine, "Tracked by Intelligence: last checked 4 minutes ago");
  assert.equal(described.newestLine, "Newest captured post: 2 hours ago");
  assert.equal(described.profileUrl, "https://x.com/trader1sz");
});
