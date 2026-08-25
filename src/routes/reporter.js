const { Router } = require("express");
const { destinationsForNewsType } = require("../services/news-routing");
const { isPostedStatus } = require("../services/broadcast-ledger");

// The reporter's own section keys, mapped to the ledger's news categories.
// `markets` is the Stock category — the section key predates the category
// vocabulary and renaming it would rewrite stored reports.
const REPORT_CATEGORIES = [
  { key: "crypto", newsType: "Crypto" },
  { key: "markets", newsType: "Stock" },
  { key: "economics", newsType: "Economics" },
];

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
      // Each category is sent and receipted independently. The aggregate send
      // merged all three sections into one result set spanning every configured
      // chat, which meant a receipt could name destinations that a given
      // category never actually reached, and category identity survived only in
      // the message heading. One receipt per category keeps both exact.
      //
      // A pending receipt still goes in *before* each send, so a crash
      // mid-broadcast leaves a trace rather than a silent gap, and the
      // idempotency key is per category so a double-clicked Broadcast button
      // cannot fork the ledger or resend a category that already landed.
      const settings = broadcastLedgerStore ? broadcastLedgerStore.getSettings() : null;
      const stamp = report.generatedAt || report.dateStr || Date.now();
      const date = report.dateStr || new Date().toISOString().slice(0, 10);
      const sections = REPORT_CATEGORIES.filter((section) => report[section.key]);

      const receipts = [];
      const destinations = [];

      for (const section of sections) {
        const created = broadcastLedgerStore
          ? broadcastLedgerStore.createReceipt({
              source: "dashboard",
              kind: "digest",
              newsType: section.newsType,
              title: `${section.newsType} daily report — ${date}`,
              idempotencyKey: `digest:${section.newsType}:${stamp}`,
              text: report[section.key],
              // Deliberately no explicit status. A create with no destinations
              // already defaults to "pending", and a repeat under the same key
              // is an update — where an explicit "pending" would win outright
              // and walk an already-posted receipt back, re-sending a category
              // that had landed. Letting the status derive keeps the store's
              // own no-regression guard in force.
            })
          : null;
        const receipt = created ? created.receipt : null;

        // Already posted under this key: record it and move on rather than
        // sending the same category twice.
        if (receipt && created.created === false && isPostedStatus(receipt.status)) {
          receipts.push(receipt);
          destinations.push(...(receipt.destinations || []).map((d) => ({ ...d, newsType: section.newsType })));
          continue;
        }

        let result;
        try {
          result = await telegramService.postReportSection({
            newsType: section.newsType,
            text: report[section.key],
            date: report.dateStr,
            targets: destinationsForNewsType(section.newsType, settings),
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

        const sent = (result && result.destinations) || [];
        destinations.push(...sent.map((d) => ({ ...d, newsType: section.newsType })));
        if (receipt) {
          receipts.push(
            broadcastLedgerStore.updateReceipt(
              receipt.id,
              { destinations: sent, action: "broadcast" },
              { actor: "dashboard" },
            ),
          );
        }
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
