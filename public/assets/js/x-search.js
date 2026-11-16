(function () {
  "use strict";

  var localKey = "xSearch:lastQuery";

  function readLastQuery() {
    try { return localStorage.getItem(localKey) || ""; } catch (err) { return ""; }
  }

  function writeLastQuery(query) {
    try { localStorage.setItem(localKey, query); } catch (err) {}
  }

  function openSearch(query) {
    var trimmed = query.trim();
    if (!trimmed) return;
    writeLastQuery(trimmed);
    window.open("https://x.com/search?q=" + encodeURIComponent(trimmed) + "&src=typed_query", "_blank", "noopener");
  }

  function init() {
    var form = document.getElementById("xSearchForm");
    var input = document.getElementById("xSearchInput");
    if (!form || !input) return;

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      openSearch(input.value);
    });

    input.value = readLastQuery();

    // The legacy search page keeps its always-visible form. In the sidebar,
    // the same search opens from a compact trigger above the shortcuts.
    var toggle = document.getElementById("xSearchToggle");
    var popover = document.getElementById("xSearchPopover");
    if (!toggle || !popover) return;

    function setOpen(open, returnFocus) {
      popover.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) input.focus();
      else if (returnFocus) toggle.focus();
    }

    toggle.addEventListener("click", function () {
      setOpen(popover.hidden, false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !popover.hidden) {
        event.preventDefault();
        setOpen(false, true);
      }
    });

    document.addEventListener("click", function (event) {
      if (!popover.hidden && !toggle.contains(event.target) && !popover.contains(event.target)) {
        setOpen(false, false);
      }
    });

    document.addEventListener("focusin", function (event) {
      if (!popover.hidden && !toggle.contains(event.target) && !popover.contains(event.target)) {
        setOpen(false, false);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
