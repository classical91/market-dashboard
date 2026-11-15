"use strict";

const express = require("express");
const { buildDailyTopNews } = require("../services/daily-top-news");

/**
 * GET /api/daily-top-news?date=YYYY-MM-DD&tz=<IANA zone>
 *
 * The day's Economics, Stocks and Crypto top stories, gathered from what the
 * phone Shortcut and the Reporter Room already made. Read-only; sits behind
 * the site login like the briefing pages.
 */
function createDailyTopNewsRouter({ briefingStore, reporterService }) {
  const router = express.Router();

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
