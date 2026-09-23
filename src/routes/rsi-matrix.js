const { Router } = require("express");

/**
 * TradeHunter → Screeners → RSI Matrix.
 *
 *   GET    /api/rsi-matrix                        the matrix (?force=1 = Refresh)
 *   GET    /api/rsi-matrix/settings               instruments, groups, providers, timeframes
 *   PUT    /api/rsi-matrix/settings               reorder / edit / enable, timeframes   (admin)
 *   POST   /api/rsi-matrix/settings/instruments   add a user instrument                  (admin)
 *   DELETE /api/rsi-matrix/settings/instruments/:id                                      (admin)
 *   POST   /api/rsi-matrix/settings/reset                                                (admin)
 *
 * Reads are open like every other screener: public market data, and no key
 * of any kind is in either response. Writes change what the whole deployment
 * shows, so they are admin-gated the same way the token-universe settings are.
 *
 * `force` is advisory: the service honours at most one forced pass per minute
 * across all viewers, so the Refresh button cannot become a request storm.
 */
function createRsiMatrixRouter({ rsiMatrixService, rsiMatrixSettingsService, requireAdmin }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const force = req.query.force === "true" || req.query.force === "1";
      res.json(await rsiMatrixService.getMatrix({ force }));
    } catch (err) {
      next(err);
    }
  });

  router.get("/settings", (req, res, next) => {
    try {
      res.json(rsiMatrixSettingsService.snapshot());
    } catch (err) {
      next(err);
    }
  });

  router.put("/settings", requireAdmin, async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      res.json(await rsiMatrixSettingsService.save({ instruments: body.instruments, timeframes: body.timeframes }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/settings/instruments", requireAdmin, async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      res.json(
        await rsiMatrixSettingsService.addInstrument({
          label: body.label,
          group: body.group,
          provider: body.provider,
          providerSymbol: body.providerSymbol,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.delete("/settings/instruments/:id", requireAdmin, (req, res, next) => {
    try {
      res.json(rsiMatrixSettingsService.removeInstrument(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post("/settings/reset", requireAdmin, (req, res, next) => {
    try {
      res.json(rsiMatrixSettingsService.reset());
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createRsiMatrixRouter };
