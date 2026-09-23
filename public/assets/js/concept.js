/**
 * Concept page — one glossary concept per page, at /concept.html?id=<id>.
 * Reads the glossary data that indicators.js exposes as window.MarketGlossary.
 */
(function () {
  "use strict";

  var G = window.MarketGlossary;
  var root = document.getElementById("conceptRoot");
  var crumbs = document.getElementById("conceptCrumbs");
  if (!G || !root) return;

  var esc = G.escapeHtml;
  var ordered = G.orderedEntries();
  var id = new URLSearchParams(window.location.search).get("id") || "";
  var index = ordered.findIndex(function (entry) { return entry.id === id; });

  if (index === -1) {
    document.title = "Concept not found · Indicators Glossary · Market Command";
    root.innerHTML =
      '<div class="concept-card"><p class="concept-missing">' +
      (id ? "There is no glossary concept called &ldquo;" + esc(id) + "&rdquo;." : "No concept was chosen.") +
      ' Browse or search the <a href="/indicators.html">Indicators Glossary</a> instead.</p></div>';
    return;
  }

  var entry = ordered[index];
  var prev = ordered[index - 1];
  var next = ordered[index + 1];
  var categoryHref = "/indicators.html#" + G.slug(entry.category);
  document.title = entry.term + " · Indicators Glossary · Market Command";

  crumbs.innerHTML =
    '<a href="/indicators.html">Indicators Glossary</a><span aria-hidden="true">/</span>' +
    '<a href="' + esc(categoryHref) + '">' + esc(entry.category) + "</a>";

  function pagerLink(target, cls, label) {
    if (!target) return "";
    return (
      '<a class="' + cls + '" href="' + esc(G.conceptHref(target)) + '" rel="' + (cls === "next" ? "next" : "prev") + '">' +
      '<span class="concept-pager-label">' + label + "</span>" +
      '<span class="concept-pager-term">' + esc(target.term) + "</span></a>"
    );
  }

  var usedIn = (entry.pages || [])
    .map(function (p) { return '<a class="concept-chip" href="' + esc(p.href) + '">' + esc(p.label) + "</a>"; })
    .join("");

  var related = ordered
    .filter(function (other) { return other.category === entry.category && other.id !== entry.id; })
    .map(function (other) { return '<a href="' + esc(G.conceptHref(other)) + '">' + esc(other.term) + "</a>"; })
    .join("");

  // entry.illustration is authored, trusted HTML from indicators.js (not user input).
  root.innerHTML =
    '<article class="concept-card">' +
    '<div class="concept-kicker">' + esc(entry.category) + "</div>" +
    '<h1 class="concept-title">' + esc(entry.term) + "</h1>" +
    '<p class="concept-def">' + esc(entry.def) + "</p>" +
    '<section class="concept-read"><h2 class="concept-section-title">How to read it</h2><p>' + esc(entry.read) + "</p></section>" +
    (entry.illustration ? '<div class="concept-illustration">' + entry.illustration + "</div>" : "") +
    (usedIn ? '<section><h2 class="concept-section-title">Where it shows up</h2><div class="concept-used-in">' + usedIn + "</div></section>" : "") +
    "</article>" +
    '<nav class="concept-pager" aria-label="Previous and next concept">' +
    pagerLink(prev, "prev", "&larr; Previous") +
    pagerLink(next, "next", "Next &rarr;") +
    "</nav>" +
    (related
      ? '<section class="concept-related"><h2 class="concept-section-title">More in ' + esc(entry.category) + "</h2>" +
        '<div class="concept-related-list">' + related + "</div></section>"
      : "");

  document.addEventListener("keydown", function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    var target = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : null;
    if (target) window.location.assign(G.conceptHref(target));
  });
})();
