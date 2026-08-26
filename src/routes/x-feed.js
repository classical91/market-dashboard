const express = require("express");
const { DATA_STATES, worstDataState } = require("../services/x-feed");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sortByPublishedDateDesc(items) {
  return items.sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function newestIso(values) {
  const times = values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((time) => Number.isFinite(time));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * The response is authoritative about freshness so the client never has to
 * infer provider health from `posts.length`. Every account reports when it
 * was last checked, when it was last successfully fetched, and which provider
 * answered — separately from how old its newest post is.
 */
function describeAccount(account, feed) {
  const base = {
    handle: account.handle,
    label: account.label,
    category: account.category,
  };

  if (feed && !feed.error) {
    return {
      ...base,
      posts: feed.posts,
      source: feed.source || "api",
      provider: feed.provider || null,
      providerState: feed.providerState || null,
      dataState: feed.dataState || DATA_STATES.LIVE,
      lastCheckedAt: feed.lastAttemptAt || null,
      lastSuccessfulFetchAt: feed.lastSuccessfulFetchAt || null,
      newestPostAt: feed.newestPostAt || null,
      archival: Boolean(feed.archival),
      stale: Boolean(feed.stale),
      ...(feed.staleReason ? { staleReason: feed.staleReason } : {}),
    };
  }

  return {
    ...base,
    error: feed?.error || "Failed to load feed",
    provider: feed?.provider || null,
    providerState: feed?.providerState || null,
    dataState: DATA_STATES.UNAVAILABLE,
    lastCheckedAt: feed?.lastAttemptAt || null,
    lastSuccessfulFetchAt: feed?.lastSuccessfulFetchAt || null,
    newestPostAt: null,
  };
}

function createXFeedRouter({ xFeedService, accounts, requireAdmin }) {
  const router = express.Router();

  router.get(
    "/accounts",
    asyncRoute(async (req, res) => {
      const feeds = await xFeedService.getAccountFeeds(accounts.map((account) => account.handle));
      const payload = accounts.map((account) => describeAccount(account, feeds.get(account.handle)));

      const posts = sortByPublishedDateDesc(
        payload.flatMap((account) =>
          (account.posts || []).map((post) => ({
            ...post,
            handle: account.handle,
            label: account.label,
            category: account.category,
          })),
        ),
      );

      const counts = payload.reduce((acc, account) => {
        acc[account.dataState] = (acc[account.dataState] || 0) + 1;
        return acc;
      }, {});

      res.json({
        // Worst-of across accounts: the feed as a whole is only "live" when
        // every account was confirmed current on this refresh.
        status: worstDataState(payload.map((account) => account.dataState)),
        generatedAt: new Date().toISOString(),
        lastSuccessfulFetchAt: newestIso(payload.map((account) => account.lastSuccessfulFetchAt)),
        newestPostAt: newestIso(payload.map((account) => account.newestPostAt)),
        counts,
        providers: xFeedService.providerHealth(),
        posts,
        failedFeeds: payload.filter((account) => account.error),
        staleFeeds: payload.filter((account) => account.stale),
        accounts: payload,
      });
    }),
  );

  // Admin-only: reports provider health and where the persistent cache
  // actually lives, so a token failure can be told apart from a volume that
  // was never mounted. Never exposes the token itself.
  if (requireAdmin) {
    router.get(
      "/diagnostics",
      requireAdmin,
      asyncRoute(async (req, res) => {
        res.json({
          generatedAt: new Date().toISOString(),
          providers: xFeedService.providerHealth(),
          cache: xFeedService.cacheDiagnostics(),
        });
      }),
    );

    router.post(
      "/diagnostics/reset-circuits",
      requireAdmin,
      asyncRoute(async (req, res) => {
        res.json({ reset: true, providers: xFeedService.resetCircuits() });
      }),
    );
  }

  return router;
}

module.exports = { createXFeedRouter };
