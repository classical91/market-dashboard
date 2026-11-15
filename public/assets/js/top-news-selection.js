/* One combined Top 10 from the source desks' existing rankings. */
(function (root) {
  "use strict";
  var ALLOWED = ["economics", "stocks", "crypto"];

  function headlineKey(title) {
    return String(title || "").normalize("NFKC").toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function articleKeys(body) {
    return (String(body || "").match(/https?:\/\/[^\s<>\])]+/g) || []).map(function (link) {
      try {
        var url = new URL(link.replace(/[.,;]+$/, ""));
        if (url.pathname === "/") return null;
        url.hash = "";
        Array.from(url.searchParams.keys()).forEach(function (key) {
          if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
        });
        url.searchParams.sort();
        return url.toString().replace(/\/$/, "");
      } catch (e) { return null; }
    }).filter(Boolean);
  }

  function select(desks, picked) {
    var sources = ALLOWED.map(function (key) {
      var desk = (desks || []).filter(function (item) { return item.key === key; })[0];
      if (!desk) return null;
      var run = desk.runs.filter(function (item) { return item.id === (picked || {})[key]; })[0] || desk.runs[0];
      return run ? { desk: desk, run: run } : null;
    }).filter(Boolean);
    var candidates = [];
    sources.forEach(function (source, deskIndex) {
      (source.run.stories || []).forEach(function (story, index) {
        candidates.push({ story: story, source: source, deskIndex: deskIndex, rank: index });
      });
    });
    // Each desk already ranks its stories. Read rank 1 across desks, then
    // rank 2, and so on; never take ten from the first desk by accident.
    candidates.sort(function (a, b) { return a.rank - b.rank || a.deskIndex - b.deskIndex; });
    var titles = new Set();
    var articles = new Set();
    var selected = [];
    candidates.forEach(function (candidate) {
      var story = candidate.story;
      var title = headlineKey(story.title);
      var links = articleKeys(story.body);
      if (!title || titles.has(title) || links.some(function (link) { return articles.has(link); })) return;
      titles.add(title);
      links.forEach(function (link) { articles.add(link); });
      if (selected.length >= 10) return;
      var source = candidate.source;
      selected.push({
        number: selected.length + 1,
        title: story.title, body: story.body,
        desk: source.desk.key, deskLabel: source.desk.label, icon: source.desk.icon,
        sourceRank: story.number, runId: source.run.id, at: source.run.at, source: source.run.source,
      });
    });
    return selected;
  }

  if (typeof module === "object" && module.exports) module.exports = { select: select };
  else root.TopNewsSelection = { select: select };
})(typeof window === "object" ? window : globalThis);
