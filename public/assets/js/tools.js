/**
 * "Open All" for the Calendars & Tools section on the overview page.
 * Opens every tool link in its own tab. Browsers' pop-up blockers usually
 * allow only the first tab per click gesture, so blocked tabs are detected
 * (window.open returns null) and the user is prompted to allow pop-ups.
 */
(function () {
  "use strict";

  function init() {
    var btn = document.getElementById("toolsOpenAll");
    var section = document.getElementById("calendars-tools");
    if (!btn || !section) return;

    var links = Array.prototype.slice.call(section.querySelectorAll(".tool-grid a[href]"));
    if (!links.length) {
      btn.style.display = "none";
      return;
    }
    btn.textContent = "⧉ Open All (" + links.length + ")";

    btn.addEventListener("click", function (event) {
      event.preventDefault();
      var blocked = 0;
      links.forEach(function (link) {
        var win = window.open(link.href, "_blank", "noopener");
        if (!win) blocked += 1;
      });
      if (blocked > 0) {
        showHint(section, blocked, links.length);
      } else {
        hideHint();
      }
    });
  }

  function showHint(section, blocked, total) {
    var note = document.getElementById("toolsOpenAllHint");
    if (!note) {
      note = document.createElement("div");
      note.id = "toolsOpenAllHint";
      note.className = "open-all-hint";
      section.appendChild(note);
    }
    note.textContent =
      "⚠️ Your browser blocked " + blocked + " of " + total +
      " tabs. Allow pop-ups for this site (pop-up icon in the address bar), then click “Open All” again.";
    note.style.display = "block";
  }

  function hideHint() {
    var note = document.getElementById("toolsOpenAllHint");
    if (note) note.style.display = "none";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
