"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { XFeedService, worstDataState, safeDataState } = require("../src/services/x-feed");
const { MemoryCache } = require("../src/services/cache");

function apiResponse(tweets, users) {
  return {
    ok: true,
    json: async () => ({
      data: tweets,
      includes: { users },
      meta: {},
    }),
  };
}

async function withMockedApi(response, run) {
  const originalFetch = global.fetch;
  const originalToken = process.env.X_API_BEARER_TOKEN;
  process.env.X_API_BEARER_TOKEN = "test-token";
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return typeof response === "function" ? response(String(url)) : response;
  };
  try {
    return await run(requestedUrls);
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.X_API_BEARER_TOKEN;
    else process.env.X_API_BEARER_TOKEN = originalToken;
  }
}

function seedLastKnownGood(cache, handle, posts, extra = {}) {
  cache.set(`x:feed:latest:${handle}`, { handle, posts, source: "api", ...extra }, 60 * 60 * 1000);
}

const RECENT_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function statusResponse(status) {
  return { ok: false, status, json: async () => ({}), text: async () => "" };
}

function syndicationResponse(handle, iso, id) {
  const payload = {
    props: { tweets: [{ id_str: id, full_text: `syndicated post for ${handle}`, created_at: iso }] },
  };
  return {
    ok: true,
    status: 200,
    text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`,
  };
}

const isSearch = (url) => url.includes("/tweets/search/recent");
const isUserLookup = (url) => url.includes("/users/by/username/");
const isTimeline = (url) => /\/2\/users\/[^/]+\/tweets/.test(url);
const isSyndication = (url) => url.includes("syndication.twitter.com");

test("long-form posts use the full note_tweet body instead of the truncated text", async () => {
  const tweets = [
    {
      id: "200",
      text: "truncated preview…",
      note_tweet: { text: "the full long-form analysis body" },
      author_id: "u1",
      created_at: RECENT_ISO,
    },
  ];
  const users = [{ id: "u1", username: "alpha" }];
  await withMockedApi(apiResponse(tweets, users), async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feed = await service.getAccountFeed("alpha");
    assert.equal(feed.posts[0].text, "the full long-form analysis body");
  });
});

test("a handle with a recent last-known-good feed polls incrementally with since_id and merges", async () => {
  const tweets = [{ id: "200", text: "brand new post", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  await withMockedApi(apiResponse(tweets, users), async (requestedUrls) => {
    const cache = new MemoryCache();
    seedLastKnownGood(cache, "alpha", [
      { id: "100", text: "older post", url: "https://x.com/alpha/status/100", publishedAt: RECENT_ISO },
    ]);
    const service = new XFeedService({ cache });
    const feed = await service.getAccountFeed("alpha");

    assert.ok(requestedUrls[0].includes("since_id=100"), `expected since_id in ${requestedUrls[0]}`);
    assert.deepEqual(feed.posts.map((post) => post.id), ["200", "100"], "new and prior posts merge");
    assert.equal(feed.source, "api");
  });
});

test("an empty since_id response confirms 'nothing new' and serves the prior posts as fresh", async () => {
  await withMockedApi(apiResponse([], []), async (requestedUrls) => {
    const cache = new MemoryCache();
    seedLastKnownGood(cache, "alpha", [
      { id: "100", text: "older post", url: "https://x.com/alpha/status/100", publishedAt: RECENT_ISO },
    ]);
    const service = new XFeedService({ cache });
    const feed = await service.getAccountFeed("alpha");

    assert.ok(requestedUrls[0].includes("since_id=100"));
    assert.equal(requestedUrls.length, 1, "no fallback requests fire when nothing is new");
    assert.deepEqual(feed.posts.map((post) => post.id), ["100"]);
    assert.ok(!feed.stale, "confirmed-current posts are not marked stale");
  });
});

test("a handle with no prior feed does a full (cold) fetch without since_id", async () => {
  const tweets = [{ id: "300", text: "first ever post", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  await withMockedApi(apiResponse(tweets, users), async (requestedUrls) => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feed = await service.getAccountFeed("alpha");

    assert.ok(!requestedUrls[0].includes("since_id"), `unexpected since_id in ${requestedUrls[0]}`);
    assert.equal(feed.posts[0].id, "300");
  });
});

test("a stale anchor (older than the recent-search window) falls back to a cold fetch", async () => {
  const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const tweets = [{ id: "300", text: "fresh post", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  await withMockedApi(apiResponse(tweets, users), async (requestedUrls) => {
    const cache = new MemoryCache();
    seedLastKnownGood(cache, "alpha", [
      { id: "100", text: "month-old post", url: "https://x.com/alpha/status/100", publishedAt: oldIso },
    ]);
    const service = new XFeedService({ cache });
    await service.getAccountFeed("alpha");

    assert.ok(!requestedUrls[0].includes("since_id"), "since_id must not be sent past the 7-day search window");
  });
});

/* ── Provider failure states ───────────────────────────────────────────────
   These cover the transitions the incident turned on: what the service does
   when an upstream fails, and — critically — what it *says* about the data it
   serves afterwards. The invariant under test throughout is that old content
   may be served, but never labelled as freshly confirmed. */

test("a 401 opens the official circuit immediately instead of retrying per account", async () => {
  const handles = ["alpha", "beta", "gamma"];
  const respond = (url) => {
    if (isSearch(url)) return statusResponse(401);
    if (isSyndication(url)) return statusResponse(503);
    return statusResponse(500);
  };

  await withMockedApi(respond, async (requestedUrls) => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feeds = await service.getAccountFeeds(handles);

    assert.ok(
      !requestedUrls.some(isUserLookup) && !requestedUrls.some(isTimeline),
      `no official call may follow a 401, saw: ${requestedUrls.join(", ")}`,
    );
    assert.equal(requestedUrls.filter(isSearch).length, 1, "one batch, not one call per handle");

    const health = service.providerHealth();
    assert.equal(health.official.open, true);
    assert.equal(health.official.state, "auth_failed");

    for (const handle of handles) {
      const feed = feeds.get(handle);
      assert.equal(feed.posts, null);
      assert.equal(feed.dataState, "unavailable");
      assert.ok(feed.lastAttemptAt, "a failed attempt is still an attempt and is timestamped");
      assert.equal(feed.lastSuccessfulFetchAt, null);
    }
  });
});

test("an app-level 403 opens the global circuit", async () => {
  // X distinguishes app-level access problems from resource-level ones, and
  // only the former means the provider is unusable for every account.
  const clientForbidden = {
    ok: false,
    status: 403,
    json: async () => ({
      title: "Client Forbidden",
      type: "https://api.twitter.com/2/problems/client-forbidden",
      detail: "This app is not enrolled for this endpoint.",
    }),
    text: async () => "",
  };

  await withMockedApi((url) => (isSearch(url) ? clientForbidden : statusResponse(503)), async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    await service.getAccountFeeds(["alpha", "beta"]);
    assert.equal(service.providerHealth().official.state, "forbidden");
    assert.equal(service.providerHealth().official.open, true);
  });
});

test("a per-account 403 fails that account alone and leaves the provider up", async () => {
  // One account goes protected. The other 21 must keep working — a global
  // breaker here would turn a single private account into a whole-feed outage.
  const notAuthorized = {
    ok: false,
    status: 403,
    json: async () => ({
      title: "Forbidden",
      type: "https://api.twitter.com/2/problems/not-authorized-for-resource",
      detail: "Sorry, you are not authorized to see the user with id: beta.",
    }),
    text: async () => "",
  };
  const tweets = [{ id: "700", text: "alpha is public", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];

  const respond = (url) => {
    if (isSearch(url)) return apiResponse(tweets, users);
    if (isUserLookup(url) || isTimeline(url)) return notAuthorized;
    return statusResponse(503);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feeds = await service.getAccountFeeds(["alpha", "beta"]);

    assert.equal(feeds.get("alpha").dataState, "live", "the healthy account is unaffected");
    assert.equal(feeds.get("beta").dataState, "unavailable");
    assert.equal(
      service.providerHealth().official.open,
      false,
      "one protected account must not disable the provider",
    );
  });
});

test("a 404 on one account never opens the global circuit", async () => {
  const tweets = [{ id: "701", text: "alpha is fine", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  const respond = (url) => {
    if (isSearch(url)) return apiResponse(tweets, users);
    if (isUserLookup(url) || isTimeline(url)) return statusResponse(404);
    return statusResponse(503);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    await service.getAccountFeeds(["alpha", "beta"]);
    assert.equal(service.providerHealth().official.open, false);
  });
});

test("a 429 puts the official provider in a timed cooldown", async () => {
  await withMockedApi((url) => (isSearch(url) ? statusResponse(429) : statusResponse(503)), async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    await service.getAccountFeeds(["alpha"]);

    const health = service.providerHealth();
    assert.equal(health.official.state, "rate_limited");
    assert.ok(new Date(health.official.retryAt).getTime() > Date.now(), "cooldown has an end time");
  });
});

test("resetting the circuits lets the provider recover once the token is repaired", async () => {
  const tweets = [{ id: "900", text: "back online", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  let tokenRepaired = false;
  const respond = (url) => {
    if (isSearch(url)) return tokenRepaired ? apiResponse(tweets, users) : statusResponse(401);
    return statusResponse(503);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    await service.getAccountFeeds(["alpha"]);
    assert.equal(service.providerHealth().official.open, true);

    tokenRepaired = true;
    service.resetCircuits();
    assert.equal(service.providerHealth().official.open, false);

    const feed = await service.getAccountFeed("alpha");
    assert.equal(feed.dataState, "live");
    assert.equal(feed.provider, "x-api");
  });
});

test("when X fails but syndication answers, the feed is degraded — not live", async () => {
  const respond = (url) => {
    if (isSearch(url) || isUserLookup(url) || isTimeline(url)) return statusResponse(500);
    if (isSyndication(url)) return syndicationResponse("alpha", RECENT_ISO, "777");
    return statusResponse(500);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feed = await service.getAccountFeed("alpha");

    assert.equal(feed.dataState, "degraded");
    assert.equal(feed.provider, "syndication");
    assert.equal(feed.posts[0].id, "777");
    assert.ok(feed.lastSuccessfulFetchAt, "syndication still counts as a successful fetch");
    assert.ok(!feed.stale);
  });
});

test("with every provider down, cached posts are served as stale with their last-confirmed time", async () => {
  const confirmedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await withMockedApi(() => statusResponse(500), async () => {
    const cache = new MemoryCache();
    seedLastKnownGood(
      cache,
      "alpha",
      [{ id: "100", text: "older post", url: "https://x.com/alpha/status/100", publishedAt: RECENT_ISO }],
      { lastSuccessfulFetchAt: confirmedAt },
    );
    const service = new XFeedService({ cache });
    const feed = await service.getAccountFeed("alpha");

    assert.equal(feed.dataState, "stale");
    assert.equal(feed.provider, "cache");
    assert.equal(feed.stale, true);
    assert.equal(
      feed.lastSuccessfulFetchAt,
      confirmedAt,
      "the cached feed reports when it was really confirmed, not now",
    );
    assert.ok(new Date(feed.lastAttemptAt).getTime() > new Date(confirmedAt).getTime());
    assert.ok(feed.staleReason, "why it is stale travels with the feed");
  });
});

test("with every provider down and nothing cached, the account is unavailable", async () => {
  await withMockedApi(() => statusResponse(500), async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feeds = await service.getAccountFeeds(["alpha"]);
    const feed = feeds.get("alpha");

    assert.equal(feed.dataState, "unavailable");
    assert.equal(feed.posts, null);
    assert.ok(feed.error);
  });
});

test("one failing account does not take the healthy ones down with it", async () => {
  const tweets = [{ id: "400", text: "alpha is fine", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  const respond = (url) => {
    if (isSearch(url)) return apiResponse(tweets, users);
    return statusResponse(500);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feeds = await service.getAccountFeeds(["alpha", "beta"]);

    assert.equal(feeds.get("alpha").dataState, "live");
    assert.equal(feeds.get("beta").dataState, "unavailable");
  });
});

test("syndication fallback is bounded, so 22 accounts cannot storm it at once", async () => {
  const handles = Array.from({ length: 12 }, (unused, i) => `acct${i}`);
  let active = 0;
  let maxActive = 0;

  const respond = async (url) => {
    if (isSearch(url)) return statusResponse(401);
    if (!isSyndication(url)) return statusResponse(500);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    const handle = decodeURIComponent(url.split("screen-name/")[1].split("?")[0]);
    return syndicationResponse(handle, RECENT_ISO, "800");
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feeds = await service.getAccountFeeds(handles);

    assert.ok(maxActive <= 3, `syndication concurrency must stay bounded, saw ${maxActive}`);
    assert.equal(feeds.get("acct0").dataState, "degraded");
  });
});

test("a syndication 429 opens its own cooldown instead of retrying every account", async () => {
  // More handles than the concurrency cap on purpose: the first wave is
  // already in flight when the 429 lands, so what the cooldown has to prevent
  // is every *subsequent* account repeating the same doomed request.
  const handles = Array.from({ length: 12 }, (unused, i) => `acct${i}`);
  const respond = (url) => (isSearch(url) ? statusResponse(401) : statusResponse(429));

  await withMockedApi(respond, async (requestedUrls) => {
    const service = new XFeedService({ cache: new MemoryCache() });
    await service.getAccountFeeds(handles);

    assert.equal(service.providerHealth().syndication.open, true);
    const attempted = requestedUrls.filter(isSyndication).length;
    assert.ok(
      attempted <= 3,
      `the cooldown must stop the storm after the first wave, saw ${attempted} requests`,
    );
  });
});

/* ── Freshness is not post age ─────────────────────────────────────────── */

test("a quiet account that was checked successfully is live, however old its newest post", async () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const tweets = [{ id: "500", text: "posted ten days ago", author_id: "u1", created_at: tenDaysAgo }];
  const users = [{ id: "u1", username: "alpha" }];

  await withMockedApi(apiResponse(tweets, users), async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feed = await service.getAccountFeed("alpha");

    assert.equal(feed.dataState, "live", "old content is not a stale provider");
    assert.equal(feed.stale, false);
    assert.equal(feed.newestPostAt, tenDaysAgo);
    assert.ok(
      new Date(feed.lastSuccessfulFetchAt).getTime() > new Date(tenDaysAgo).getTime(),
      "the check is recent even though the post is not",
    );
  });
});

test("an archival feed is labelled by content age without being downgraded", async () => {
  const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const respond = (url) => {
    if (isSearch(url) || isUserLookup(url) || isTimeline(url)) return statusResponse(500);
    if (isSyndication(url)) return syndicationResponse("alpha", longAgo, "600");
    return statusResponse(500);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    const feed = await service.getAccountFeed("alpha");

    // Previously this threw: a 60-day-old post was treated as a stale feed.
    assert.equal(feed.archival, true, "content is flagged as archival");
    assert.equal(feed.dataState, "degraded", "but the data itself was just confirmed");
    assert.equal(feed.stale, false);
  });
});

test("an empty incremental response keeps the feed live rather than marking it stale", async () => {
  await withMockedApi(apiResponse([], []), async () => {
    const cache = new MemoryCache();
    seedLastKnownGood(cache, "alpha", [
      { id: "100", text: "older post", url: "https://x.com/alpha/status/100", publishedAt: RECENT_ISO },
    ]);
    const service = new XFeedService({ cache });
    const feed = await service.getAccountFeed("alpha");

    assert.equal(feed.dataState, "live");
    assert.equal(feed.provider, "x-api");
    assert.ok(feed.lastSuccessfulFetchAt);
  });
});

/* ── Cache migration must fail closed ──────────────────────────────────── */

test("a pre-schema persisted cache entry is never served as live", async () => {
  // Exactly what a deploy leaves behind: an entry written by the previous
  // version, still inside its TTL, carrying no provenance at all.
  const legacyFeed = {
    handle: "alpha",
    source: "api",
    posts: [{ id: "100", text: "from before the deploy", url: "https://x.com/alpha/status/100", publishedAt: RECENT_ISO }],
  };
  const tweets = [{ id: "200", text: "freshly fetched", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];

  await withMockedApi(apiResponse(tweets, users), async (requestedUrls) => {
    const cache = new MemoryCache();
    cache.set("x:feed:alpha", legacyFeed, 15 * 60 * 1000);
    const service = new XFeedService({ cache });
    const feed = await service.getAccountFeed("alpha");

    assert.ok(requestedUrls.length > 0, "a legacy entry forces a refresh instead of being served");
    assert.equal(feed.schemaVersion, 2);
    assert.ok(
      feed.posts.some((post) => post.id === "200"),
      "the refreshed feed is what gets served",
    );
  });
});

test("worstDataState and safeDataState treat an unknown state as unavailable", () => {
  assert.equal(worstDataState(["live", "live"]), "live");
  assert.equal(worstDataState(["live", "degraded"]), "degraded");
  assert.equal(worstDataState(["live", undefined]), "unavailable");
  assert.equal(worstDataState(["live", "something-new"]), "unavailable");

  // A legacy feed with posts but no provenance: stale, never live.
  assert.equal(safeDataState({ posts: [{ id: "1" }] }), "stale");
  assert.equal(safeDataState({ posts: [] }), "unavailable");
  assert.equal(safeDataState({ posts: [{ id: "1" }], dataState: "live" }), "stale", "no schemaVersion, no trust");
  assert.equal(safeDataState({ posts: [{ id: "1" }], dataState: "live", schemaVersion: 2 }), "live");
});

test("an expired circuit reports healthy again rather than replaying its last failure", async () => {
  const tweets = [{ id: "800", text: "recovered", author_id: "u1", created_at: RECENT_ISO }];
  const users = [{ id: "u1", username: "alpha" }];
  let repaired = false;
  const respond = (url) => {
    if (isSearch(url)) return repaired ? apiResponse(tweets, users) : statusResponse(401);
    return statusResponse(503);
  };

  await withMockedApi(respond, async () => {
    const service = new XFeedService({ cache: new MemoryCache() });
    await service.getAccountFeeds(["alpha"]);
    assert.equal(service.providerHealth().official.open, true);

    // Simulate the cooldown elapsing rather than an operator resetting it.
    service._officialCircuit._openUntil = Date.now() - 1000;
    repaired = true;
    await service.getAccountFeed("alpha");

    const health = service.providerHealth().official;
    assert.equal(health.open, false);
    assert.equal(health.state, null, "current state is not the failure that opened it");
    assert.equal(health.reason, null);
    assert.equal(health.lastFailure, null, "a successful request clears the stale failure");
  });
});
