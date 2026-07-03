(function () {
  "use strict";

  var localKey = "xSearch:lastQuery";

  function readLastQuery() {
    try { return localStorage.getItem(localKey) || ""; } catch (err) { return ""; }
  }

  function writeLastQuery(query) {
    try { localStorage.setItem(localKey, query); } catch (err) {}
  }

  function runSearch(query, resultsRoot, submitButton) {
    var trimmed = query.trim();
    if (!trimmed) {
      window.XPosts.renderPostCards(resultsRoot, [], "Type something to search X.");
      return;
    }

    writeLastQuery(trimmed);
    submitButton.disabled = true;
    submitButton.textContent = "Searching...";
    window.XPosts.renderPostCards(resultsRoot, [], "Searching X for “" + trimmed + "”…");

    fetch("/api/x/search?q=" + encodeURIComponent(trimmed))
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || data.message || "Search failed");
          return data;
        });
      })
      .then(function (data) {
        window.XPosts.renderPostCards(resultsRoot, data.posts || [], "No results found for “" + trimmed + "”.");
      })
      .catch(function (err) {
        window.XPosts.renderPostCards(resultsRoot, [], err.message || "Search failed.");
      })
      .then(function () {
        submitButton.disabled = false;
        submitButton.textContent = "Search";
      });
  }

  function init() {
    var form = document.getElementById("xSearchForm");
    var input = document.getElementById("xSearchInput");
    var submitButton = document.getElementById("xSearchSubmit");
    var resultsRoot = document.getElementById("xSearchResults");
    if (!form || !input || !resultsRoot) return;

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      runSearch(input.value, resultsRoot, submitButton);
    });

    var lastQuery = readLastQuery();
    if (lastQuery) {
      input.value = lastQuery;
      runSearch(lastQuery, resultsRoot, submitButton);
    } else {
      window.XPosts.renderPostCards(resultsRoot, [], "Type something to search X.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
