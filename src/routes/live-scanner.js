"use strict";

const { Router } = require("express");

function createLiveScannerRouter({ liveScannerService, requireAdmin }) {
  const router = Router();

  // Read-only, unauthenticated like the other scanner reads: it exposes the
  // loop's own health (enabled, last scan, last candle, last signal, last
  // error) and public market data, and spends no API credits to serve.
  router.get("/status", (req, res) => {
    if (!liveScannerService) {
      res.json({ enabled: false, configured: false, reason: "Live scanner is not configured" });
      return;
    }
    res.json({ configured: true, ...liveScannerService.status() });
  });

  // Manual single scan, for verifying a deploy without waiting for the timer.
  // Admin-gated because it can open a paper position as a side effect, which
  // is a ledger write — the same bar the other mutation routes clear.
  router.post("/scan", requireAdmin, async (req, res, next) => {
    try {
      if (!liveScannerService) {
        res.status(503).json({ error: "Live scanner is not configured" });
        return;
      }
      const result = await liveScannerService.runOnce();
      res.json({ result, status: liveScannerService.status() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createLiveScannerRouter };
