const express = require("express");

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

function createXFeedRouter({ xFeedService, accounts }) {
  const router = express.Router();

  router.get(
    "/accounts",
    asyncRoute(async (req, res) => {
      const feeds = await xFeedService.getAccountFeeds(accounts.map((account) => account.handle));

      const payload = accounts.map((account) => {
        const feed = feeds.get(account.handle);

        if (feed && !feed.error) {
          return {
            handle: account.handle,
            label: account.label,
            category: account.category,
            posts: feed.posts,
            source: feed.source || "api",
            stale: Boolean(feed.stale),
          };
        }

        return {
          handle: account.handle,
          label: account.label,
          category: account.category,
          error: feed?.error || "Failed to load feed",
        };
      });

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

      res.json({
        posts,
        failedFeeds: payload.filter((account) => account.error),
        accounts: payload,
      });
    }),
  );

  return router;
}

module.exports = { createXFeedRouter };
