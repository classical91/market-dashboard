const { Router } = require("express");

function createReporterRouter({ reporterService, requireAdmin }) {
  const router = Router();

  function resolveTtlMs(req) {
    const hours = Math.min(Math.max(parseInt(req.query.ttlHours, 10) || 24, 1), 168);
    return hours * 60 * 60 * 1000;
  }

  function resolveSection(req) {
    return String(req.query.section || "crypto").toLowerCase();
  }

  function resolvePrompt(req) {
    return typeof req.body?.prompt === "string" ? req.body.prompt : "";
  }

  // Read-only: returns the cached report if present, never generates.
  router.get("/", (req, res, next) => {
    try {
      res.json(reporterService.peekReport(resolveTtlMs(req)));
    } catch (err) {
      next(err);
    }
  });

  // Explicit generation — triggered only by a user action. Admin-guarded
  // because it spends OpenAI credits.
  router.post("/generate", requireAdmin, async (req, res, next) => {
    try {
      const report = await reporterService.generateReport(resolveTtlMs(req), resolveSection(req), resolvePrompt(req));
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // Import readable browser-backed logs into the server store so reports can
  // be shared across devices after a persistent volume is attached.
  // Admin-guarded because it writes into the shared server-side report store.
  router.post("/logs/import", requireAdmin, (req, res, next) => {
    try {
      const report = reporterService.importLogEntries(req.body?.entries, resolveTtlMs(req));
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createReporterRouter };
