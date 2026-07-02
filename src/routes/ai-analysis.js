const { Router } = require("express");

function createAIAnalysisRouter({ aiAnalysisService }) {
  const router = Router();

  function resolveTtlMs(req) {
    const minutes = Math.min(Math.max(parseInt(req.query.ttlMinutes, 10) || 30, 1), 1440);
    return minutes * 60 * 1000;
  }

  // Read-only: returns cached analyses for every configured symbol, never generates.
  router.get("/", (req, res) => {
    res.json({
      configured: aiAnalysisService.isConfigured(),
      presets: aiAnalysisService.peekAll(),
    });
  });

  // Explicit generation — triggered only by a user action.
  router.post("/generate", async (req, res, next) => {
    try {
      const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
      const interval = typeof req.body?.interval === "string" ? req.body.interval.trim() : "";
      if (!symbol || !interval) {
        res.status(400).json({ error: "symbol and interval are required" });
        return;
      }
      const result = await aiAnalysisService.generate(symbol, interval, resolveTtlMs(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAIAnalysisRouter };
