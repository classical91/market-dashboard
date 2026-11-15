"use strict";

const express = require("express");
const { broadcastReportSections } = require("../services/report-broadcast");
const { destinationsForNewsType } = require("../services/news-routing");

/**
 * Send one desk briefing to Telegram from its desk page.
 *
 *   GET  /api/desk-telegram         which desks may go to Telegram (Settings),
 *                                   and how many groups/topics each reaches.
 *                                   No chat ids: those stay in Settings.
 *   POST /api/desk-telegram/send    (admin key) { desk, runId } sends that run.
 *
 * The text is never taken from the browser: the run is looked up here, from
 * the phone briefing store or the Reporter Room's generation log. Delivery
 * goes through the same per-category sender, receipts and idempotency key as
 * the Reporter Room's Broadcast, so the same run is never posted twice.
 */

const DESKS = {
  geopolitics: { section: "geopolitics", newsType: "Geopolitics", label: "Geopolitics" },
  economics: { section: "economics", newsType: "Economics", label: "Economics" },
  stocks: { section: "markets", newsType: "Stock", label: "Stocks" },
  crypto: { section: "crypto", newsType: "Crypto", label: "Crypto" },
};

function createDeskTelegramRouter({ briefingStore, reporterService, telegramService, broadcastLedgerStore, requireAdmin }) {
  const router = express.Router();
  const json = express.json({ limit: "4kb" });

  function allowedDesks(settings) {
    return Array.isArray(settings && settings.telegramDesks) ? settings.telegramDesks : Object.values(DESKS).map((d) => d.newsType);
  }

  router.get("/", (req, res) => {
    const settings = broadcastLedgerStore ? broadcastLedgerStore.getSettings() : null;
    const allowed = allowedDesks(settings);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      telegramConfigured: Boolean(telegramService && telegramService.configured),
      desks: Object.fromEntries(Object.entries(DESKS).map(([key, desk]) => {
        const targets = destinationsForNewsType(desk.newsType, settings);
        return [key, {
          telegram: allowed.includes(desk.newsType),
          // null targets = the configured TELEGRAM_CHAT_IDS list.
          destinations: targets ? targets.length : (telegramService && telegramService._chatIds ? telegramService._chatIds.length : 0),
          usesDefaultChats: !targets,
        }];
      })),
    });
  });

  function resolveRun(deskKey, runId) {
    const desk = DESKS[deskKey];
    if (runId.startsWith("reporter-")) {
      const found = reporterService.getGenerationForReference({ section: desk.section, generatedAt: runId.slice("reporter-".length) });
      if (!found.ok) return null;
      return { text: found.generation.content, at: found.generation.generatedAt };
    }
    const entry = briefingStore.get(deskKey, runId);
    return entry ? { text: entry.text, at: entry.receivedAt } : null;
  }

  router.post("/send", requireAdmin, json, async (req, res, next) => {
    try {
      const deskKey = String(req.body?.desk || "").toLowerCase();
      const runId = typeof req.body?.runId === "string" ? req.body.runId.slice(0, 120) : "";
      const desk = DESKS[deskKey];
      if (!desk || !runId) {
        res.status(400).json({ error: "Send { desk, runId } for a desk briefing." });
        return;
      }
      if (!telegramService || !telegramService.configured) {
        res.status(400).json({ error: "Telegram is not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS)." });
        return;
      }
      const settings = broadcastLedgerStore ? broadcastLedgerStore.getSettings() : null;
      if (!allowedDesks(settings).includes(desk.newsType)) {
        res.status(403).json({ error: `${desk.label} is switched off for Telegram in Settings → Telegram → News Category Routing.` });
        return;
      }
      const run = resolveRun(deskKey, runId);
      if (!run) {
        res.status(404).json({ error: "That run was not found; reload the page and pick it again." });
        return;
      }
      const report = {
        [desk.section]: run.text,
        generatedAt: run.at,
        dateStr: new Date(run.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      };
      const { receipts, destinations, alreadyPosted } = await broadcastReportSections({
        report,
        telegramService,
        broadcastLedgerStore,
        source: "dashboard",
        actor: "desk-page",
      });
      const receipt = receipts[0] || null;
      res.json({
        ok: true,
        newsType: desk.newsType,
        alreadySent: alreadyPosted.includes(desk.newsType),
        receipt: receipt ? { id: receipt.id, status: receipt.status } : null,
        posted: destinations.filter((d) => d.status === "posted").length,
        failed: destinations.filter((d) => d.status === "failed").length,
        destinations: destinations.length,
      });
    } catch (err) {
      if (err.expose || err.statusCode) {
        res.status(err.statusCode || 502).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createDeskTelegramRouter, DESKS };
