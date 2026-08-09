const { Router } = require("express");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function createDecisionRouter({ decisionEngineService, tradeJournalService, requireAdmin, traderclaw = {} }) {
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

  router.get(
    "/traderclaw-edge",
    asyncRoute(async (req, res) => {
      if (!traderclaw.baseUrl) {
        res.json({ configured: false, bots: [], updatedAt: new Date().toISOString() });
        return;
      }

      const minTrades = Number.isFinite(Number(req.query.min_trades)) ? Number(req.query.min_trades) : 1;
      const endpoints = [
        { id: "main", name: "Main Account", path: "/api/strategy-metrics" },
        { id: "shadow", name: "Shadow SMC", path: "/api/shadow/strategy-metrics" },
        { id: "alts", name: "Alts", path: "/api/alts/strategy-metrics" },
      ];

      const bots = await Promise.all(endpoints.map(async (bot) => {
        const url = `${traderclaw.baseUrl}${bot.path}?min_trades=${encodeURIComponent(minTrades)}`;
        try {
          const data = await fetchJsonWithTimeout(url, traderclaw.requestTimeoutMs || 8000);
          return { ...bot, ok: true, summary: data.summary || {}, groups: data.groups || {} };
        } catch (err) {
          return { ...bot, ok: false, error: err.message };
        }
      }));

      res.json({ configured: true, baseUrl: traderclaw.baseUrl, minTrades, bots, updatedAt: new Date().toISOString() });
    }),
  );

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
