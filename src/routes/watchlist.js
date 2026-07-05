const { Router } = require("express");

function createWatchlistRouter({ watchlistService, requireAdmin }) {
  const router = Router();

  // Read-only: no admin gate needed, mirrors the other public scanner reads.
  router.get("/", (req, res) => {
    res.json({ items: watchlistService.list() });
  });

  // Mutating — gated like every other state-changing route in this app,
  // even though it costs no external credits, so a public deploy can't have
  // its watchlist spammed/cleared by anonymous visitors.
  router.post("/", requireAdmin, (req, res) => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
    const interval = typeof req.body?.interval === "string" ? req.body.interval.trim() : "";
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    if (!symbol || !interval) {
      res.status(400).json({ error: "symbol and interval are required" });
      return;
    }
    res.json({ items: watchlistService.add(symbol, interval, label) });
  });

  router.delete("/", requireAdmin, (req, res) => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
    const interval = typeof req.body?.interval === "string" ? req.body.interval.trim() : "";
    if (!symbol || !interval) {
      res.status(400).json({ error: "symbol and interval are required" });
      return;
    }
    res.json({ items: watchlistService.remove(symbol, interval) });
  });

  return router;
}

module.exports = { createWatchlistRouter };
