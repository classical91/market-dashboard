/* X Intelligence feed view logic: client-side filters, display mode and
   background-motion preferences, and new-post tracking.

   Everything here is pure (storage is passed in), so the browser and the Node
   tests share one implementation. It only ever reads the feed payload the page
   already loaded — it never fetches, polls, or decides freshness; that stays
   with x-freshness.js. Loaded as a plain script before x-intelligence.js. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XFeedView = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var HOUR = 60 * 60 * 1000;

  var VIEW_MODES = ["compact", "cards", "focus"];
  // Compact is the default for anyone who has not chosen: it is the densest
  // monitoring layout and the one that cannot leave a short post in a tall box.
  var DEFAULT_VIEW = "compact";

  var TIME_WINDOWS = { all: 0, "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR };
  var TIME_KEYS = ["all", "1h", "6h", "24h", "7d"];

  var KEYS = {
    view: "xIntelligence:viewMode:v1",
    motion: "xIntelligence:bgMotion:v1",
    filters: "xIntelligence:feedFilters:v1",
    seen: "xIntelligence:seenPosts:v1",
  };

  // How many post identifiers a template remembers as seen. Bounded so the
  // record cannot grow without limit on a device that is never cleared.
  var SEEN_LIMIT = 400;

  function storageGet(storage, key) {
    try { return storage ? storage.getItem(key) : null; } catch (err) { return null; }
  }

  function storageSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (err) {}
  }

  function templateKey(prefix, templateId) {
    return prefix + ":" + encodeURIComponent(templateId || "markets");
  }

  /* A post's stable identity. The X status id where the feed has one, the
     permalink otherwise — both survive a refresh, unlike an array index. */
  function postKey(post) {
    if (!post) return "";
    if (post.id !== undefined && post.id !== null && String(post.id)) return "id:" + String(post.id);
    return post.url ? "url:" + String(post.url) : "";
  }

  function timeOf(post) {
    var ms = post && post.publishedAt ? new Date(post.publishedAt).getTime() : NaN;
    return isFinite(ms) ? ms : null;
  }

  /* ── Display mode ─────────────────────────────────────────────────────── */

  function normalizeView(value) {
    return VIEW_MODES.indexOf(value) >= 0 ? value : DEFAULT_VIEW;
  }

  function readView(storage) {
    return normalizeView(storageGet(storage, KEYS.view));
  }

  function writeView(storage, view) {
    storageSet(storage, KEYS.view, normalizeView(view));
  }

  /* ── Background motion ────────────────────────────────────────────────── */

  /* An explicit choice wins. Without one, the operating system's reduced
     motion request decides — so nobody who asked their OS for less motion
     sees an animated background they did not opt into. */
  function resolveMotion(stored, prefersReduced) {
    if (stored === "on" || stored === "off") return stored;
    return prefersReduced ? "off" : "on";
  }

  function readMotion(storage, prefersReduced) {
    return resolveMotion(storageGet(storage, KEYS.motion), prefersReduced);
  }

  function writeMotion(storage, value) {
    storageSet(storage, KEYS.motion, value === "off" ? "off" : "on");
  }

  /* ── Filters ──────────────────────────────────────────────────────────── */

  function defaultFilters() {
    return { query: "", time: "all", media: false };
  }

  function normalizeFilters(value) {
    var f = defaultFilters();
    if (value && typeof value === "object") {
      if (typeof value.query === "string") f.query = value.query;
      if (TIME_KEYS.indexOf(value.time) >= 0) f.time = value.time;
      f.media = value.media === true;
    }
    return f;
  }

  function isDefaultFilters(filters) {
    var f = normalizeFilters(filters);
    return !f.query.trim() && f.time === "all" && !f.media;
  }

  /* Time and media are remembered per template; the search box is not — a
     forgotten query silently hiding posts on the next visit is worse than
     retyping it. */
  function readFilters(storage, templateId) {
    var parsed = null;
    try { parsed = JSON.parse(storageGet(storage, templateKey(KEYS.filters, templateId)) || "null"); } catch (err) {}
    var f = normalizeFilters(parsed);
    f.query = "";
    return f;
  }

  function writeFilters(storage, templateId, filters) {
    var f = normalizeFilters(filters);
    storageSet(storage, templateKey(KEYS.filters, templateId), JSON.stringify({ time: f.time, media: f.media }));
  }

  /* Filters only what is already loaded. A post with no usable timestamp is
     kept under "All" and dropped by any time window: unknown age is not
     evidence that it is recent. */
  function filterPosts(posts, filters, now) {
    var f = normalizeFilters(filters);
    var clock = typeof now === "number" ? now : Date.now();
    var needle = f.query.trim().toLowerCase();
    var windowMs = TIME_WINDOWS[f.time] || 0;
    return (posts || []).filter(function (post) {
      if (!post) return false;
      if (f.media && !post.image) return false;
      if (windowMs) {
        var t = timeOf(post);
        if (t === null || clock - t > windowMs) return false;
      }
      if (needle) {
        var hay = [post.text, post.handle ? "@" + post.handle : "", post.label, post.category]
          .filter(Boolean).join("\n").toLowerCase();
        if (hay.indexOf(needle) < 0) return false;
      }
      return true;
    });
  }

  /* ── New-post awareness ───────────────────────────────────────────────── */

  /* The stored record is the set of posts this device has already been shown
     for a template, as [key, publishedAtMs] pairs. */
  function readSeen(storage, templateId) {
    var parsed = null;
    try { parsed = JSON.parse(storageGet(storage, templateKey(KEYS.seen, templateId)) || "null"); } catch (err) {}
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    var entries = parsed.entries.filter(function (e) {
      return Array.isArray(e) && typeof e[0] === "string" && e[0];
    });
    return { entries: entries };
  }

  function writeSeen(storage, templateId, record) {
    if (!record) return;
    storageSet(storage, templateKey(KEYS.seen, templateId), JSON.stringify({ v: 1, entries: record.entries }));
  }

  /* Which of `posts` are new relative to `record`.

     No record means this device has never seen the template: nothing is
     flagged, rather than every post on a first visit. A post is new only if
     its identifier is not in the record AND it is no older than the oldest
     post the record still remembers — so a post that merely aged out of the
     bounded record is not flagged as new again. Nothing here is inferred from
     the feed having refreshed successfully. */
  function findNewPosts(record, posts) {
    var result = {};
    if (!record) return result;
    var known = {};
    var floor = null;
    record.entries.forEach(function (e) {
      known[e[0]] = true;
      var t = Number(e[1]);
      if (isFinite(t) && t > 0 && (floor === null || t < floor)) floor = t;
    });
    (posts || []).forEach(function (post) {
      var key = postKey(post);
      if (!key || known[key]) return;
      var t = timeOf(post);
      if (floor !== null && (t === null || t < floor)) return;
      result[key] = true;
    });
    return result;
  }

  function mergeSeen(record, posts, limit) {
    var max = typeof limit === "number" && limit > 0 ? limit : SEEN_LIMIT;
    var byKey = {};
    var all = [];
    function add(key, t) {
      if (!key || byKey[key]) return;
      byKey[key] = true;
      all.push([key, isFinite(t) && t > 0 ? t : 0]);
    }
    (posts || []).forEach(function (post) { add(postKey(post), timeOf(post)); });
    ((record && record.entries) || []).forEach(function (e) { add(e[0], Number(e[1])); });
    all.sort(function (a, b) { return b[1] - a[1]; });
    return { entries: all.slice(0, max) };
  }

  function countKeys(map) {
    var n = 0;
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) n += 1;
    return n;
  }

  return {
    VIEW_MODES: VIEW_MODES,
    DEFAULT_VIEW: DEFAULT_VIEW,
    TIME_KEYS: TIME_KEYS,
    KEYS: KEYS,
    SEEN_LIMIT: SEEN_LIMIT,
    postKey: postKey,
    normalizeView: normalizeView,
    readView: readView,
    writeView: writeView,
    resolveMotion: resolveMotion,
    readMotion: readMotion,
    writeMotion: writeMotion,
    defaultFilters: defaultFilters,
    normalizeFilters: normalizeFilters,
    isDefaultFilters: isDefaultFilters,
    readFilters: readFilters,
    writeFilters: writeFilters,
    filterPosts: filterPosts,
    readSeen: readSeen,
    writeSeen: writeSeen,
    findNewPosts: findNewPosts,
    mergeSeen: mergeSeen,
    countKeys: countKeys,
  };
});
