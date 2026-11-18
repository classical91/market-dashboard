"use strict";

const express = require("express");
const { buildDailyTopNews } = require("../services/daily-top-news");
const { recordTop10Run } = require("../services/top10-runs");

/**
 * GET  /api/daily-top-news?date=YYYY-MM-DD&tz=<IANA zone>
 *      The day's Economics, Stocks and Crypto top stories, gathered from what
 *      the phone Shortcut and the Reporter Room already made. Read-only.
 *      The Top 10 is built only from the day's recorded Run (`top10Run`).
 * POST /api/daily-top-news/run (admin key; no generation or sending)
 *      Record today's Run once Economics, Stocks and Crypto all have a report
 *      from today. 409 with `missing` names the desks that are not done.
 *      Body: { tz?, runs?: { economics, stocks, crypto } }.
 * GET  /api/daily-top-news/farmbot?date=YYYY-MM-DD
 *      The receipt for the day's Top 10 sent to FarmBot, if any.
 * POST /api/daily-top-news/intake (admin key; no generation or sending)
 *      Record the selected Top 10 as discovered, independently of FarmBot.
 * POST /api/daily-top-news/farmbot   (admin key; OpenAI credits)
 *      Merge today's desks into a Top 10 and send it to FarmBot as one batch
 *      for human approval. Body: { tz?, runs?: { economics, stocks, crypto } }.
 *
 * GET  /api/daily-top-news/farmbot/x-drafts?date=YYYY-MM-DD
 *      The engagement X drafts FarmBot wrote for the day's batch (newest day
 *      without `date`), for review in News Reporter.
 * POST /api/daily-top-news/farmbot/x-drafts          (admin; FarmBot AI credits)
 *      Ask FarmBot to write the drafts again. Body: { date }.
 * POST /api/daily-top-news/farmbot/x-drafts/review   (admin)
 *      Body: { date, itemId, decision: approved|rejected|pending, text? }.
 * POST /api/daily-top-news/farmbot/x-drafts/apply    (admin)
 *      Put approved drafts into a new revision of the FarmBot batch, which
 *      still needs approval in FarmBot. Body: { date }.
 *
 * All of it sits behind the site login like the briefing pages.
 */
function createDailyTopNewsRouter({ briefingStore, reporterService, runStore = null, farmbotTop10 = null, requireAdmin = null }) {
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

  function sendError(res, next, err) {
    if (err.expose) {
      res.status(err.statusCode || 500).json({ error: err.message, ...(err.missing ? { missing: err.missing } : {}) });
      return;
    }
    next(err);
  }

  if (runStore && requireAdmin) {
    router.post("/run", requireAdmin, json, (req, res, next) => {
      try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const runs = body.runs && typeof body.runs === "object" ? body.runs : {};
        const run = recordTop10Run({
          store: runStore, briefingStore, reporterService,
          timeZone: typeof body.tz === "string" ? body.tz : undefined,
          runIds: Object.fromEntries(["economics", "stocks", "crypto"]
            .filter((key) => typeof runs[key] === "string").map((key) => [key, runs[key]])),
        });
        res.status(201).json({ run });
      } catch (err) { sendError(res, next, err); }
    });
  }

  const dayParam = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

  router.get("/farmbot/x-drafts", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const drafts = farmbotTop10 && farmbotTop10.xDrafts;
      res.json({ available: Boolean(drafts), drafts: drafts ? drafts.current(dayParam(req.query.date)) : null });
    } catch (err) { next(err); }
  });

  if (farmbotTop10 && farmbotTop10.xDrafts && requireAdmin) {
    const drafts = farmbotTop10.xDrafts;
    const needDay = (body) => {
      const date = dayParam(body && body.date);
      if (!date) throw Object.assign(new Error("date (YYYY-MM-DD) is required"), { statusCode: 400, expose: true });
      return date;
    };
    router.post("/farmbot/x-drafts", requireAdmin, json, async (req, res, next) => {
      try { res.status(201).json({ drafts: await drafts.write({ date: needDay(req.body) }) }); } catch (err) { sendError(res, next, err); }
    });
    router.post("/farmbot/x-drafts/review", requireAdmin, json, (req, res, next) => {
      try {
        const body = req.body || {};
        res.json({ drafts: drafts.review({
          date: needDay(body), itemId: String(body.itemId || ""), decision: body.decision,
          text: typeof body.text === "string" ? body.text : undefined,
        }) });
      } catch (err) { sendError(res, next, err); }
    });
    router.post("/farmbot/x-drafts/apply", requireAdmin, json, async (req, res, next) => {
      try { res.json(await drafts.apply({ date: needDay(req.body) })); } catch (err) { sendError(res, next, err); }
    });
  }

  if (farmbotTop10 && requireAdmin) {
    router.post("/intake", requireAdmin, json, (req, res, next) => {
      try {
        const result = farmbotTop10.logCandidates({
          date: req.body?.date, timeZone: req.body?.tz, runIds: req.body?.runs,
        });
        res.json({ ok: true, logged: result.records.length, ids: result.records.map((record) => record.id) });
      } catch (err) { sendError(res, next, err); }
    });

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
      } catch (err) { sendError(res, next, err); }
    });
  }

  router.get("/", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(buildDailyTopNews({
        briefingStore,
        reporterService,
        runStore,
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
