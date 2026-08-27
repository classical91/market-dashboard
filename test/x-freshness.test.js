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

function cachedPayload({ posts = [{ id: "1", handle: "alpha" }], confirmedAt, newestConfirmedAt } = {}) {
  var oldest = confirmedAt || ago(6 * HOUR);
  return {
    status: "live",
    posts,
    accounts: [{ handle: "alpha", posts, dataState: "live" }],
    mostRecentSuccessfulFetchAt: newestConfirmedAt || oldest,
    oldestSuccessfulFetchAt: oldest,
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

test("the preserved-cache banner names when it was saved and its worst account confirmation", () => {
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
    "X providers unavailable. Showing browser-cached posts saved 3 hours ago; oldest account confirmation 6 hours ago.",
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
    "Couldn't reach the dashboard server. Showing cached posts saved 20 minutes ago; oldest account confirmation 1 hour ago.",
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

test("a mixed feed quotes its worst account confirmation, not its best", () => {
  // Five minutes for the freshest account, six hours for the oldest. Quoting
  // the freshest would tell the reader the whole feed is five minutes old.
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: browserCache({ confirmedAt: ago(6 * HOUR), newestConfirmedAt: ago(5 * MINUTE) }),
    serverOutage: { status: "unavailable", posts: [] },
    feedData: cachedPayload(),
  };

  const status = describeStatus(state, null, NOW);
  assert.match(status.message, /oldest account confirmation 6 hours ago/);
  assert.ok(!/5 minutes ago/.test(status.message), "the freshest account must not speak for the feed");
});

test("a cache written before the conservative field existed drops the clause rather than overstating", () => {
  const cache = browserCache();
  delete cache.payload.oldestSuccessfulFetchAt;
  const state = {
    loaded: true,
    transport: { ok: true },
    cache: cache,
    serverOutage: { status: "unavailable", posts: [] },
    feedData: cachedPayload(),
  };

  const status = describeStatus(state, null, NOW);
  assert.equal(status.message, "X providers unavailable. Showing browser-cached posts saved 3 hours ago.");
  assert.ok(!/confirm/.test(status.message), "no confirmation claim without a conservative number");
});

/* ── The aggregate banner summarises, it does not inherit the worst case ──
   The payload's `status` is the worst state across accounts, which is the
   right conservative summary for the API but the wrong headline: it let one
   failed account label 21 healthy ones UNAVAILABLE. */

function accountAt(handle, dataState, extra) {
  return Object.assign(
    {
      handle: handle,
      dataState: dataState,
      lastCheckedAt: ago(2 * MINUTE),
      lastSuccessfulFetchAt: dataState === "unavailable" ? null : ago(2 * MINUTE),
    },
    extra || {}
  );
}

function feedOf(accounts, status) {
  return {
    loaded: true,
    transport: { ok: true },
    cache: null,
    serverOutage: null,
    feedData: {
      // Deliberately the worst-of value the server really sends, so these
      // tests fail if the banner starts inheriting it again.
      status: status,
      lastCheckedAt: ago(2 * MINUTE),
      posts: accounts.filter((a) => a.dataState !== "unavailable").map((a) => ({ handle: a.handle })),
      accounts: accounts,
    },
  };
}

function manyAccounts(liveCount, failedCount, failedState) {
  const accounts = [];
  for (let i = 0; i < liveCount; i += 1) accounts.push(accountAt("live" + i, "live"));
  for (let i = 0; i < failedCount; i += 1) accounts.push(accountAt("down" + i, failedState || "unavailable"));
  return accounts;
}

test("21 live and 1 unavailable is DEGRADED, and the banner names the failed account", () => {
  const state = feedOf(manyAccounts(21, 1), "unavailable");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "degraded", "one failure must not label 21 healthy accounts unavailable");
  assert.equal(
    status.message,
    "21 live, 1 unavailable (@down0) of 22 accounts — last checked 2 minutes ago.",
  );
});

test("20 live and 2 unavailable names both failed accounts", () => {
  const state = feedOf(manyAccounts(20, 2), "unavailable");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "degraded");
  assert.match(status.message, /2 unavailable \(@down0, @down1\) of 22 accounts/);
});

test("many failures are truncated so the banner stays readable", () => {
  const state = feedOf(manyAccounts(17, 5), "unavailable");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "degraded");
  assert.match(status.message, /5 unavailable \(@down0, @down1, @down2 \+2 more\)/);
});

test("all 22 unavailable is UNAVAILABLE", () => {
  const state = feedOf(manyAccounts(0, 22), "unavailable");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "unavailable");
  assert.match(status.message, /22 unavailable/);
});

test("all 22 live is LIVE", () => {
  const state = feedOf(manyAccounts(22, 0), "live");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "live");
  assert.equal(status.message, "All 22 accounts confirmed current — last checked 2 minutes ago.");
});

test("a feed with no current data but cached posts is STALE", () => {
  const state = feedOf(manyAccounts(0, 22, "stale"), "stale");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "stale", "cached-only is stale, not unavailable");
  assert.match(status.message, /22 cached of 22 accounts/);
});

test("fallback-confirmed accounts count as current, so the feed is degraded not stale", () => {
  const accounts = manyAccounts(0, 0).concat(
    Array.from({ length: 22 }, (unused, i) => accountAt("acct" + i, i < 4 ? "degraded" : "stale")),
  );
  const status = describeStatus(feedOf(accounts, "stale"), null, NOW);

  assert.equal(status.level, "degraded");
  assert.match(status.message, /4 via fallback, 18 cached of 22 accounts/);
});

test("an account with an unrecognised state counts as unavailable, never as healthy", () => {
  const accounts = manyAccounts(21, 0).concat([{ handle: "mystery", lastCheckedAt: ago(2 * MINUTE) }]);
  const status = describeStatus(feedOf(accounts, "live"), null, NOW);

  assert.equal(status.level, "degraded");
  assert.match(status.message, /1 unavailable \(@mystery\)/);
});


test("the feed's own freshness banner is unaffected by moving the Live X details", () => {
  // The popup change is presentation of the reference panel only. The banner
  // that tells the reader whether the posts are current still renders here.
  const state = feedOf(manyAccounts(21, 1), "unavailable");
  const status = describeStatus(state, null, NOW);

  assert.equal(status.level, "degraded");
  assert.match(status.message, /21 live, 1 unavailable \(@down0\) of 22 accounts/);
});
