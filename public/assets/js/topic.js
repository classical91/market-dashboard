/**
 * Topic explainer page — one glossary category explained as a guided read,
 * at /topic.html?id=<topic id>. With no id it lists every topic.
 * Reads the glossary + topic data that indicators.js exposes as
 * window.MarketGlossary (glossary-topics.js must load before it).
 */
(function () {
  "use strict";

  var G = window.MarketGlossary;
  var root = document.getElementById("topicRoot");
  var crumbs = document.getElementById("topicCrumbs");
  if (!G || !root) return;

  var esc = G.escapeHtml;
  var categories = G.topicCategories();
  var id = new URLSearchParams(window.location.search).get("id") || "";
  var category = id ? G.categoryForTopicId(id) : null;

  function countLabel(n) {
    return n + (n === 1 ? " concept" : " concepts");
  }

  function conceptCount(cat) {
    return G.topicSections(cat).reduce(function (n, s) { return n + s.entries.length; }, 0);
  }

  function directoryHtml() {
    return (
      '<div class="topic-grid">' +
      categories.map(function (cat) {
        var topic = G.topicFor(cat);
        return (
          '<a class="topic-tile" href="' + esc(G.topicHref(cat)) + '">' +
          '<span class="topic-tile-title">' + esc(cat) + "</span>" +
          (topic && topic.summary ? '<span class="topic-tile-summary">' + esc(topic.summary) + "</span>" : "") +
          '<span class="topic-tile-count">' + countLabel(conceptCount(cat)) + "</span></a>"
        );
      }).join("") +
      "</div>"
    );
  }

  if (!category) {
    document.title = (id ? "Topic not found" : "Topic Explainers") + " · Indicators Glossary · Market Command";
    root.innerHTML =
      '<div class="topic-card">' +
      '<div class="topic-kicker">Indicators Glossary</div>' +
      '<h1 class="topic-title">Topic explainers</h1>' +
      (id
        ? '<p class="topic-missing">There is no topic called &ldquo;' + esc(id) + "&rdquo;. Pick one below.</p>"
        : '<p class="topic-intro">Each glossary category explained as one guided read: what the topic is about, why it matters, how its concepts fit together, and how to put them to work.</p>') +
      directoryHtml() +
      "</div>";
    return;
  }

  var topic = G.topicFor(category) || {};
  var sections = G.topicSections(category);
  var total = sections.reduce(function (n, s) { return n + s.entries.length; }, 0);
  var position = categories.indexOf(category);
  var prev = categories[position - 1];
  var next = categories[position + 1];
  document.title = category + " · Topic Explainer · Market Command";

  crumbs.innerHTML =
    '<a href="/indicators.html">Indicators Glossary</a><span aria-hidden="true">/</span>' +
    '<a href="/topic.html">Topics</a><span aria-hidden="true">/</span>' +
    "<span>" + esc(category) + "</span>";

  function chipsHtml(pages) {
    return (pages || [])
      .map(function (p) { return '<a class="topic-chip" href="' + esc(p.href) + '">' + esc(p.label) + "</a>"; })
      .join("");
  }

  // entry.illustration is authored, trusted HTML from indicators.js (not user input).
  function conceptHtml(entry) {
    var chips = chipsHtml(entry.pages);
    return (
      '<article class="topic-concept" id="term-' + esc(entry.id) + '">' +
      '<h3 class="topic-concept-heading"><a class="topic-concept-term" href="' + esc(G.conceptHref(entry)) + '">' + esc(entry.term) + "</a></h3>" +
      "<p>" + esc(entry.def) + "</p>" +
      '<p class="topic-concept-read"><strong>How to read it:</strong> ' + esc(entry.read) + "</p>" +
      (entry.illustration ? '<div class="topic-concept-illustration">' + entry.illustration + "</div>" : "") +
      (chips ? '<div class="topic-chips">' + chips + "</div>" : "") +
      "</article>"
    );
  }

  function sectionHtml(section) {
    return (
      '<section class="topic-section" id="' + esc(section.anchor) + '">' +
      '<h2 class="topic-section-title">' + esc(section.title) + "</h2>" +
      (section.note ? '<p class="topic-section-note">' + esc(section.note) + "</p>" : "") +
      '<div class="topic-concepts">' + section.entries.map(conceptHtml).join("") + "</div>" +
      "</section>"
    );
  }

  var toc = sections.length > 1
    ? '<h2 class="topic-label">In this explainer</h2><ol class="topic-toc">' +
      sections.map(function (s) {
        return (
          '<li><a href="#' + esc(s.anchor) + '"><span>' + esc(s.title) + "</span>" +
          '<span class="topic-toc-count">' + s.entries.length + "</span></a></li>"
        );
      }).join("") +
      "</ol>"
    : "";

  // Every dashboard page this topic's concepts show up on, once each.
  var seenHref = {};
  var shows = [];
  sections.forEach(function (s) {
    s.entries.forEach(function (entry) {
      (entry.pages || []).forEach(function (p) {
        if (seenHref[p.href]) return;
        seenHref[p.href] = true;
        shows.push(p);
      });
    });
  });

  function pagerLink(cat, cls, label) {
    if (!cat) return "";
    return (
      '<a class="' + cls + '" href="' + esc(G.topicHref(cat)) + '" rel="' + (cls === "next" ? "next" : "prev") + '">' +
      '<span class="topic-pager-label">' + label + "</span>" +
      '<span class="topic-pager-term">' + esc(cat) + "</span></a>"
    );
  }

  var takeaways = (topic.takeaways || []).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("");

  root.innerHTML =
    '<section class="topic-card topic-overview">' +
    '<div class="topic-kicker">Topic explainer &middot; ' + countLabel(total) + "</div>" +
    '<h1 class="topic-title">' + esc(category) + "</h1>" +
    (topic.intro ? '<p class="topic-intro">' + esc(topic.intro) + "</p>" : "") +
    (topic.why ? '<section class="topic-why"><h2 class="topic-label">Why it matters</h2><p>' + esc(topic.why) + "</p></section>" : "") +
    toc +
    "</section>" +
    sections.map(sectionHtml).join("") +
    (takeaways
      ? '<section class="topic-card topic-takeaways"><h2 class="topic-label">Putting it together</h2><ul>' + takeaways + "</ul></section>"
      : "") +
    (shows.length
      ? '<section class="topic-shows-up"><h2 class="topic-label">Where this topic shows up</h2><div class="topic-chips">' + chipsHtml(shows) + "</div></section>"
      : "") +
    '<nav class="topic-pager" aria-label="Previous and next topic">' +
    pagerLink(prev, "prev", "&larr; Previous topic") +
    pagerLink(next, "next", "Next topic &rarr;") +
    "</nav>";

  // A #term-<id> link lands on that concept once the page has rendered.
  if (window.location.hash) {
    var target = document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView();
  }
})();
