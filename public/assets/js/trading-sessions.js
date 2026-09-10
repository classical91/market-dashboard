"use strict";

// Which trading session is open right now.
//
// Sydney, Tokyo, London and New York together span all 24 hours, so outside the
// weekend close at least one of them is always open. The overview chip has said
// so since it was written; this file is where it works it out.
//
// It lives here, rather than inside overview.js, because Main Hub's Daily
// Dashboard shows the same status. Session hours restated in another repository
// would be a second answer to a question with one right answer, so the rule is
// loaded two ways from one file: a <script> tag on the dashboard pages, and a
// require() from the /api/market-session route.
//
// Everything here is UTC on purpose. A trading session is not on anyone's local
// clock, and converting it to one is how you end up reporting London as open at
// the wrong time of year.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarketSessions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Standard session hours in UTC (not adjusted for daylight saving).
  const TRADING_SESSIONS = [
    { name: "Sydney", open: 22, close: 7 },
    { name: "Tokyo", open: 0, close: 9 },
    { name: "London", open: 8, close: 17 },
    { name: "New York", open: 13, close: 22 },
  ];

  function inSessionWindow(hour, open, close) {
    // Sessions that wrap past midnight (e.g. Sydney 22:00-07:00) need the
    // OR form; same-day sessions need the AND form.
    return open < close ? hour >= open && hour < close : hour >= open || hour < close;
  }

  function isWeekendClose(day, hour) {
    // The forex week runs Sunday 22:00 UTC (Sydney open) to Friday 22:00 UTC
    // (New York close).
    if (day === 6) return true;
    if (day === 0 && hour < 22) return true;
    if (day === 5 && hour >= 22) return true;
    return false;
  }

  /**
   * The session state for an instant, in the shape both the chip and the API
   * report: whether the market is open at all, which sessions are running,
   * whether they overlap, and the label the chip has always shown.
   */
  function describeSession(now = new Date()) {
    const day = now.getUTCDay();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60;

    if (isWeekendClose(day, hour)) {
      return {
        open: false,
        weekend: true,
        sessions: [],
        overlap: false,
        label: "Markets Closed — Weekend",
      };
    }

    const sessions = TRADING_SESSIONS.filter((session) =>
      inSessionWindow(hour, session.open, session.close),
    ).map((session) => session.name);

    const overlap = sessions.length > 1;
    return {
      open: true,
      weekend: false,
      sessions,
      overlap,
      label: `${sessions.join(" + ")} Session${overlap ? " (Overlap)" : ""}`,
    };
  }

  return { TRADING_SESSIONS, inSessionWindow, isWeekendClose, describeSession };
});
