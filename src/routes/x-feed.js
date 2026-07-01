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
      const results = await Promise.allSettled(
        accounts.map((account) => xFeedService.getAccountFeed(account.handle)),
      );

      const payload = accounts.map((account, index) => {
        const result = results[index];

        if (result.status === "fulfilled") {
          return {
            handle: account.handle,
            label: account.label,
            category: account.category,
            posts: result.value.posts,
          };
        }

        return {
          handle: account.handle,
          label: account.label,
          category: account.category,
          error: result.reason?.message || "Failed to load feed",
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
