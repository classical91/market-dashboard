/* Intelligence Portal: a launcher into X Intelligence and YouTube
   Intelligence.

   Two dropdowns — a category and a destination — and an Open button that
   goes to that page already on the chosen category. No posts or videos load
   here. The category list is read live from both registries
   (/api/x/templates and /api/youtube/channels/config) and paired by
   intelligence-portal-sync.js, so templates and categories added on either
   page appear here without any copy to keep in step. */
(function () {
  "use strict";

  var Sync = window.IntelligencePortalSync;
  var STORAGE_KEY = "intelligencePortal:category:v1";
  var DEST_KEY = "intelligencePortal:destination:v1";
  var PAGE_NAMES = { x: "X Intelligence", youtube: "YouTube Intelligence" };

  var els = {};
  var state = { entries: [] };

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

  function activeEntry() {
    var key = els.category.value;
    return state.entries.filter(function (entry) { return entry.key === key; })[0] || null;
  }

  function optionLabel(entry) {
    var where = entry.x && entry.youtube ? "X + YouTube" : entry.x ? "X only" : "YouTube only";
    return entry.name + " — " + where;
  }

  function renderCategories(selectedKey) {
    var select = els.category;
    select.innerHTML = "";
    state.entries.forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry.key;
      option.textContent = optionLabel(entry);
      select.appendChild(option);
    });
    if (!state.entries.length) {
      var none = document.createElement("option");
      none.textContent = "No categories yet";
      select.appendChild(none);
    }
    select.disabled = !state.entries.length;
    var chosen = Sync.pickEntry(state.entries, { key: selectedKey });
    if (chosen) select.value = chosen.key;
  }

  /* A destination with no matching category stays visible but disabled, so
     it is clear the category exists only on the other page. */
  function updateDestinations() {
    var entry = activeEntry();
    var dest = els.destination;
    var available = [];
    Array.prototype.forEach.call(dest.options, function (option) {
      var ok = !!Sync.destinationHref(entry, option.value);
      option.disabled = !ok;
      option.textContent = PAGE_NAMES[option.value] + (ok ? "" : " (no matching category)");
      if (ok) available.push(option.value);
    });
    if (available.indexOf(dest.value) === -1 && available.length) dest.value = available[0];
    dest.disabled = !entry;
    els.go.disabled = !entry || !available.length;

    if (!entry) {
      els.hint.textContent = "";
      return;
    }
    var source = dest.value === "x" ? entry.x : entry.youtube;
    var count = source ? source.count + (dest.value === "x" ? " accounts" : " channels") : "";
    els.hint.textContent = source
      ? "Opens " + PAGE_NAMES[dest.value] + " on “" + source.name + "” (" + count + ")."
      : "";
  }

  function loadCategories() {
    var failed = [];
    return Promise.all([
      getJson("/api/x/templates").then(function (data) { return (data && data.templates) || []; })
        .catch(function () { failed.push("X Intelligence"); return []; }),
      getJson("/api/youtube/channels/config").then(function (data) { return (data && data.categories) || []; })
        .catch(function () { failed.push("YouTube Intelligence"); return []; }),
    ]).then(function (lists) {
      var keep = els.category.disabled ? readStore(STORAGE_KEY) : els.category.value;
      state.entries = Sync.mergeCategories(lists[0], lists[1]);
      renderCategories(keep);
      updateDestinations();
      if (failed.length) {
        els.hint.textContent = failed.join(" and ") + " categories are unavailable right now"
          + (state.entries.length ? "; showing the rest." : ".");
      }
    });
  }

  function init() {
    els = {
      form: document.getElementById("ipLauncher"),
      category: document.getElementById("ipCategory"),
      destination: document.getElementById("ipDestination"),
      go: document.getElementById("ipGo"),
      hint: document.getElementById("ipHint"),
    };
    if (!els.form || !Sync) return;

    var storedDest = readStore(DEST_KEY);
    if (PAGE_NAMES[storedDest]) els.destination.value = storedDest;

    els.category.addEventListener("change", function () {
      writeStore(STORAGE_KEY, els.category.value);
      updateDestinations();
    });
    els.destination.addEventListener("change", function () {
      writeStore(DEST_KEY, els.destination.value);
      updateDestinations();
    });
    els.form.addEventListener("submit", function (event) {
      event.preventDefault();
      var href = Sync.destinationHref(activeEntry(), els.destination.value);
      if (!href) return;
      writeStore(STORAGE_KEY, els.category.value);
      writeStore(DEST_KEY, els.destination.value);
      window.location.assign(href);
    });

    // Categories edited in another tab show up when this one comes back.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.entries.length) loadCategories();
    });

    loadCategories();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
