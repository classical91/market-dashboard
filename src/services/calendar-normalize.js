"use strict";

// Macro calendar normalization — turning whatever a provider sends into an
// unambiguous instant.
//
// The decision engine gates news risk on "is a high-impact release inside the
// next 45 minutes?". That question only has an answer if an event is a real
// timestamp. The previous normalizer kept clock labels as supplied — "08:30",
// "14:00 ET" — and assessNewsRisk() compared those digits against UTC. A US
// feed publishing 08:30 ET was therefore read as 08:30 UTC, putting the
// blackout window four or five hours from where it belonged: a feed that was
// technically live, driving a news-risk verdict that was silently wrong.
//
// A full ISO datetime fared no better. It was truncated to HH:MM, throwing the
// date away, so yesterday's release looked exactly like today's.
//
// So every event resolves to `at` — a real UTC instant — or to null, which
// means "this feed did not say when". Null is a legitimate answer and is
// reported as such; what is not legitimate is inventing a time and letting a
// trading gate act on it.

// Common clock-label suffixes. Abbreviations are genuinely ambiguous (CST is
// US Central *and* China Standard), so this covers the ones a US/EU macro feed
// actually emits and nothing else. Anything unlisted falls back to the
// configured feed timezone rather than being guessed at.
const ZONE_ABBREVIATIONS = Object.freeze({
  UTC: "UTC",
  GMT: "UTC",
  Z: "UTC",
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  CT: "America/Chicago",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MT: "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  BST: "Europe/London",
  CET: "Europe/Berlin",
  CEST: "Europe/Berlin",
});

const IMPACTS = ["High", "Medium", "Low"];

function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset, in ms, that `timeZone` was at the given UTC instant.
 *
 * Derived by formatting the instant in that zone and reading the wall clock
 * back — the only way to get a historical/DST-correct offset without a
 * timezone library.
 */
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - utcMs;
}

/**
 * The UTC instant for a wall-clock time in a named zone.
 *
 * Applied twice because the offset itself depends on the instant: the first
 * pass can land on the wrong side of a DST boundary, and the second corrects
 * it. (A wall time inside a spring-forward gap does not exist; it resolves to
 * the instant just after the jump, which is the sane reading for a scheduled
 * economic release.)
 */
function wallClockToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(firstPass, timeZone);
}

/** The calendar date in `timeZone` at a given instant, as {year, month, day}. */
function datePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** "YYYY-MM-DD" in `timeZone`. */
function dayKey(date, timeZone) {
  const { year, month, day } = datePartsInZone(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "HH:MM" in `timeZone`. */
function clockInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Resolve one provider time value to an instant.
 *
 * Returns `{ at, precision }`:
 *   exact    — the feed stated its offset (Z, ±HH:MM) or gave an epoch, so the
 *              instant is the feed's own and no assumption was made.
 *   assumed  — the feed gave a wall-clock time and we supplied the zone, either
 *              from a recognised label suffix or from the configured default.
 *              Correct only insofar as that zone is correct.
 *   unknown  — nothing parseable. `at` is null.
 */
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(day, count) {
  return new Date(Date.parse(day + "T12:00:00Z") + count * 86400000).toISOString().slice(0, 10);
}

function resolveEventTime(value, { timezone = "UTC" } = {}) {
  const unknown = { at: null, precision: "unknown" };
  if (value == null) return unknown;
  if (typeof value === "number" && Number.isFinite(value)) {
    const at = new Date(Math.abs(value) < 1e12 ? value * 1000 : value);
    return Number.isFinite(at.getTime()) ? { at, precision: "exact" } : unknown;
  }
  const text = String(value).trim();
  if (/^\d{9,13}$/.test(text)) return resolveEventTime(Number(text));
  const day = text.slice(0, 10);
  if (!validDate(day)) return unknown; // Never assign today's date to a clock label.
  if (text === day) return { ...unknown, day };
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(text)) return { ...unknown, day };
  const clock = /[T ](\d{1,2}):(\d{2})/.exec(text);
  if (+clock[1] > 23 || +clock[2] > 59) return { ...unknown, day };
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const at = new Date(text.replace(" ", "T"));
    return Number.isFinite(at.getTime()) ? { at, precision: "exact" } : { ...unknown, day };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?: ([A-Za-z]{1,4}))?$/.exec(text);
  if (!match) return { ...unknown, day };
  const zone = match[6] ? ZONE_ABBREVIATIONS[match[6].toUpperCase()] : timezone;
  if (!isValidTimeZone(zone)) return { ...unknown, day };
  const at = new Date(wallClockToUtc({ year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5] }, zone));
  // A spring-forward gap is not a real wall clock time. Do not move it to a
  // different time and then present that new time as the provider's schedule.
  const expected = match[4].padStart(2, "0") + ":" + match[5];
  if (dayKey(at, zone) !== day || clockInZone(at, zone) !== expected) return { ...unknown, day };
  return { at, precision: "assumed" };
}

const COUNTRY_CODES = {
  USD: "US", USA: "US", "United States": "US", GBP: "GB", "United Kingdom": "GB",
  EUR: "EU", "Euro Area": "EU", JPY: "JP", Japan: "JP", CNY: "CN", China: "CN",
  CAD: "CA", Canada: "CA", AUD: "AU", Australia: "AU", NZD: "NZ", "New Zealand": "NZ",
  CHF: "CH", Switzerland: "CH", Germany: "DE", France: "FR", Italy: "IT", Spain: "ES",
};
const clean = (value, max = 120) => value == null ? null : String(value).trim().slice(0, max) || null;
const reportedValue = value => /^(null|undefined|n\/a|nan|--|-)$/i.test(String(value).trim()) ? null : clean(value, 60);
function releaseStatus(item, now = new Date()) {
  if (item.actual != null) return "Released";
  if (["Released", "Delayed", "Tentative"].includes(item.status)) return item.status;
  if (!item.at || item.precision !== "exact") return "Tentative";
  return Date.parse(item.at) <= now.getTime() ? "Delayed" : "Upcoming";
}

function compareEvents(a, b) {
  return a.date.localeCompare(b.date) || (a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : 0);
}

// All operational rows must carry a real date. Limits apply after date
// filtering and deduplication; a busy morning cannot hide an afternoon CPI.
function normalizeCalendar(data, { timezone = "UTC", now = new Date(), days = 1, startDate, limit = 2000, source = "Configured calendar feed" } = {}) {
  const zone = isValidTimeZone(timezone) ? timezone : "UTC";
  const rows = Array.isArray(data) ? data : data?.events ?? data?.items ?? data?.data;
  if (!Array.isArray(rows)) return { items: [], reason: "invalid-shape", dropped: 0 };
  const from = startDate || dayKey(now, zone);
  const to = addDays(from, Math.max(1, Math.min(31, Number(days) || 1)) - 1);
  let dropped = 0, invalid = 0;
  const unique = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") { invalid++; continue; }
    const title = clean(row.title || row.event || row.name);
    if (!title) { invalid++; continue; }
    const raw = row.at ?? row.datetime ?? row.timestamp ??
      (row.date && row.time && !/\d{4}-\d{2}-\d{2}/.test(String(row.time))
        ? String(row.date).slice(0, 10) + " " + row.time : row.date ?? row.time);
    const resolved = resolveEventTime(raw, { timezone: zone });
    const date = resolved.at ? dayKey(resolved.at, zone) : resolved.day;
    if (!validDate(date)) { invalid++; continue; }
    if (date < from || date > to) { dropped++; continue; }
    const precision = row.precision === "unknown" ? "unknown" : row.precision === "assumed" ? "assumed" : resolved.precision;
    const at = precision === "unknown" ? null : resolved.at?.toISOString() || null;
    const countryRaw = clean(row.country || row.currency, 40);
    const country = COUNTRY_CODES[countryRaw] || countryRaw;
    const impactRaw = String(row.impact || row.importance || "Low").toLowerCase();
    const impact = ({ "3": "High", "2": "Medium", "1": "Low", high: "High", medium: "Medium", low: "Low" })[impactRaw] || "Low";
    const status = clean(row.status, 20);
    const item = {
      id: clean(row.id, 100) || [country, title, date, at].join("|"),
      date, at, time: at ? clockInZone(new Date(at), zone) : "--", timezone: zone,
      precision, verified: precision === "exact" && row.verified !== false && !/^(tentative|delayed|cancelled)$/i.test(String(row.status || "")),
      title, country, impact, forecast: reportedValue(row.forecast), previous: reportedValue(row.previous),
      actual: reportedValue(row.actual), source,
      status: status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : null,
    };
    item.status = releaseStatus(item, now);
    unique.set([country, title.toLowerCase(), date, at].join("|"), item);
  }
  const items = [...unique.values()].sort(compareEvents).slice(0, limit);
  return { items, reason: !items.length && invalid === rows.length && rows.length ? "invalid-events" :
    !items.length ? (dropped ? "no-events-today" : "empty-feed") : null, dropped, invalid };
}

module.exports = { compareEvents, normalizeCalendar, resolveEventTime, isValidTimeZone, dayKey, addDays, clockInZone, validDate, releaseStatus, ZONE_ABBREVIATIONS };
