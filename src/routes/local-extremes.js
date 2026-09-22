const { Router } = require("express");

// The Local Extremes screener: "is price stretched toward a local top or
// bottom?".
//
// This is location, not direction, and the two are never merged: a confirmed
// top inside a bullish trend is a legitimate reading, not a contradiction to
// be resolved. local-extreme-engine.js remains the only place the scoring
// happens — SignalScreenerService already calls it per row, and this route
// serves the projection of that same cached scan.
function createLocalExtremesRouter({
  signalScreenerService,
  // Which tokens this screener scans, set from the Settings page. Optional so
  // an embedder (and every existing test) still gets the screener's own
  // default universe when no store is wired up.
  screenerSettingsService = null,
}) {
  const router = Router();

  // Read-only, unauthenticated, for the same reason the other scanner reads
  // are: public market data, no API spend to guard.
  router.get("/", async (req, res, next) => {
    try {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      // Kept on the same default as the Directional Bias route so both pages
      // hit the same cache entry per symbol + interval rather than provoking
      // a second upstream scan of the same candles.
      const minChecks = Math.min(Math.max(parseInt(req.query.minChecks, 10) || 4, 3), 6);
      const force = req.query.force === "true" || req.query.force === "1";
      // Independent of the Directional Bias universe even though the engine
      // behind both is the same: a symbol on both lists is still scanned once
      // per interval, because the cache key is the symbol, not the page.
      const symbols = screenerSettingsService
        ? screenerSettingsService.getUniverse("localExtremes")
        : undefined;
      const results = await signalScreenerService.scanLocalExtremes(interval, minChecks, { force, symbols });
      res.json({ interval, minChecks, results, updatedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createLocalExtremesRouter };
