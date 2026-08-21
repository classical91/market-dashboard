const { Router } = require("express");

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

  router.get("/", (req, res, next) => {
    try {
      res.json(reporterService.peekReport(resolveTtlMs(req)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/generate", requireAdmin, async (req, res, next) => {
    try {
      const report = await reporterService.generateReport(resolveTtlMs(req), resolveSection(req), resolvePrompt(req));
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  // Each category is sent and receipted independently. That keeps category
  // identity exact and lets every receipt name only the destinations that
  // actually received that category.
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
        res.status(400).json({ error: "No report to broadcast yet - generate at least one section first" });
        return;
      }
      const broadcastAt = reporterService.getBroadcastAt();
      if (broadcastAt && report.generatedAt && broadcastAt >= report.generatedAt) {
        res.status(409).json({
          error: "Already broadcast - generate a new section first",
          alreadyBroadcast: true,
          broadcastAt,
        });
        return;
      }

      const sections = [
        { key: "crypto", newsType: "Crypto" },
        { key: "markets", newsType: "Stock" },
        { key: "economics", newsType: "Economics" },
      ].filter((section) => report[section.key]);
      const finalReceipts = [];
      const destinations = [];

      for (const section of sections) {
        const receiptResult = broadcastLedgerStore
          ? broadcastLedgerStore.createReceipt({
              source: "dashboard",
              kind: "digest",
              newsType: section.newsType,
              title: `${section.newsType} daily report - ${report.dateStr || new Date().toISOString().slice(0, 10)}`,
              idempotencyKey: `digest:${section.newsType}:${report.generatedAt || report.dateStr || Date.now()}`,
              text: report[section.key],
              status: "pending",
            })
          : null;
        const receipt = receiptResult ? receiptResult.receipt : null;
        if (receipt && receiptResult.created === false && ["posted", "partial"].includes(receipt.status)) {
          finalReceipts.push(receipt);
          destinations.push(...receipt.destinations.map((destination) => ({
            ...destination,
            newsType: section.newsType,
          })));
          continue;
        }

        let result;
        try {
          result = await telegramService.postReportSection({
            newsType: section.newsType,
            text: report[section.key],
            date: report.dateStr,
          });
        } catch (err) {
          if (receipt) {
            broadcastLedgerStore.updateReceipt(
              receipt.id,
              { status: "failed", error: err, destinations: err.destinations || [], action: "broadcast" },
              { actor: "dashboard" },
            );
          }
          throw err;
        }

        const actualDestinations = (result && result.destinations) || [];
        destinations.push(...actualDestinations.map((destination) => ({ ...destination, newsType: section.newsType })));
        if (receipt) {
          finalReceipts.push(broadcastLedgerStore.updateReceipt(
            receipt.id,
            { destinations: actualDestinations, action: "broadcast" },
            { actor: "dashboard" },
          ));
        }
      }

      res.json({
        ok: true,
        channelCount: telegramService.targetsForNewsType("Crypto").length,
        broadcastAt: reporterService.markBroadcasted(),
        receiptIds: finalReceipts.map((receipt) => receipt.id),
        statuses: finalReceipts.map((receipt) => ({ newsType: receipt.newsType, status: receipt.status })),
        destinations,
      });
    } catch (err) {
      next(err);
    }
  });

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
