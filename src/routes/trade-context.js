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
      // updatedAt is when this response was assembled — deliberately not a
      // claim about the data, which carries its own age per card. A page that
      // only prints the response time makes cached evidence look current.
      const stale = cards.filter((card) => card.freshness && card.freshness.state === "STALE").length;
      res.json({ count: cards.length, stale, items, cards, updatedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createTradeContextRouter };
