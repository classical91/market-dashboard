const { Router } = require("express");

// Cross-Market Open Interest: weekly CFTC open interest and speculator
// positioning for futures across indexes, FX, metals, energy, rates and
// crypto. Weekly from the CFTC (free); Daily from Databento when a key is
// configured. Both keys stay on the server and never appear in a response.
function createCrossMarketOiRouter({ crossMarketOiService }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const timeframe = req.query.timeframe === "D" ? "D" : "W";
      const lookback = typeof req.query.lookback === "string" ? req.query.lookback : undefined;
      const force = req.query.force === "true" || req.query.force === "1";
      res.setHeader("Cache-Control", "no-store");
      res.json(await crossMarketOiService.snapshot({ timeframe, lookback, force }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createCrossMarketOiRouter };
