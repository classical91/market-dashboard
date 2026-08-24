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
function resolveEventTime(value, { timezone, now }) {
  if (value == null) return { at: null, precision: "unknown" };

  // Epoch seconds or milliseconds — already an instant.
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? { at: null, precision: "unknown" } : { at: date, precision: "exact" };
  }

  const text = String(value).trim();
  if (!text) return { at: null, precision: "unknown" };

  // A numeric string is an epoch too.
  if (/^\d{9,13}$/.test(text)) return resolveEventTime(Number(text), { timezone, now });

  // An explicit offset (…Z, …+02:00, …-0500) makes the instant unambiguous.
  if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})\s*$/.test(text)) {
    const date = new Date(text.replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? { at: null, precision: "unknown" } : { at: date, precision: "exact" };
  }

  // Strip a trailing zone label and let it pick the zone, if we recognise it.
  const labelled = /^(.*?)[\s]+([A-Za-z]{1,4})\s*$/.exec(text);
  let body = text;
  let zone = timezone;
  if (labelled && Object.prototype.hasOwnProperty.call(ZONE_ABBREVIATIONS, labelled[2].toUpperCase())) {
    body = labelled[1].trim();
    zone = ZONE_ABBREVIATIONS[labelled[2].toUpperCase()];
  }

  // Date and wall-clock time, no offset: interpret in the resolved zone.
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(body);
  if (dateTime) {
    const at = new Date(wallClockToUtc({
      year: Number(dateTime[1]),
      month: Number(dateTime[2]),
      day: Number(dateTime[3]),
      hour: Number(dateTime[4]),
      minute: Number(dateTime[5]),
    }, zone));
    return Number.isNaN(at.getTime()) ? { at: null, precision: "unknown" } : { at, precision: "assumed" };
  }

  // A bare clock label — "08:30", "14:00 ET". Carries no date at all, so it can
  // only mean today in the resolved zone.
  const clock = /^(\d{1,2}):(\d{2})/.exec(body);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return { at: null, precision: "unknown" };
    const today = datePartsInZone(now, zone);
    const at = new Date(wallClockToUtc({ ...today, hour, minute }, zone));
    return Number.isNaN(at.getTime()) ? { at: null, precision: "unknown" } : { at, precision: "assumed" };
  }

  // A date with no time: real day, unknown hour. Not timeable, so not an
  // instant — but the date is still enough to rule it in or out of today.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(body);
  if (dateOnly) {
    return {
      at: null,
      precision: "unknown",
      day: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`,
    };
  }

  const parsed = new Date(body);
  if (!Number.isNaN(parsed.getTime())) return { at: parsed, precision: "assumed" };
  return { at: null, precision: "unknown" };
}

/**
 * Normalize a macro-calendar feed into dated, timed events.
 *
 * Events resolving to a day other than today (in `timezone`) are dropped:
 * yesterday's CPI release must never be scored as an upcoming one. Events with
 * no resolvable time are kept — a high-impact event we cannot time is still a
 * fact worth reporting — but carry `at: null` so nothing downstream can invent
 * a countdown for them.
 */
function normalizeCalendar(data, { timezone = "UTC", now = new Date(), limit = 10 } = {}) {
  const zone = isValidTimeZone(timezone) ? timezone : "UTC";
  const rows = Array.isArray(data) ? data : data?.events || data?.items || data?.data || [];
  if (!Array.isArray(rows)) return { items: [], reason: "invalid-shape", dropped: 0 };
  if (!rows.length) return { items: [], reason: "empty-feed", dropped: 0 };

  const today = dayKey(now, zone);
  let dropped = 0;

  const items = rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const title = String(row.title || row.event || row.name || "").trim();
      if (!title) return null;

      const impactRaw = String(row.impact || row.importance || "Low").trim();
      const impact = impactRaw.charAt(0).toUpperCase() + impactRaw.slice(1).toLowerCase();

      // A feed may split date and time; join them so the date is not lost.
      const rawTime = row.time ?? row.datetime ?? row.date ?? row.timestamp ?? null;
      const combined = row.date && row.time && !/\d{4}-\d{2}-\d{2}/.test(String(row.time))
        ? `${String(row.date).trim()} ${String(row.time).trim()}`
        : rawTime;

      const resolved = resolveEventTime(combined, { timezone: zone, now });
      const eventDay = resolved.at ? dayKey(resolved.at, zone) : resolved.day || null;

      // Known to be another day — drop it rather than let it pose as today's.
      if (eventDay && eventDay !== today) {
        dropped += 1;
        return null;
      }

      return {
        at: resolved.at ? resolved.at.toISOString() : null,
        time: resolved.at ? clockInZone(resolved.at, zone) : "--",
        timezone: zone,
        precision: resolved.precision,
        title: title.slice(0, 120),
        impact: IMPACTS.includes(impact) ? impact : "Low",
        country: row.country ? String(row.country).slice(0, 40) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.at && b.at) return Date.parse(a.at) - Date.parse(b.at);
      if (a.at) return -1;
      if (b.at) return 1;
      return 0;
    })
    .slice(0, limit);

  if (!items.length) {
    return { items: [], reason: dropped ? "no-events-today" : "empty-feed", dropped };
  }
  return { items, reason: null, dropped };
}

module.exports = {
  normalizeCalendar,
  resolveEventTime,
  isValidTimeZone,
  dayKey,
  clockInZone,
  ZONE_ABBREVIATIONS,
};
