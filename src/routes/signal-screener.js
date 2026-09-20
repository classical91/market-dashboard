const { Router } = require("express");

function createSignalScreenerRouter({ signalScreenerService, usdtDominanceService = null }) {
  const router = Router();

  // Read-only, unauthenticated — public market data only, no API spend to guard.
  router.get("/", async (req, res, next) => {
    try {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      const minChecks = Math.min(Math.max(parseInt(req.query.minChecks, 10) || 4, 3), 6);
      const force = req.query.force === "true" || req.query.force === "1";
      const results = await signalScreenerService.scanAll(interval, minChecks, { force });
      // Market context rides along so the page makes one request, and a
      // dominance provider outage degrades the context row rather than the
      // screener it sits above.
      const context = { usdtDominance: null };
      if (usdtDominanceService) {
        try {
          context.usdtDominance = await usdtDominanceService.read();
        } catch (err) {
          context.usdtDominance = { symbol: "USDT.D", percent: null, error: err.message };
        }
      }
      res.json({ interval, minChecks, results, context });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSignalScreenerRouter };
