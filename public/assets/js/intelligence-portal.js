/* Intelligence Portal: two launchers, one for X Intelligence and one for
   YouTube Intelligence, each with its own category dropdown.

   Each dropdown is read live from its own registry — X templates from
   /api/x/templates, YouTube categories from /api/youtube/channels/config —
   so a template or category added, renamed or deleted on its page shows up
   here with no copy to keep in step. Open goes to that page already on the
   chosen category. No posts or videos load here.

   The two portals load and fail independently. Once both lists are in,
   intelligence-portal-sync.js pairs them by name so each portal can point at
   the same subject on the other side ("Also on YouTube: War"). */
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

  function selected(kind) {
    var id = els[kind].select.value;
    return (lists[kind] || []).filter(function (item) { return String(item.id) === id; })[0] || null;
  }

  /* The same subject on the other page, when the two names pair up. */
  function counterpart(kind, id) {
    var entry = pairs.filter(function (pair) { return pair[kind] && pair[kind].id === id; })[0];
    return entry && entry[PORTALS[kind].other] ? entry[PORTALS[kind].other] : null;
  }

  function updateHint(kind) {
    var portal = PORTALS[kind];
    var hint = els[kind].hint;
    var item = selected(kind);
    els[kind].go.disabled = !item;
    hint.textContent = "";
    if (!item) return;

    hint.appendChild(document.createTextNode(
      "Opens " + portal.page + " on “" + (item.name || item.id) + "” (" + portal.count(item) + " " + portal.unit + ")."
    ));

    var match = counterpart(kind, String(item.id));
    if (match) {
      var otherKind = portal.other;
      hint.appendChild(document.createTextNode(" Also on " + (otherKind === "x" ? "X" : "YouTube") + ": "));
      var link = document.createElement("a");
      link.href = hrefFor(otherKind, match.id);
      link.textContent = match.name;
      hint.appendChild(link);
    }
  }

  function renderSelect(kind, items) {
    var select = els[kind].select;
    var portal = PORTALS[kind];
    select.innerHTML = "";
    items.forEach(function (item) {
      var option = document.createElement("option");
      option.value = String(item.id);
      option.textContent = (item.name || item.id) + " (" + portal.count(item) + ")";
      select.appendChild(option);
    });
    if (!items.length) {
      var none = document.createElement("option");
      none.textContent = "No categories yet — add one in " + portal.page;
      select.appendChild(none);
    }
    select.disabled = !items.length;
    var keep = readStore(portal.storageKey);
    if (items.some(function (item) { return String(item.id) === keep; })) select.value = keep;
  }

  function loadPortal(kind) {
    var portal = PORTALS[kind];
    return getJson(portal.url)
      .then(function (data) {
        lists[kind] = portal.read(data);
        renderSelect(kind, lists[kind]);
        updateHint(kind);
      })
      .catch(function () {
        lists[kind] = [];
        els[kind].select.innerHTML = "<option>Unavailable</option>";
        els[kind].select.disabled = true;
        els[kind].go.disabled = true;
        els[kind].hint.textContent = portal.page + " categories are unavailable right now.";
        els[kind].hint.classList.add("ip-hint--error");
      });
  }

  function loadAll() {
    Object.keys(PORTALS).forEach(function (kind) { els[kind].hint.classList.remove("ip-hint--error"); });
    return Promise.all([loadPortal("x"), loadPortal("youtube")]).then(function () {
      pairs = Sync.mergeCategories(lists.x, lists.youtube);
      if (lists.x && lists.x.length) updateHint("x");
      if (lists.youtube && lists.youtube.length) updateHint("youtube");
    });
  }

  /* The sidebar's X Portal and YouTube Portal links land on #x and #youtube.
     Clicking one while already here only changes the hash, so listen for it. */
  function spotlight() {
    var kind = (window.location.hash || "").replace(/^#/, "");
    Object.keys(PORTALS).forEach(function (key) {
      els[key].form.classList.toggle("is-spotlit", key === kind);
    });
    if (PORTALS[kind] && !els[kind].select.disabled) els[kind].select.focus({ preventScroll: true });
  }

  function init() {
    if (!Sync) return;
    var ok = true;
    Object.keys(PORTALS).forEach(function (kind) {
      var form = document.querySelector('[data-portal="' + kind + '"]');
      if (!form) { ok = false; return; }
      els[kind] = {
        form: form,
        select: form.querySelector("select"),
        go: form.querySelector(".ip-go"),
        hint: form.querySelector(".ip-hint"),
      };
    });
    if (!ok) return;

    Object.keys(PORTALS).forEach(function (kind) {
      var portal = PORTALS[kind];
      els[kind].select.addEventListener("change", function () {
        writeStore(portal.storageKey, els[kind].select.value);
        updateHint(kind);
      });
      els[kind].form.addEventListener("submit", function (event) {
        event.preventDefault();
        var item = selected(kind);
        if (!item) return;
        writeStore(portal.storageKey, String(item.id));
        window.location.assign(hrefFor(kind, String(item.id)));
      });
    });

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
