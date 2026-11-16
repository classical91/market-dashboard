"use strict";
const express = require("express");
const { isValidTimeZone } = require("../services/calendar-normalize");

// The service owns caching for every consumer, so this route cannot extend a
// snapshot's freshness or cache yesterday's projection through midnight.
function createMacroCalendarRouter({ marketDataService }) {
  const router = express.Router();
  router.get("/", async (req, res, next) => {
    try {
      const timezone = req.query.timezone;
      const range = req.query.range || "";
      const days = req.query.days === undefined ? 1 : Number(req.query.days);
      if ((timezone !== undefined && (typeof timezone !== "string" || !isValidTimeZone(timezone))) ||
          !["", "today", "tomorrow", "week", "nextweek", "all"].includes(range) ||
          !Number.isInteger(days) || days < 1 || days > 14) {
        return res.status(400).json({ status: "error", message: "Invalid calendar timezone or date range." });
      }
      const calendar = await marketDataService.getCalendar({ days, timezone, range });
      const quality = calendar.live ? "live" : calendar.stale ? "stale" : "unavailable";
      res.set("Cache-Control", "no-store");
      res.json({
        status: calendar.live ? "ok" : quality,
        fallback: !calendar.live, stale: Boolean(calendar.stale), quality,
        timezone: calendar.timezone || "UTC", source: calendar.source,
        fetchedAt: calendar.fetchedAt || null, expiresAt: calendar.expiresAt || null,
        staleUntil: calendar.staleUntil || null, range: calendar.range,
        message: calendar.live ? null : calendar.stale ? "Stale calendar — showing last successful update." : "Live calendar unavailable",
        events: (calendar.items || []).map(item => ({
          id: item.id, date: item.date, title: item.title, country: item.country,
          time: item.time, at: item.at, timezone: item.timezone,
          precision: item.precision, verified: item.verified, impact: item.impact,
          forecast: item.forecast, previous: item.previous, actual: item.actual,
          status: item.status, source: item.source, stale: item.stale,
        })),
      });
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { createMacroCalendarRouter };
