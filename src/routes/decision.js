const { Router } = require("express");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createDecisionRouter({ decisionEngineService, tradeJournalService, requireAdmin }) {
  const router = Router();

  // Read-only, unauthenticated — public market data only, like the screener.
  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const interval = typeof req.query.interval === "string" ? req.query.interval : "4h";
      res.json(await decisionEngineService.getDecision(interval));
    }),
  );

  router.get("/journal", (req, res) => {
    res.json({ items: tradeJournalService.list(), stats: tradeJournalService.stats() });
  });

  // Mutating journal routes are admin-gated like the watchlist: no external
  // credits at stake, but a public deploy's journal must not be writable by
  // anonymous visitors.
  router.post("/journal", requireAdmin, (req, res, next) => {
    try {
      const item = tradeJournalService.log(req.body || {});
      res.status(201).json({ item, stats: tradeJournalService.stats() });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/journal/:id", requireAdmin, (req, res, next) => {
    try {
      const item = tradeJournalService.update(req.params.id, req.body || {});
      res.json({ item, stats: tradeJournalService.stats() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/journal/:id", requireAdmin, (req, res, next) => {
    try {
      const items = tradeJournalService.remove(req.params.id);
      res.json({ items, stats: tradeJournalService.stats() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDecisionRouter };
