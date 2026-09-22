const { Router } = require("express");

// Cross-Market Open Interest: weekly CFTC open interest and speculator
// positioning for futures across indexes, FX, metals, energy, rates and
// crypto. Read-only public data; the optional CFTC app token stays on the
// server and never appears in a response.
function createCrossMarketOiRouter({ crossMarketOiService }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const lookback = typeof req.query.lookback === "string" ? req.query.lookback : "1w";
      const force = req.query.force === "true" || req.query.force === "1";
      res.setHeader("Cache-Control", "no-store");
      res.json(await crossMarketOiService.snapshot({ lookback, force }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createCrossMarketOiRouter };
