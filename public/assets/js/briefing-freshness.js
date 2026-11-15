/* Shared run-age colors for desk briefings and Top 10 News. */
(function () {
  "use strict";
  var HOUR_MS = 60 * 60 * 1000;
  function state(iso) {
    var at = iso ? new Date(iso).getTime() : NaN;
    if (!isFinite(at)) return "empty";
    var age = Date.now() - at;
    if (age > 48 * HOUR_MS) return "stale";
    return age <= 32 * HOUR_MS ? "fresh" : "nearing";
  }
  function label(iso) {
    return { fresh: "Fresh", nearing: "Nearing due", stale: "Past due", empty: "No run recorded" }[state(iso)];
  }
  window.BriefingFreshness = { state: state, label: label };
})();
