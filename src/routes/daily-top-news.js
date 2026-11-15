"use strict";

const express = require("express");
const { buildDailyTopNews } = require("../services/daily-top-news");

/**
 * GET  /api/daily-top-news?date=YYYY-MM-DD&tz=<IANA zone>
 *      The day's Economics, Stocks and Crypto top stories, gathered from what
 *      the phone Shortcut and the Reporter Room already made. Read-only.
 * GET  /api/daily-top-news/farmbot?date=YYYY-MM-DD
 *      The receipt for the day's Top 10 sent to FarmBot, if any.
 * POST /api/daily-top-news/farmbot   (admin key; OpenAI credits)
 *      Merge today's desks into a Top 10 and send it to FarmBot as one batch
 *      for human approval. Body: { tz?, runs?: { economics, stocks, crypto } }.
 *
 * All of it sits behind the site login like the briefing pages.
 */
function createDailyTopNewsRouter({ briefingStore, reporterService, farmbotTop10 = null, requireAdmin = null }) {
  const router = express.Router();
  const json = express.json({ limit: "16kb" });

  router.get("/farmbot", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!farmbotTop10) {
        res.json({ configured: false, missing: ["FarmBot Top 10 is not set up"], running: false, slip: null });
        return;
      }
      const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
      res.json(farmbotTop10.status(date));
    } catch (err) {
      next(err);
    }
  });

  if (farmbotTop10 && requireAdmin) {
    router.post("/farmbot", requireAdmin, json, async (req, res, next) => {
      try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const runs = body.runs && typeof body.runs === "object" ? body.runs : {};
        const slip = await farmbotTop10.send({
          timeZone: typeof body.tz === "string" ? body.tz : undefined,
          runIds: {
            economics: typeof runs.economics === "string" ? runs.economics : undefined,
            stocks: typeof runs.stocks === "string" ? runs.stocks : undefined,
            crypto: typeof runs.crypto === "string" ? runs.crypto : undefined,
          },
        });
        res.status(slip.outcome === "sent" ? 201 : 200).json({ slip });
      } catch (err) {
        if (err.expose) {
          res.status(err.statusCode || 500).json({ error: err.message });
          return;
        }
        next(err);
      }
    });
  }

  router.get("/", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(buildDailyTopNews({
        briefingStore,
        reporterService,
        date: typeof req.query.date === "string" ? req.query.date : undefined,
        timeZone: typeof req.query.tz === "string" ? req.query.tz : undefined,
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDailyTopNewsRouter };
