const { Router } = require("express");

// Open Interest Intelligence: "is money entering or leaving futures
// positions, where, and does it confirm price?".
//
// Read-only and unauthenticated like the other screener reads: public venue
// data, no keys, no spend. The venues are called server-side only (see
// services/open-interest/providers.js), so the browser never hammers an
// exchange and nothing about the upstream calls reaches the client except
// the normalised result and its source/freshness labels.
function createOpenInterestRouter({ openInterestService }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const force = req.query.force === "true" || req.query.force === "1";
      const confluenceInterval = typeof req.query.confluence === "string" ? req.query.confluence : "4h";
      res.setHeader("Cache-Control", "no-store");
      res.json(await openInterestService.snapshot({ force, confluenceInterval }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:symbol", async (req, res, next) => {
    try {
      const force = req.query.force === "true" || req.query.force === "1";
      const interval = typeof req.query.interval === "string" ? req.query.interval : "1h";
      res.setHeader("Cache-Control", "no-store");
      res.json(await openInterestService.detail(req.params.symbol, { interval, force }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createOpenInterestRouter };
