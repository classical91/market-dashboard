const { Router } = require("express");

function createPatternScannerRouter({
  patternScannerService,
  // Which tokens this scanner covers, set from the Settings page. Optional so
  // an embedder (and every existing test) still gets the scanner's own
  // constructor universe when no store is wired up.
  screenerSettingsService = null,
}) {
  const router = Router();

  // Read-only, unauthenticated: scans public market data only, no API spend
  // to guard (unlike /api/ai-analysis and /api/layout-analysis, which spend
  // OpenAI/capture credits and are admin-gated).
  router.get("/", async (req, res, next) => {
    try {
      const force = req.query.force === "true" || req.query.force === "1";
      // The 1h / 4h / 1D sweep is unchanged; only which pairs it sweeps is
      // now configurable, and it is read per request so a save takes effect
      // on the next refresh rather than the next deploy.
      const symbols = screenerSettingsService
        ? screenerSettingsService.getUniverse("patternScanner")
        : undefined;
      const results = await patternScannerService.scanAll({ force, symbols });
      res.json({ intervals: patternScannerService.scanIntervals, results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPatternScannerRouter };
