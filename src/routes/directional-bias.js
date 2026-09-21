const { Router } = require("express");

// The Directional Bias screener: "which way is the market leaning?".
//
// It runs no calculations of its own. SignalScreenerService owns the six-check
// confluence maths; this route asks it for the projection and answers with the
// dashboard's vocabulary (BULLISH / BEARISH / NEUTRAL) already applied
// server-side, so every front end says the same thing about the same row.
function createDirectionalBiasRouter({ signalScreenerService, usdtDominanceService = null }) {
  const router = Router();

  // Read-only, unauthenticated — the same public market data /api/signal-screener
  // already serves, in a different shape. No API spend to guard.
  router.get("/", async (req, res, next) => {
    try {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      const minChecks = Math.min(Math.max(parseInt(req.query.minChecks, 10) || 4, 3), 6);
      const force = req.query.force === "true" || req.query.force === "1";
      const results = await signalScreenerService.scanDirectionalBias(interval, minChecks, { force });
      // USDT.D rides along as market context, the way it does on the screener:
      // the page makes one request, and a dominance provider outage degrades
      // the context row rather than the scan it sits above.
      const context = { usdtDominance: null };
      if (usdtDominanceService) {
        try {
          context.usdtDominance = await usdtDominanceService.read();
        } catch (err) {
          context.usdtDominance = { symbol: "USDT.D", percent: null, error: err.message };
        }
      }
      // updatedAt is when this response was assembled — deliberately not a
      // claim about the data, which carries its own per-row freshness.
      res.json({ interval, minChecks, results, context, updatedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDirectionalBiasRouter };
