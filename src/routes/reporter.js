const { Router } = require("express");

function createReporterRouter({ reporterService, telegramService, requireAdmin }) {
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

  // Manually broadcast the current aggregate report (whichever sections have
  // saved content) to Telegram. Never generates anything itself — run
  // /generate for each section first. Admin-guarded because it pushes
  // messages to every configured channel.
  router.post("/broadcast", requireAdmin, async (req, res, next) => {
    try {
      if (!telegramService.configured) {
        res.status(400).json({ error: "Telegram is not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS)" });
        return;
      }
      const report = reporterService.peekReport(resolveTtlMs(req));
      if (!report.configured) {
        res.status(400).json({ error: "Reporter is not configured (set OPENAI_API_KEY)" });
        return;
      }
      if (!report.crypto && !report.economics && !report.markets) {
        res.status(400).json({ error: "No report to broadcast yet — generate at least one section first" });
        return;
      }
      const broadcastAt = reporterService.getBroadcastAt();
      if (broadcastAt && report.generatedAt && broadcastAt >= report.generatedAt) {
        res.status(409).json({
          error: "Already broadcast — generate a new section first",
          alreadyBroadcast: true,
          broadcastAt,
        });
        return;
      }
      await telegramService.postReport(report);
      res.json({
        ok: true,
        channelCount: telegramService._chatIds.length,
        broadcastAt: reporterService.markBroadcasted(),
      });
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
