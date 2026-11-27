"use strict";

// Market session pill in the Overview v2 header.
//
// The same status Main Hub's Daily Dashboard shows on its hero: which session
// is on the clock and whether the market is open. The hours come from
// trading-sessions.js, which /api/market-session loads too, so the two pages
// cannot disagree. It is clock arithmetic, so it needs no network and is
// redrawn every half minute.

(function () {
  const pill = document.getElementById("ov2-session");
  if (!pill || !window.MarketSessions) return;

  const nameEl = pill.querySelector(".ov2-session-name");
  const whenEl = pill.querySelector(".ov2-session-when");

  // The forex week opens Sunday 22:00 UTC and closes Friday 22:00 UTC.
  function nextWeekBoundary(now, open) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22));
    const wantDay = open ? 5 : 0; // open → next close (Fri), closed → next open (Sun)
    let ahead = (wantDay - now.getUTCDay() + 7) % 7;
    if (ahead === 0 && now >= target) ahead = 7;
    target.setUTCDate(target.getUTCDate() + ahead);
    return target;
  }

  function span(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function render() {
    const now = new Date();
    const session = window.MarketSessions.describeSession(now);
    const boundary = nextWeekBoundary(now, session.open);

    pill.classList.toggle("is-open", session.open);
    pill.hidden = false;
    nameEl.textContent = session.open
      ? session.label
      : "Markets closed";
    whenEl.textContent = session.open
      ? `Open now · week closes in ${span(boundary - now)}`
      : `Weekend · opens in ${span(boundary - now)}`;
    pill.title = `${session.label}. The forex week runs Sunday 22:00 to Friday 22:00 UTC.`;
  }

  render();
  setInterval(render, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
})();
