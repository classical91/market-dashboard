const { Router } = require("express");

function createPatternScannerRouter({ patternScannerService, aiAnalysisService }) {
  const router = Router();

  // Read-only, unauthenticated: scans public market data only, no API spend
  // to guard (unlike /api/ai-analysis and /api/layout-analysis, which spend
  // OpenAI/capture credits and are admin-gated).
  router.get("/", async (req, res, next) => {
    try {
      const force = req.query.force === "true" || req.query.force === "1";
      const results = await patternScannerService.scanAll(aiAnalysisService.presets, { force });
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPatternScannerRouter };
