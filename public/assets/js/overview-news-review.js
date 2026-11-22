/* Read the same latest report as the Overview tile. Opening a review never
 * generates a report; the footer links to the existing desk's Run control. */
(function () {
  "use strict";

  var dialog = document.getElementById("ov2-news-review");
  if (!dialog || typeof dialog.showModal !== "function") return;
  var title = document.getElementById("ov2-review-title");
  var meta = document.getElementById("ov2-review-meta");
  var body = document.getElementById("ov2-review-body");
  var runLink = document.getElementById("ov2-review-run");
  var md = window.BriefingMarkdown;
  var activeDesk = null;

  function open(desk) {
    activeDesk = desk.key;
    title.textContent = desk.icon + " " + desk.label + " report";
    runLink.href = "/briefings/" + desk.key + "#briefingRun";
    runLink.setAttribute("aria-label", "Open " + desk.label + " desk to run a report");
    meta.textContent = desk.at
      ? (desk.reporter ? "Reporter Room · " : "Phone briefing · ") + new Date(desk.at).toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }) + " · " + window.BriefingFreshness.label(new Date(desk.at).toISOString())
      : "Latest report";

    if (desk.failed || (!desk.at && desk.partial)) {
      body.innerHTML = '<p class="ov2-review-notice" role="status">Could not load reports. Open the desk page to try again.</p>';
    } else if (!desk.at) {
      body.innerHTML = '<p class="ov2-review-notice">No report recorded for this desk yet. Open the desk page to run one.</p>';
    } else {
      var notice = desk.partial ? '<p class="ov2-review-notice" role="status">Some report sources are unavailable. Showing the latest available report.</p>' : "";
      if (desk.noBriefing) notice += '<p class="ov2-review-notice" role="status">This run did not produce a briefing. Open the desk page to run it again.</p>';
      body.innerHTML = notice + (desk.title ? "<h3>" + md.esc(desk.title) + "</h3>" : "") +
        (desk.text ? md.renderMarkdown(desk.text) : '<p class="ov2-review-notice">Report text is unavailable. Open the desk page to review its runs.</p>');
    }
    dialog.showModal();
    document.documentElement.classList.add("ov2-review-open");
    body.scrollTop = 0;
    return true;
  }

  document.getElementById("ov2-review-close").addEventListener("click", function () { dialog.close(); });
  // Keep Tab at either boundary inside the review. The native dialog handles
  // Escape and makes the page behind it inert.
  dialog.addEventListener("keydown", function (event) {
    if (event.key !== "Tab") return;
    var stops = dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]');
    var first = stops[0], last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  // Only clicks outside the panel close the backdrop.
  dialog.addEventListener("click", function (event) {
    if (event.target !== dialog) return;
    var rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener("close", function () {
    document.documentElement.classList.remove("ov2-review-open");
    // Tiles may have refreshed while the report was open.
    var trigger = document.querySelector('[data-news-desk="' + activeDesk + '"]');
    if (trigger) trigger.focus({ preventScroll: true });
  });

  window.OverviewNewsReview = { open: open };
})();
