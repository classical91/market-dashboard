"use strict";

const { compareEvents, normalizeCalendar, dayKey, addDays, isValidTimeZone, clockInZone, releaseStatus } = require("./calendar-normalize");

const REASONS = {
  "not-configured": "No economic calendar provider is configured.",
  "invalid-shape": "Provider did not return an array of events.",
  "invalid-events": "Provider returned no usable dated events.",
  "rate-limited": "Calendar provider rate limit reached.",
  "request-failed": "Calendar provider could not be reached.",
  timeout: "Calendar provider request timed out.",
};

// Trading Economics documents Date as UTC (even without Z), Importance as
// 1/2/3 and DateSpan=1 as estimated. Never turn an estimated release into exact.
function providerRows(payload, provider) {
  const rows = Array.isArray(payload) ? payload : payload?.events ?? payload?.items ?? payload?.data;
  if (!Array.isArray(rows)) return null;
  if (provider !== "tradingeconomics") return rows;
  return rows.map(row => {
    if (!row || typeof row !== "object") return null;
    const date = String(row.Date || "");
    return {
      id: row.CalendarID ?? row.CalendarId, title: row.Event, country: row.Country,
      date: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(date) ? date + "Z" : date,
      impact: row.Importance, forecast: row.Forecast, previous: row.Previous, actual: row.Actual,
      precision: String(row.DateSpan) === "0" ? "exact" : "assumed",
    };
  });
}

class MacroCalendarService {
  constructor({ config, fetchJson }) {
    this.config = config;
    this.fetchJson = fetchJson;
    this.good = null;
    this.inflight = null;
    this.retryAt = 0;
    this.reason = null;
    this.ttl = Math.max(60_000, Math.min(900_000, Number(config.calendarCacheMs) || 300_000));
    this.maxAge = Math.max(this.ttl, Math.min(3_600_000, Number(config.calendarStaleMs) || 1_800_000));
  }

  async refresh(now) {
    const c = this.config;
    const from = addDays(dayKey(now, "UTC"), -7);
    const to = addDays(from, 21);
    const provider = c.calendarProvider;
    const source = provider === "tradingeconomics" ? "Trading Economics" : c.calendarSource || "Configured calendar feed";
    let urls = [c.calendarUrl, c.calendarNextUrl].filter(Boolean);
    if (provider === "tradingeconomics" && c.calendarApiKey && !c.calendarUrl) {
      const url = new URL(`https://api.tradingeconomics.com/calendar/country/All/${from}/${to}`);
      url.searchParams.set("c", c.calendarApiKey);
      url.searchParams.set("f", "json");
      urls = [url.href];
    }
    if (!urls.length) { this.reason = "not-configured"; return; }
    try {
      const rows = [];
      // At most two configured feeds; all consumers share this one read. An
      // incomplete multi-feed read is stale, never a healthy empty next week.
      for (const url of urls) {
        const payload = await this.fetchJson(url.replaceAll("{from}", from).replaceAll("{to}", to));
        const entries = providerRows(payload, provider);
        if (!entries) throw Object.assign(new Error(), { calendarReason: "invalid-shape" });
        rows.push(...entries);
      }
      const normalized = normalizeCalendar(rows, { startDate: from, days: 22, timezone: c.calendarTimezone, now, source });
      if (normalized.reason === "invalid-events") throw Object.assign(new Error(), { calendarReason: "invalid-events" });
      this.good = { items: normalized.items, fetchedAt: now.toISOString(), expiresAt: new Date(+now + this.ttl).toISOString(), source, from, to };
      this.reason = null;
      this.retryAt = 0;
    } catch (error) {
      const status = error.statusCode || error.status;
      this.reason = error.calendarReason || (status === 429 ? "rate-limited" : status === 408 || error.name === "AbortError" ? "timeout" : "request-failed");
      // Honor Retry-After, including long waits, with a bounded one-hour hold.
      this.retryAt = +now + Math.max(60_000, Math.min(3_600_000, Number(error.retryAfterMs) || this.ttl));
    }
  }

  async get({ now = new Date(), days = 1, timezone, range = "" } = {}) {
    const c = this.config;
    const zone = isValidTimeZone(timezone) ? timezone : isValidTimeZone(c.calendarTimezone) ? c.calendarTimezone : "UTC";
    // Check expiration on every read. An outer route cache must never extend
    // freshness or prevent pruning yesterday's events after local midnight.
    if ((!this.good || +now >= Date.parse(this.good.expiresAt)) && +now >= this.retryAt) {
      if (!this.inflight) this.inflight = this.refresh(now).finally(() => { this.inflight = null; });
      await this.inflight;
    }
    const trustworthy = this.good && +now - Date.parse(this.good.fetchedAt) <= this.maxAge;
    const live = Boolean(trustworthy && !this.reason && +now < Date.parse(this.good.expiresAt));
    const stale = Boolean(trustworthy && !live);
    const today = dayKey(now, zone);
    const weekday = new Date(today + "T12:00:00Z").getUTCDay();
    const monday = addDays(today, -((weekday + 6) % 7));
    let from = today, to = addDays(today, Math.max(1, Math.min(14, Number(days) || 1)) - 1);
    if (range === "today") to = today;
    if (range === "tomorrow") from = to = addDays(today, 1);
    if (range === "week") { from = monday; to = addDays(monday, 6); }
    if (range === "nextweek") { from = addDays(monday, 7); to = addDays(monday, 13); }
    if (range === "all") { from = monday; to = addDays(today, 13); }
    const items = trustworthy ? this.good.items.map(item => {
      const date = item.at ? dayKey(new Date(item.at), zone) : item.date;
      return { ...item, date, timezone: zone, time: item.at ? clockInZone(new Date(item.at), zone) : "--", status: releaseStatus(item, now), stale };
    }).filter(item => item.date >= from && item.date <= to).sort(compareEvents) : [];
    return {
      live, stale, source: this.good?.source || (c.calendarProvider === "tradingeconomics" ? "Trading Economics" : c.calendarSource || "Configured calendar feed"),
      timezone: zone, items, reason: live ? null : this.reason || "request-failed",
      detail: live ? null : REASONS[this.reason] || REASONS["request-failed"],
      fetchedAt: this.good?.fetchedAt || null,
      expiresAt: live ? this.good.expiresAt : null,
      staleUntil: trustworthy ? new Date(Date.parse(this.good.fetchedAt) + this.maxAge).toISOString() : null,
      range: { from, to },
      timing: { total: items.length, exact: items.filter(x => x.precision === "exact").length, assumed: items.filter(x => x.precision === "assumed").length, untimed: items.filter(x => x.precision === "unknown").length },
    };
  }
}

module.exports = { MacroCalendarService, providerRows };
