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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
