/* YouTube Intelligence play queue: the "Up next" list, kept per viewer in
   localStorage so it survives reloads and category switches.

   The store is plain data with no DOM, so it can be unit tested under Node.
   youtube-v2.js owns the rendering and the player. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YoutubeQueue = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_KEY = "yt:queue:v1";
  var DEFAULT_LIMIT = 200;
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  function text(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  function httpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value) ? value.slice(0, 2048) : "";
  }

  /* Keep only the fields the queue needs to show and replay a video. Anything
     read back from storage passes through here, so a hand-edited or older
     entry can never inject an unexpected URL scheme. */
  function sanitize(entry) {
    if (!entry || typeof entry !== "object") return null;
    var id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!ID_PATTERN.test(id)) return null;
    var thumbnail = typeof entry.thumbnail === "string" && /^(https?:|data:image\/)/i.test(entry.thumbnail)
      ? entry.thumbnail.slice(0, 8192)
      : "";
    var state = entry.state === "live" || entry.state === "upcoming" ? entry.state : "video";
    return {
      id: id,
      title: text(entry.title, 300) || "Untitled video",
      channelLabel: text(entry.channelLabel, 120),
      channelHandle: text(entry.channelHandle, 120),
      channelCategory: text(entry.channelCategory, 120),
      thumbnail: thumbnail,
      url: httpUrl(entry.url),
      state: state,
      publishedAt: text(entry.publishedAt, 40),
      scheduledStartTime: text(entry.scheduledStartTime, 40),
    };
  }

  function createQueue(options) {
    options = options || {};
    var storage = options.storage || null;
    var key = options.key || DEFAULT_KEY;
    var limit = options.limit || DEFAULT_LIMIT;
    var listeners = [];
    var items = read();

    function read() {
      var raw;
      try {
        raw = storage ? storage.getItem(key) : null;
      } catch (err) {
        // Private mode and blocked site data both throw. Start empty.
        return [];
      }
      if (!raw) return [];
      var parsed;
      try { parsed = JSON.parse(raw); } catch (err) { return []; }
      if (!Array.isArray(parsed)) return [];
      var seen = {};
      return parsed.map(sanitize).filter(function (entry) {
        if (!entry || seen[entry.id]) return false;
        seen[entry.id] = true;
        return true;
      }).slice(0, limit);
    }

    function write() {
      try {
        if (!storage) return;
        if (items.length) storage.setItem(key, JSON.stringify(items));
        else storage.removeItem(key);
      } catch (err) {
        /* best effort: the queue still works for this page view */
      }
    }

    function changed() {
      write();
      var snapshot = list();
      listeners.forEach(function (fn) { fn(snapshot); });
    }

    function list() {
      return items.map(function (entry) { return Object.assign({}, entry); });
    }

    function indexOf(id) {
      for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
      return -1;
    }

    return {
      key: key,
      list: list,
      size: function () { return items.length; },
      has: function (id) { return indexOf(id) !== -1; },
      peek: function () { return items.length ? Object.assign({}, items[0]) : null; },

      /* Appends to the end, like YouTube's "Add to queue". Returns false when
         the video is already queued, invalid, or the queue is full. */
      add: function (entry) {
        var clean = sanitize(entry);
        if (!clean || indexOf(clean.id) !== -1 || items.length >= limit) return false;
        items.push(clean);
        changed();
        return true;
      },

      remove: function (id) {
        var index = indexOf(id);
        if (index === -1) return false;
        items.splice(index, 1);
        changed();
        return true;
      },

      /* Moves a queued video to a new position (clamped to the list). */
      move: function (id, toIndex) {
        var from = indexOf(id);
        if (from === -1) return false;
        var to = Math.max(0, Math.min(items.length - 1, Number(toIndex) || 0));
        if (to === from) return false;
        var entry = items.splice(from, 1)[0];
        items.splice(to, 0, entry);
        changed();
        return true;
      },

      /* Takes the next video off the front of the queue. */
      shift: function () {
        if (!items.length) return null;
        var entry = items.shift();
        changed();
        return Object.assign({}, entry);
      },

      clear: function () {
        if (!items.length) return;
        items = [];
        changed();
      },

      /* Re-reads storage, e.g. after another tab edited the queue. */
      reload: function () {
        items = read();
        var snapshot = list();
        listeners.forEach(function (fn) { fn(snapshot); });
      },

      subscribe: function (fn) {
        listeners.push(fn);
        return function () {
          listeners = listeners.filter(function (other) { return other !== fn; });
        };
      },
    };
  }

  return { createQueue: createQueue, sanitize: sanitize, DEFAULT_KEY: DEFAULT_KEY };
});
