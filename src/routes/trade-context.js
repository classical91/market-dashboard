const { Router } = require("express");

function createTradeContextRouter({ tradeContextService }) {
  const router = Router();

  // Read-only, unauthenticated like the other scanner reads: it composes
  // cached results from engines that are already public, and mutating the
  // watchlist itself stays behind the admin gate on /api/watchlist.
  router.get("/", async (req, res, next) => {
    try {
      const force = req.query.force === "true" || req.query.force === "1";
      const { items, cards } = await tradeContextService.list({ force });
      res.json({ count: cards.length, items, cards, updatedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createTradeContextRouter };
