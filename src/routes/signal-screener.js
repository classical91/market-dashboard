const { Router } = require("express");

function createSignalScreenerRouter({ signalScreenerService }) {
  const router = Router();

  // Read-only, unauthenticated — public market data only, no API spend to guard.
  router.get("/", async (req, res, next) => {
    try {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      const minChecks = Math.min(Math.max(parseInt(req.query.minChecks, 10) || 4, 3), 6);
      const force = req.query.force === "true" || req.query.force === "1";
      const results = await signalScreenerService.scanAll(interval, minChecks, { force });
      res.json({ interval, minChecks, results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSignalScreenerRouter };
