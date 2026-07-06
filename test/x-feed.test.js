"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { XFeedService } = require("../src/services/x-feed");
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

function seedLastKnownGood(cache, handle, posts) {
  cache.set(`x:feed:latest:${handle}`, { handle, posts, source: "api" }, 60 * 60 * 1000);
}

const RECENT_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

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
