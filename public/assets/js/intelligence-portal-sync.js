/* Category sync for the Intelligence Portal, shared by the browser and the
   Node tests.

   X Intelligence groups accounts into templates; YouTube Intelligence groups
   channels into categories. Both lists are edited at runtime from their own
   pages, so the portal never keeps a copy: it reads both live and lines them
   up here, one dropdown entry per subject.

   Matching is by name, because the two registries share no IDs:

     1. Exact: the names normalize to the same words ("War" and "war").
     2. Partial: one name's words are all inside the other's ("Crypto" and
        "Crypto & Stocks"). Only taken when it is unambiguous on both sides,
        so "Tech" never pairs with whichever of two "Tech ..." templates
        happens to come first.

   Anything left over stays in the list as single-source, so a category that
   exists on only one page is still reachable from the portal.

   Free of DOM and network access so the pairing can be tested directly. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.IntelligencePortalSync = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function words(name) {
    return String(name == null ? "" : name)
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter(function (word) { return word && word !== "and"; });
  }

  function normalizedName(name) {
    return words(name).join(" ");
  }

  function containsAll(haystack, needle) {
    if (!needle.length || needle.length >= haystack.length) return false;
    return needle.every(function (word) { return haystack.indexOf(word) !== -1; });
  }

  function partialMatch(a, b) {
    var aw = words(a.name);
    var bw = words(b.name);
    return containsAll(aw, bw) || containsAll(bw, aw);
  }

  function xSource(template) {
    return {
      id: String(template.id),
      name: String(template.name || template.id),
      count: Array.isArray(template.handles) ? template.handles.length : Number(template.accountCount || 0),
      accent: template.accent || "",
      description: template.description || "",
    };
  }

  function youtubeSource(category) {
    return {
      id: String(category.id),
      name: String(category.name || category.id),
      count: Number(category.channelCount || 0),
    };
  }

  function entry(x, youtube, match) {
    var name = x ? x.name : youtube.name;
    if (x && youtube && match === "partial" && normalizedName(x.name) !== normalizedName(youtube.name)) {
      // Name the pair after the shorter label: it is the subject both share.
      name = words(youtube.name).length < words(x.name).length ? youtube.name : x.name;
    }
    return {
      key: (x ? "x:" + x.id : "") + (x && youtube ? "|" : "") + (youtube ? "yt:" + youtube.id : ""),
      name: name,
      match: x && youtube ? match : "single",
      x: x,
      youtube: youtube,
    };
  }

  /**
   * Pairs X templates with YouTube categories.
   *
   * Returns entries in X template order, with YouTube-only categories after
   * them in YouTube order. Each entry is
   *   { key, name, match: "exact"|"partial"|"single", x: {...}|null, youtube: {...}|null }.
   * `key` is stable for a given pair of IDs, which is what lets the page keep
   * its selection across a refresh.
   */
  function mergeCategories(xTemplates, youtubeCategories) {
    var xs = (Array.isArray(xTemplates) ? xTemplates : []).filter(function (item) { return item && item.id; }).map(xSource);
    var yts = (Array.isArray(youtubeCategories) ? youtubeCategories : []).filter(function (item) { return item && item.id; }).map(youtubeSource);
    var pairOf = {}; // x index -> { yt index, match }
    var takenYt = {};

    xs.forEach(function (x, xi) {
      var wanted = normalizedName(x.name);
      if (!wanted) return;
      for (var yi = 0; yi < yts.length; yi += 1) {
        if (!takenYt[yi] && normalizedName(yts[yi].name) === wanted) {
          pairOf[xi] = { yi: yi, match: "exact" };
          takenYt[yi] = true;
          return;
        }
      }
    });

    xs.forEach(function (x, xi) {
      if (pairOf[xi]) return;
      var candidates = [];
      yts.forEach(function (yt, yi) {
        if (!takenYt[yi] && partialMatch(x, yt)) candidates.push(yi);
      });
      if (candidates.length !== 1) return;
      var yi = candidates[0];
      // And the YouTube side must not have a second unpaired X candidate.
      var rivals = xs.filter(function (other, oi) {
        return oi !== xi && !pairOf[oi] && partialMatch(other, yts[yi]);
      });
      if (rivals.length) return;
      pairOf[xi] = { yi: yi, match: "partial" };
      takenYt[yi] = true;
    });

    var entries = xs.map(function (x, xi) {
      var pair = pairOf[xi];
      return pair ? entry(x, yts[pair.yi], pair.match) : entry(x, null, "single");
    });
    yts.forEach(function (yt, yi) {
      if (!takenYt[yi]) entries.push(entry(null, yt, "single"));
    });
    return entries;
  }

  /**
   * Picks which entry to show. Order of preference: an entry carrying the X
   * template or YouTube category named in the URL, the key the reader chose
   * last, the first entry present on both sides, then the first entry.
   */
  function pickEntry(entries, preferences) {
    var list = Array.isArray(entries) ? entries : [];
    var prefs = preferences || {};
    function find(test) {
      for (var i = 0; i < list.length; i += 1) if (test(list[i])) return list[i];
      return null;
    }
    return (prefs.x && find(function (e) { return e.x && e.x.id === prefs.x; }))
      || (prefs.youtube && find(function (e) { return e.youtube && e.youtube.id === prefs.youtube; }))
      || (prefs.key && find(function (e) { return e.key === prefs.key; }))
      || find(function (e) { return e.x && e.youtube; })
      || list[0]
      || null;
  }

  return {
    normalizedName: normalizedName,
    mergeCategories: mergeCategories,
    pickEntry: pickEntry,
  };
});
