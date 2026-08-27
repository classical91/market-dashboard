"use strict";

// The browser-side freshness decisions, exercised directly. This is the same
// module the page loads, so what the tests assert is what the reader sees.

const test = require("node:test");
const assert = require("node:assert");

const { decideRefresh, describeStatus } = require("../public/assets/js/x-freshness");

const NOW = Date.parse("2026-08-27T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function cachedPayload({ posts = [{ id: "1", handle: "alpha" }], confirmedAt } = {}) {
  return {
    status: "live",
    posts,
    accounts: [{ handle: "alpha", posts, dataState: "live" }],
    mostRecentSuccessfulFetchAt: confirmedAt || ago(6 * HOUR),
  };
}

function browserCache({ savedAgoMs = 3 * HOUR, expired = false, ...rest } = {}) {
  return {
    payload: cachedPayload(rest),
    savedAt: NOW - savedAgoMs,
    savedAtIso: ago(savedAgoMs),
    expired,
  };
}

/* ── The outage the server can answer through ──────────────────────────── */

test("a reachable server reporting a total provider outage must not evict the browser cache", () => {
  const cache = browserCache();
  const outagePayload = { status: "unavailable", posts: [], accounts: [], counts: { unavailable: 22 } };

  assert.equal(
    decideRefresh(cache, outagePayload).action,
    "preserve",
    "an empty outage response must never overwrite last-known-good posts",
  );
});

test("the preserved-cache banner names both when it was saved and when it was last confirmed", () => {
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: browserCache({ savedAgoMs: 3 * HOUR, confirmedAt: ago(6 * HOUR) }),
    serverOutage: { status: "unavailable", posts: [] },
    feedData: cachedPayload(),
  };

  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "unavailable", "a provider outage is never dressed up as live");
  assert.equal(
    status.message,
    "X providers unavailable. Showing browser-cached posts saved 3 hours ago; last confirmed 6 hours ago.",
  );
});

test("a server response carrying posts still replaces the cache", () => {
  const cache = browserCache();
  const fresh = { status: "live", posts: [{ id: "2", handle: "alpha" }], accounts: [] };
  assert.equal(decideRefresh(cache, fresh).action, "replace");
});

test("an empty response with no cache to protect is simply shown as the outage it is", () => {
  assert.equal(decideRefresh(null, { status: "unavailable", posts: [] }).action, "replace");
});

/* ── "Checked" means checked, not "response assembled" ─────────────────── */

test("a feed served from the server cache reports when X was checked, not when the response was built", () => {
  // The service's 15-minute feed cache can answer without contacting X, so
  // generatedAt is now while the data was confirmed ten minutes ago.
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: null,
    serverOutage: null,
    feedData: {
      status: "live",
      generatedAt: new Date(NOW).toISOString(),
      lastCheckedAt: ago(10 * MINUTE),
      counts: { live: 1 },
      posts: [{ id: "1", handle: "alpha" }],
      accounts: [
        {
          handle: "alpha",
          dataState: "live",
          lastCheckedAt: ago(10 * MINUTE),
          lastSuccessfulFetchAt: ago(10 * MINUTE),
          newestPostAt: ago(2 * HOUR),
        },
      ],
    },
  };

  const all = describeStatus(state, null, NOW);
  assert.equal(all.message, "All 1 accounts confirmed current — last checked 10 minutes ago.");
  assert.ok(!/just now/.test(all.message), "generatedAt must not be passed off as the check time");

  const account = describeStatus(state, "alpha", NOW);
  assert.equal(account.level, "live");
  assert.equal(
    account.message,
    "Last checked 10 minutes ago. @alpha's latest post is from 2 hours ago.",
  );
});

test("a quiet account reads as checked-and-current, not stale", () => {
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: null,
    serverOutage: null,
    feedData: {
      status: "live",
      lastCheckedAt: ago(4 * MINUTE),
      counts: { live: 1 },
      posts: [{ id: "1", handle: "alpha" }],
      accounts: [
        {
          handle: "alpha",
          dataState: "live",
          lastCheckedAt: ago(4 * MINUTE),
          lastSuccessfulFetchAt: ago(4 * MINUTE),
          newestPostAt: ago(6 * 24 * HOUR),
        },
      ],
    },
  };

  const status = describeStatus(state, "alpha", NOW);
  assert.equal(status.level, "live");
  assert.equal(status.message, "Last checked 4 minutes ago. @alpha's latest post is from 6 days ago.");
});

test("a missing check timestamp is reported as unknown rather than optimistically as now", () => {
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: null,
    serverOutage: null,
    feedData: {
      status: "live",
      counts: { live: 1 },
      posts: [{ id: "1", handle: "alpha" }],
      accounts: [{ handle: "alpha", dataState: "live" }],
    },
  };

  const status = describeStatus(state, "alpha", NOW);
  assert.match(status.message, /Last checked at an unknown time\./);
  assert.ok(!/just now/.test(status.message));
});

/* ── Transport failures and cache ages ─────────────────────────────────── */

test("an unreachable server keeps a fresh cache visible, labelled offline with both timestamps", () => {
  const state = {
    loaded: true,
    transport: { ok: false, reason: "Couldn't reach the dashboard server" },
    cache: browserCache({ savedAgoMs: 20 * MINUTE, confirmedAt: ago(90 * MINUTE) }),
    serverOutage: null,
    feedData: cachedPayload(),
  };

  const status = describeStatus(state, null, NOW);
  assert.equal(status.level, "offline");
  assert.equal(
    status.message,
    "Couldn't reach the dashboard server. Showing cached posts saved 20 minutes ago; last confirmed 1 hour ago.",
  );
});

test("an expired cache is shown only as explicitly historical", () => {
  const state = {
    loaded: true,
    transport: { ok: false, reason: "Couldn't reach the dashboard server" },
    cache: browserCache({ savedAgoMs: 3 * HOUR, expired: true }),
    serverOutage: null,
    feedData: cachedPayload(),
  };

  const status = describeStatus(state, null, NOW);
  assert.equal(status.level, "unavailable");
  assert.match(status.message, /treat these as historical, not current\./);
});

test("a pending refresh never replays the cached payload's own status as current", () => {
  // Initial paint: the cache says "live" because it did when it was saved.
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: browserCache({ savedAgoMs: 30 * MINUTE }),
    serverOutage: null,
    feedData: cachedPayload(),
  };

  const status = describeStatus(state, null, NOW);
  assert.equal(status.level, "stale", "cached-and-unverified is not live");
  assert.match(status.message, /^Refreshing… Showing cached posts saved 30 minutes ago/);
});

test("a stale account reports what it last confirmed, not merely that it was checked", () => {
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: null,
    serverOutage: null,
    feedData: {
      status: "stale",
      lastCheckedAt: ago(2 * MINUTE),
      counts: { stale: 1 },
      posts: [{ id: "1", handle: "alpha" }],
      accounts: [
        {
          handle: "alpha",
          dataState: "stale",
          stale: true,
          lastCheckedAt: ago(2 * MINUTE),
          lastSuccessfulFetchAt: ago(5 * HOUR),
        },
      ],
    },
  };

  const status = describeStatus(state, "alpha", NOW);
  assert.equal(status.level, "stale");
  assert.equal(
    status.message,
    "The latest check for @alpha did not succeed — last checked 2 minutes ago. Showing posts last confirmed 5 hours ago.",
  );
});
