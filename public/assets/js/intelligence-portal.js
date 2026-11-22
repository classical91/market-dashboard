/* Intelligence Portal: two launchers, one for X Intelligence and one for
   YouTube Intelligence, each listing its categories as one-click links.

   Each list is read live from its own registry — X templates from
   /api/x/templates, YouTube categories from /api/youtube/channels/config —
   so a template or category added, renamed or deleted on its page shows up
   here with no copy to keep in step. Each link goes to that page already on its
   category. No posts or videos load here.

   The two portals load and fail independently. Once both lists are in,
   intelligence-portal-sync.js pairs them by name so each portal can point at
   the same subject on the other side (an "Also on YouTube: War" link). */
(function () {
  "use strict";

  var Sync = window.IntelligencePortalSync;

  var PORTALS = {
    x: {
      url: "/api/x/templates",
      read: function (data) { return (data && data.templates) || []; },
      storageKey: "intelligencePortal:x:v1",
      page: "X Intelligence",
      unit: "accounts",
      count: function (item) { return Array.isArray(item.handles) ? item.handles.length : 0; },
      other: "youtube",
    },
    youtube: {
      url: "/api/youtube/channels/config",
      read: function (data) { return (data && data.categories) || []; },
      storageKey: "intelligencePortal:youtube:v1",
      page: "YouTube Intelligence",
      unit: "channels",
      count: function (item) { return Number(item.channelCount || 0); },
      other: "x",
    },
  };

  var lists = { x: null, youtube: null };
  var pairs = [];
  var els = {};

  function readStore(key) {
    try { return window.localStorage.getItem(key) || ""; } catch (err) { return ""; }
  }

  function writeStore(key, value) {
    try { window.localStorage.setItem(key, value); } catch (err) { /* best effort */ }
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("Request failed: " + res.status);
      return res.json();
    });
  }

  function hrefFor(kind, id) {
    var entry = {};
    entry[kind] = { id: id };
    return Sync.destinationHref(entry, kind);
  }

  /* The same subject on the other page, when the two names pair up. */
  function counterpart(kind, id) {
    var entry = pairs.filter(function (pair) { return pair[kind] && pair[kind].id === id; })[0];
    return entry && entry[PORTALS[kind].other] ? entry[PORTALS[kind].other] : null;
  }

  function note(kind, text) {
    var item = document.createElement("li");
    item.className = "ip-cats-note";
    item.textContent = text;
    els[kind].list.replaceChildren(item);
  }

  /* One link per category: a click opens the page on it. A paired category
     also carries a small link to the same subject on the other page. */
  function renderList(kind) {
    var portal = PORTALS[kind];
    var items = lists[kind] || [];
    var list = els[kind].list;
    var last = readStore(portal.storageKey);
    var otherLabel = portal.other === "x" ? "X" : "YouTube";
    list.setAttribute("aria-busy", "false");
    els[kind].hint.classList.remove("ip-hint--error");
    els[kind].hint.textContent = "";
    if (!items.length) {
      note(kind, "No categories yet — add one in " + portal.page + ".");
      return;
    }

    list.replaceChildren();
    items.forEach(function (item) {
      var id = String(item.id);
      var name = item.name || id;
      var count = portal.count(item);
      var li = document.createElement("li");
      li.className = "ip-cat" + (id === last ? " is-last" : "");

      var link = document.createElement("a");
      link.className = "ip-cat-link";
      link.href = hrefFor(kind, id);
      link.title = "Open " + portal.page + " on “" + name + "” (" + count + " " + portal.unit + ")";
      link.appendChild(document.createTextNode(name));
      var badge = document.createElement("span");
      badge.className = "ip-cat-count";
      badge.textContent = String(count);
      badge.setAttribute("aria-label", count + " " + portal.unit);
      link.appendChild(badge);
      link.addEventListener("click", function () { writeStore(portal.storageKey, id); });
      li.appendChild(link);

      var match = counterpart(kind, id);
      if (match) {
        var pair = document.createElement("a");
        pair.className = "ip-cat-pair";
        pair.href = hrefFor(portal.other, match.id);
        pair.textContent = portal.other === "x" ? "X" : "YT";
        pair.title = "Also on " + otherLabel + ": " + match.name;
        pair.setAttribute("aria-label", "Also on " + otherLabel + ": " + match.name);
        pair.addEventListener("click", function () { writeStore(PORTALS[portal.other].storageKey, String(match.id)); });
        li.appendChild(pair);
      }
      list.appendChild(li);
    });
  }

  function loadPortal(kind) {
    var portal = PORTALS[kind];
    return getJson(portal.url)
      .then(function (data) {
        lists[kind] = portal.read(data);
      })
      .catch(function () {
        lists[kind] = null;
      });
  }

  function loadAll() {
    return Promise.all([loadPortal("x"), loadPortal("youtube")]).then(function () {
      pairs = Sync.mergeCategories(lists.x || [], lists.youtube || []);
      Object.keys(PORTALS).forEach(function (kind) {
        if (lists[kind]) { renderList(kind); return; }
        els[kind].list.setAttribute("aria-busy", "false");
        note(kind, "Unavailable");
        els[kind].hint.textContent = PORTALS[kind].page + " categories are unavailable right now.";
        els[kind].hint.classList.add("ip-hint--error");
      });
    });
  }

  /* Keep existing #x and #youtube bookmarks working, including hash changes
     while the shared portal is already open. */
  function spotlight() {
    var kind = (window.location.hash || "").replace(/^#/, "");
    Object.keys(PORTALS).forEach(function (key) {
      els[key].section.classList.toggle("is-spotlit", key === kind);
    });
    if (!PORTALS[kind]) return;
    var first = els[kind].list.querySelector(".is-last .ip-cat-link") || els[kind].list.querySelector(".ip-cat-link");
    if (first) first.focus({ preventScroll: true });
  }

  function init() {
    if (!Sync) return;
    var ok = true;
    Object.keys(PORTALS).forEach(function (kind) {
      var section = document.querySelector('[data-portal="' + kind + '"]');
      if (!section) { ok = false; return; }
      els[kind] = {
        section: section,
        list: section.querySelector(".ip-cats"),
        hint: section.querySelector(".ip-hint"),
      };
    });
    if (!ok) return;

    window.addEventListener("hashchange", spotlight);

    // Categories edited in another tab show up when this one comes back.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && (lists.x || lists.youtube)) loadAll();
    });

    loadAll().then(spotlight);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
