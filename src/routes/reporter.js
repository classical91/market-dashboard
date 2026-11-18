const { Router } = require("express");
const { broadcastReportSections } = require("../services/report-broadcast");
const { looksLikeRefusal } = require("../services/reporter");

function createReporterRouter({ reporterService, telegramService, broadcastLedgerStore, requireAdmin }) {
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

  // The desk pages send their built-in crypto-news prompt as a fallback: a
  // prompt saved for the desk in Settings → Briefing AI replaces it.
  function promptIsFallback(req) {
    return req.body?.promptIsFallback === true;
  }

  // Read-only: returns the cached report if present, never generates.
  router.get("/", (req, res, next) => {
    try {
      res.json(reporterService.peekReport(resolveTtlMs(req)));
    } catch (err) {
      next(err);
    }
  });

  // Read-only: one section's recent generations, newest first, for the desk
  // pages' run picker. Prompt bodies stay in the log and are not returned.
  // `fields=meta` leaves out the report text too: Main Hub only needs to know
  // when each desk was written.
  router.get("/generations", (req, res, next) => {
    try {
      const section = String(req.query.section || "").toLowerCase();
      if (!reporterService.sections.includes(section)) {
        res.status(400).json({ error: "Unknown section." });
        return;
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
      const metaOnly = String(req.query.fields || "").toLowerCase() === "meta";
      res.setHeader("Cache-Control", "no-store");
      res.json({
        section,
        generations: reporterService.listGenerations({ section, limit }).map((entry) => {
          const run = {
            generatedAt: entry.generatedAt,
            model: entry.model || null,
            customPrompt: Boolean(entry.prompt),
            // The model answered without a briefing; the desk page warns and
            // offers a rerun, which the daily limit does not block.
            noBriefing: looksLikeRefusal(entry.content, entry.sources),
          };
          if (metaOnly) run.chars = typeof entry.content === "string" ? entry.content.length : 0;
          else run.content = entry.content;
          return run;
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  // Explicit generation — triggered only by a user action. Admin-guarded
  // because it spends OpenAI credits.
  router.post("/generate", requireAdmin, async (req, res, next) => {
    try {
      const report = await reporterService.generateReport(resolveTtlMs(req), resolveSection(req), resolvePrompt(req), {
        promptIsFallback: promptIsFallback(req),
      });
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
      if (!report.geopolitics && !report.economics && !report.markets && !report.crypto) {
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
      // Each category is sent and receipted independently — see
      // services/report-broadcast.js, which the scheduled newsroom cycle shares
      // with this route so both senders honour the same per-category receipts
      // and idempotency keys. `continueOnError` stays off here: an interactive
      // broadcast that fails should surface as an error response rather than
      // reporting ok with a hole in it.
      const { receipts, destinations, skipped } = await broadcastReportSections({
        report,
        telegramService,
        broadcastLedgerStore,
        source: "dashboard",
        actor: "dashboard",
      });
      if (!receipts.length && skipped.length) {
        res.status(400).json({
          error: `None of the saved desks is set to go to Telegram (${skipped.join(", ")} are switched off in Settings → Telegram → News Category Routing).`,
          skipped,
        });
        return;
      }

      res.json({
        ok: true,
        channelCount: telegramService._chatIds.length,
        broadcastAt: reporterService.markBroadcasted(),
        // Kept for older clients that read a single receipt; `receipts` is the
        // full per-category record.
        receiptId: receipts.length ? receipts[0].id : null,
        status: receipts.length ? receipts[0].status : null,
        receipts: receipts.map((r) => ({ id: r.id, newsType: r.newsType, status: r.status })),
        destinations,
        skipped,
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
