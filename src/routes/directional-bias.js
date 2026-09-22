const { Router } = require("express");

// The Directional Bias screener: "which way is the market leaning?".
//
// It runs no calculations of its own. SignalScreenerService owns the six-check
// confluence maths; this route asks it for the projection and answers with the
// dashboard's vocabulary (BULLISH / BEARISH / NEUTRAL) already applied
// server-side, so every front end says the same thing about the same row.
function createDirectionalBiasRouter({
  signalScreenerService,
  usdtDominanceService = null,
  // Which tokens this screener scans, set from the Settings page. Optional so
  // an embedder (and every existing test) still gets the screener's own
  // default universe when no store is wired up.
  screenerSettingsService = null,
}) {
  const router = Router();

  // Read-only, unauthenticated — the same public market data /api/signal-screener
  // already serves, in a different shape. No API spend to guard.
  router.get("/", async (req, res, next) => {
    try {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      const minChecks = Math.min(Math.max(parseInt(req.query.minChecks, 10) || 4, 3), 6);
      const force = req.query.force === "true" || req.query.force === "1";
      // Read per request, not per boot: the universe is editable at runtime,
      // and a list captured at construction would go stale the moment it was
      // saved. Local Extremes reads its own list the same way — the two share
      // one engine and one candle cache, but not one universe.
      const symbols = screenerSettingsService
        ? screenerSettingsService.getUniverse("directionalBias")
        : undefined;
      const results = await signalScreenerService.scanDirectionalBias(interval, minChecks, { force, symbols });
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
