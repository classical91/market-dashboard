const { Router } = require("express");

const { DEFAULT_PANELS, DEFAULT_TIMEFRAME, SOURCES, SYMBOLS, SYMBOL_GROUPS, TIMEFRAMES } = require("../config/market-matrix");

/**
 * TradeHunter → Market Matrix.
 *
 *   GET /api/market-matrix/config                         symbols, sources, timeframes, defaults
 *   GET /api/market-matrix/chart?symbol=BTC&tf=1h         one panel's candles (&force=1 = Refresh)
 *
 * Read-only public market data, open like the screeners. A source failure is
 * a 200 with `available: false` and the reason, so a panel can say exactly
 * why it is empty; only an unknown symbol or timeframe is a 400.
 */
function createMarketMatrixRouter({ marketMatrixService }) {
  const router = Router();

  router.get("/config", (req, res) => {
    res.json({
      defaults: { panels: DEFAULT_PANELS, timeframe: DEFAULT_TIMEFRAME },
      timeframes: TIMEFRAMES,
      groups: SYMBOL_GROUPS,
      symbols: SYMBOLS.map((s) => ({
        id: s.id,
        label: s.label,
        name: s.name,
        source: s.source,
        providerSymbol: s.providerSymbol,
        note: s.note || null,
        format: s.format,
        tvSymbol: s.tvSymbol || null,
        timeframes: SOURCES[s.source].timeframes,
      })),
      sources: Object.fromEntries(
        Object.entries(SOURCES).map(([id, s]) => [id, { label: s.label, detail: s.detail, sampled: s.sampled, timeframes: s.timeframes }]),
      ),
    });
  });

  router.get("/chart", async (req, res, next) => {
    try {
      const force = req.query.force === "1" || req.query.force === "true";
      res.json(await marketMatrixService.getChart({ symbol: req.query.symbol, timeframe: req.query.tf, force }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createMarketMatrixRouter };
