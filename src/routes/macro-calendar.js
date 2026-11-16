"use strict";

const express = require("express");

// Main Hub reads the reporter's calendar without a browser session. Return
// only event fields and a fallback label; provider URLs and diagnostics stay here.
function createMacroCalendarRouter({ marketDataService, cache }) {
  const router = express.Router();
  router.get("/", async (req, res, next) => {
    try {
      const payload = await cache.getOrLoad("macro-calendar", 60_000, async () => {
        const calendar = await marketDataService.getCalendar();
        return {
          status: "ok",
          fallback: !calendar.live,
          timezone: calendar.timezone || "UTC",
          events: (calendar.items || []).slice(0, 8).map(item => ({
            title: item.title,
            time: item.time,
            at: item.at,
            timezone: item.timezone,
            precision: item.precision,
            impact: item.impact,
          })),
        };
      });
      res.set("Cache-Control", "no-store");
      res.json(payload);
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { createMacroCalendarRouter };
