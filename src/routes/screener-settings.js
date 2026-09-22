const { Router } = require("express");

/**
 * Settings → Screeners → Token Universe.
 *
 * The read is open to anyone who can already see the screener pages: it says
 * nothing the Directional Bias, Local Extremes and Pattern Scanner responses
 * don't already show by listing their rows.
 *
 * Every write is admin-gated. Changing what the scanners monitor changes what
 * the whole deployment reports and what the signal bot alerts on, which is an
 * owner decision — an Alpha visitor browsing the dashboard must not be able to
 * empty a screener for everybody.
 */
function createScreenerSettingsRouter({ screenerSettingsService, requireAdmin }) {
  const router = Router();

  router.get("/", (req, res, next) => {
    try {
      res.json(screenerSettingsService.snapshot());
    } catch (err) {
      next(err);
    }
  });

  // Replaces membership for the screeners named in the body. Only a subset of
  // the catalog is accepted — a symbol nobody has verified against Binance
  // gets added through POST /tokens, never as a side effect of a save.
  router.put("/", requireAdmin, (req, res, next) => {
    try {
      const universes = req.body && typeof req.body === "object" ? req.body.universes : null;
      res.json(screenerSettingsService.save(universes));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reset", requireAdmin, (req, res, next) => {
    try {
      res.json(screenerSettingsService.reset());
    } catch (err) {
      next(err);
    }
  });

  // Adds a Binance USDT spot pair to the catalog. `screeners` is optional and
  // defaults to every screener; the service verifies the pair returns market data
  // before anything is persisted.
  router.post("/tokens", requireAdmin, async (req, res, next) => {
    try {
      const symbol = req.body && typeof req.body.symbol === "string" ? req.body.symbol : "";
      const screeners = req.body && Array.isArray(req.body.screeners) ? req.body.screeners : undefined;
      res.json(await screenerSettingsService.addToken(symbol, { screeners }));
    } catch (err) {
      next(err);
    }
  });

  // Removes an operator-added pair from the catalog and every universe. A
  // catalog default is refused by the service — that one is unchecked, not
  // deleted.
  router.delete("/tokens/:symbol", requireAdmin, (req, res, next) => {
    try {
      res.json(screenerSettingsService.removeToken(req.params.symbol));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createScreenerSettingsRouter };
