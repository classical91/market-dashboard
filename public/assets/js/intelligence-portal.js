/* Intelligence Portal: one category dropdown over X Intelligence and YouTube
   Intelligence.

   The category list is never stored here. It is read live from the two
   registries (/api/x/templates and /api/youtube/channels/config) and paired
   by intelligence-portal-sync.js, so a template or category added, renamed or
   deleted on either page shows up the next time this page loads, refreshes,
   or comes back into view. */
(function () {
  "use strict";

  var Sync = window.IntelligencePortalSync;
  var XPosts = window.XPosts;
  var STORAGE_KEY = "intelligencePortal:category:v1";
  var MAX_POSTS = 40;
  var MAX_VIDEOS = 24;
  var DEFAULT_SUMMARY = "One category list, synced from X Intelligence and YouTube Intelligence";

  var els = {};
  var state = { entries: [], active: null, loadToken: 0 };

  function byId(id) { return document.getElementById(id); }

  function readStored() {
    try { return window.localStorage.getItem(STORAGE_KEY) || ""; } catch (err) { return ""; }
  }

  function writeStored(key) {
    try { window.localStorage.setItem(STORAGE_KEY, key); } catch (err) { /* best effort */ }
  }

  function urlPreferences() {
    try {
      var params = new URL(window.location.href).searchParams;
      return { x: params.get("x") || "", youtube: params.get("youtube") || "" };
    } catch (err) {
      return {};
    }
  }

  function syncUrl(entry) {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete("x");
      url.searchParams.delete("youtube");
      if (entry && entry.x) url.searchParams.set("x", entry.x.id);
      if (entry && entry.youtube) url.searchParams.set("youtube", entry.youtube.id);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (err) { /* the page works without a shareable URL */ }
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("Request failed: " + res.status);
      return res.json();
    });
  }

  function empty(root, text, tone) {
    root.innerHTML = "";
    var node = document.createElement("div");
    node.className = "ip-empty" + (tone ? " ip-empty--" + tone : "");
    node.textContent = text;
    root.appendChild(node);
  }

  function setStatus(node, text, tone) {
    node.textContent = text || "";
    node.className = "ip-panel-status" + (tone ? " ip-panel-status--" + tone : "");
    node.hidden = !text;
  }

  /* ── Dropdown ─────────────────────────────────────────── */

  function optionLabel(entry) {
    var parts = [];
    if (entry.x) parts.push("X " + entry.x.count);
    if (entry.youtube) parts.push("YT " + entry.youtube.count);
    return entry.name + " (" + parts.join(" · ") + ")";
  }

  function renderDropdown() {
    var select = els.select;
    select.innerHTML = "";
    var groups = [
      { label: "On X and YouTube", test: function (e) { return e.x && e.youtube; } },
      { label: "X only", test: function (e) { return e.x && !e.youtube; } },
      { label: "YouTube only", test: function (e) { return !e.x && e.youtube; } },
    ];
    groups.forEach(function (group) {
      var members = state.entries.filter(group.test);
      if (!members.length) return;
      var optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      members.forEach(function (entry) {
        var option = document.createElement("option");
        option.value = entry.key;
        option.textContent = optionLabel(entry);
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });
    if (!state.entries.length) {
      var none = document.createElement("option");
      none.textContent = "No categories yet";
      select.appendChild(none);
    }
    select.disabled = !state.entries.length;
    if (state.active) select.value = state.active.key;
  }

  function sourceCard(kind, source, href, pageName) {
    var card = document.createElement(source ? "a" : "div");
    card.className = "ip-source ip-source--" + kind + (source ? "" : " is-missing");
    var label = kind === "x" ? "X Intelligence" : "YouTube Intelligence";
    var unit = kind === "x" ? "accounts" : "channels";
    if (source) {
      card.href = href;
      card.innerHTML = '<span class="ip-source-kind"></span><span class="ip-source-name"></span><span class="ip-source-count"></span>';
      card.children[0].textContent = label;
      card.children[1].textContent = source.name;
      card.children[2].textContent = source.count + " " + unit;
    } else {
      card.innerHTML = '<span class="ip-source-kind"></span><span class="ip-source-name"></span>';
      card.children[0].textContent = label;
      card.children[1].textContent = "No matching category — add one in " + pageName;
    }
    return card;
  }

  function renderSources(entry) {
    els.sources.innerHTML = "";
    if (!entry) return;
    els.sources.appendChild(sourceCard("x", entry.x, xHref(entry), "X Intelligence"));
    els.sources.appendChild(sourceCard("yt", entry.youtube, ytHref(entry), "YouTube Intelligence"));
    var note = entry.match === "partial"
      ? "Linked by name: “" + entry.x.name + "” on X and “" + entry.youtube.name + "” on YouTube."
      : entry.match === "exact"
        ? "Synced: the same category on X and YouTube."
        : "Only on " + (entry.x ? "X" : "YouTube") + " so far.";
    els.summary.textContent = (entry.x && entry.x.description) || DEFAULT_SUMMARY;
    var tag = document.createElement("div");
    tag.className = "ip-source-note";
    tag.textContent = note;
    els.sources.appendChild(tag);
  }

  function xHref(entry) {
    return entry && entry.x ? "/x-intelligence.html?template=" + encodeURIComponent(entry.x.id) : "/x-intelligence.html";
  }

  function ytHref(entry) {
    return entry && entry.youtube ? "/youtube-v2.html?category=" + encodeURIComponent(entry.youtube.id) : "/youtube-v2.html";
  }

  /* ── X posts ──────────────────────────────────────────── */

  function loadX(entry, token) {
    els.xLink.href = xHref(entry);
    if (!entry.x) {
      setStatus(els.xStatus, "");
      empty(els.xFeed, "No X template matches " + entry.name + ". Create one named “" + entry.name + "” in X Intelligence to sync it here.");
      return;
    }
    setStatus(els.xStatus, "");
    empty(els.xFeed, "Loading X posts…");
    getJson("/api/x/accounts?template=" + encodeURIComponent(entry.x.id))
      .then(function (data) {
        if (token !== state.loadToken) return;
        var posts = Array.isArray(data && data.posts) ? data.posts : [];
        var failed = (data && data.failedFeeds) || [];
        if (!posts.length) {
          empty(els.xFeed, failed.length
            ? "X feeds are unavailable right now for " + entry.x.name + "."
            : (entry.x.count ? "No posts from " + entry.x.name + " accounts yet." : "No accounts in " + entry.x.name + " yet."),
          failed.length ? "error" : "");
          return;
        }
        var shown = XPosts.sortByPublishedDesc(posts).slice(0, MAX_POSTS);
        XPosts.renderPostCards(els.xFeed, shown, "No posts yet.", null);
        var notes = [];
        if (posts.length > shown.length) notes.push("Showing the newest " + shown.length + " of " + posts.length + " posts");
        if (failed.length) notes.push(failed.length + " account" + (failed.length === 1 ? "" : "s") + " could not be refreshed");
        if (data.status && data.status !== "live") notes.push("Feed status: " + data.status);
        setStatus(els.xStatus, notes.join(" · "), failed.length ? "warn" : "");
      })
      .catch(function () {
        if (token !== state.loadToken) return;
        empty(els.xFeed, "X posts are unavailable right now.", "error");
      });
  }

  /* ── YouTube videos ───────────────────────────────────── */

  function relative(iso) {
    return iso && XPosts.formatRelativeDate ? XPosts.formatRelativeDate(iso) : "";
  }

  function videoCard(video) {
    var card = document.createElement("a");
    card.className = "yt-feed-card" + (video.state === "live" ? " yt-feed-card-live" : "") + (video.state === "upcoming" ? " yt-feed-card-upcoming" : "");
    card.href = video.url || "https://www.youtube.com/watch?v=" + encodeURIComponent(video.id || "");
    card.target = "_blank";
    card.rel = "noopener";

    var thumb = document.createElement("div");
    thumb.className = "yt-feed-thumb";
    var thumbUrl = video.thumbnail || (video.id ? "https://img.youtube.com/vi/" + encodeURIComponent(video.id) + "/hqdefault.jpg" : "");
    if (thumbUrl) thumb.style.backgroundImage = "url('" + String(thumbUrl).replace(/'/g, "%27") + "')";
    if (video.state === "live" || video.state === "upcoming") {
      var badge = document.createElement("span");
      badge.className = "yt-badge yt-badge-" + video.state;
      badge.textContent = video.state === "live" ? "LIVE" : "UPCOMING";
      thumb.appendChild(badge);
    }

    var body = document.createElement("div");
    body.className = "yt-feed-body";
    var title = document.createElement("div");
    title.className = "yt-feed-title";
    title.textContent = video.title || "Untitled video";
    var meta = document.createElement("div");
    meta.className = "yt-feed-meta";
    var tag = document.createElement("span");
    tag.className = "yt-tag";
    tag.textContent = video.channelLabel || video.channelHandle || "YouTube";
    meta.appendChild(tag);
    var when = video.state === "live" ? "Streaming now" : video.state === "upcoming" ? "Scheduled" : relative(video.publishedAt);
    if (when) {
      var detail = document.createElement("span");
      detail.className = "yt-feed-detail";
      detail.textContent = " · " + when;
      meta.appendChild(detail);
    }
    body.appendChild(title);
    body.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(body);

    card.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !video.id) return;
      event.preventDefault();
      play(video.id);
    });
    return card;
  }

  function play(id) {
    els.playerFrame.src = "https://www.youtube.com/embed/" + encodeURIComponent(id);
    els.playerLink.href = "https://youtu.be/" + encodeURIComponent(id);
    els.player.hidden = false;
    els.player.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closePlayer() {
    els.playerFrame.src = "";
    els.player.hidden = true;
  }

  function collectVideos(data) {
    var seen = {};
    var list = [].concat(data.live || [], data.upcoming || [], data.videos || []);
    if (!list.length && Array.isArray(data.channels)) {
      data.channels.forEach(function (channel) {
        (channel.videos || []).forEach(function (video) {
          list.push(Object.assign({ channelLabel: channel.label }, video));
        });
      });
    }
    return list.filter(function (video) {
      var key = video && (video.id || video.url);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function loadYoutube(entry, token) {
    els.ytLink.href = ytHref(entry);
    closePlayer();
    if (!entry.youtube) {
      setStatus(els.ytStatus, "");
      empty(els.ytFeed, "No YouTube category matches " + entry.name + ". Create one named “" + entry.name + "” in YouTube Intelligence to sync it here.");
      return;
    }
    setStatus(els.ytStatus, "");
    empty(els.ytFeed, "Loading YouTube videos…");
    getJson("/api/youtube/channels?categoryId=" + encodeURIComponent(entry.youtube.id))
      .then(function (data) {
        if (token !== state.loadToken) return;
        var videos = collectVideos(data || {});
        var failed = (data && data.failedFeeds) || [];
        if (!videos.length) {
          empty(els.ytFeed, failed.length
            ? "YouTube feeds are unavailable right now for " + entry.youtube.name + "."
            : (entry.youtube.count ? "No videos from " + entry.youtube.name + " channels yet." : "No channels in " + entry.youtube.name + " yet."),
          failed.length ? "error" : "");
          return;
        }
        var shown = videos.slice(0, MAX_VIDEOS);
        els.ytFeed.innerHTML = "";
        var grid = document.createElement("div");
        grid.className = "yt-channel-videos";
        shown.forEach(function (video) { grid.appendChild(videoCard(video)); });
        els.ytFeed.appendChild(grid);
        var notes = [];
        if (videos.length > shown.length) notes.push("Showing " + shown.length + " of " + videos.length + " videos");
        if (failed.length) notes.push(failed.length + " channel" + (failed.length === 1 ? "" : "s") + " could not be refreshed");
        setStatus(els.ytStatus, notes.join(" · "), failed.length ? "warn" : "");
      })
      .catch(function () {
        if (token !== state.loadToken) return;
        empty(els.ytFeed, "YouTube videos are unavailable right now.", "error");
      });
  }

  /* ── Wiring ───────────────────────────────────────────── */

  function select(entry) {
    state.active = entry;
    state.loadToken += 1;
    if (!entry) {
      renderSources(null);
      empty(els.xFeed, "No X templates or YouTube categories yet.");
      empty(els.ytFeed, "No X templates or YouTube categories yet.");
      return;
    }
    writeStored(entry.key);
    syncUrl(entry);
    if (els.select.value !== entry.key) els.select.value = entry.key;
    renderSources(entry);
    loadX(entry, state.loadToken);
    loadYoutube(entry, state.loadToken);
  }

  /* Each side fails on its own: an X outage still leaves the YouTube
     categories in the dropdown, and the other way round. */
  function loadCategories(options) {
    var reloadFeeds = !options || options.reloadFeeds !== false;
    var xFailed = false;
    var ytFailed = false;
    return Promise.all([
      getJson("/api/x/templates").then(function (data) { return (data && data.templates) || []; })
        .catch(function () { xFailed = true; return []; }),
      getJson("/api/youtube/channels/config").then(function (data) { return (data && data.categories) || []; })
        .catch(function () { ytFailed = true; return []; }),
    ]).then(function (lists) {
      var previous = state.active;
      state.entries = Sync.mergeCategories(lists[0], lists[1]);
      // A category on screen that was re-paired (renamed on one side) keeps
      // following the same X template or YouTube category.
      var prefs = previous
        ? { key: previous.key, x: previous.x && previous.x.id, youtube: previous.youtube && previous.youtube.id }
        : Object.assign({ key: readStored() }, urlPreferences());
      var next = Sync.pickEntry(state.entries, prefs);
      state.active = next;
      renderDropdown();
      if (xFailed || ytFailed) {
        els.summary.textContent = (xFailed && ytFailed)
          ? "Categories are unavailable right now."
          : (xFailed ? "X Intelligence" : "YouTube Intelligence") + " categories are unavailable right now; showing the rest.";
      }
      var changed = !previous || !next || previous.key !== next.key;
      if (reloadFeeds || changed) select(next);
      else renderSources(next);
    });
  }

  function init() {
    els = {
      select: byId("ipCategory"),
      refresh: byId("ipRefresh"),
      summary: byId("ipSummary"),
      sources: byId("ipSources"),
      xFeed: byId("ipXFeed"),
      xStatus: byId("ipXStatus"),
      xLink: byId("ipXLink"),
      ytFeed: byId("ipYtFeed"),
      ytStatus: byId("ipYtStatus"),
      ytLink: byId("ipYtLink"),
      player: byId("ipPlayer"),
      playerFrame: byId("ipPlayerFrame"),
      playerLink: byId("ipPlayerLink"),
      playerClose: byId("ipPlayerClose"),
    };
    if (!els.select || !Sync || !XPosts) return;

    els.select.addEventListener("change", function () {
      var key = els.select.value;
      var entry = state.entries.filter(function (item) { return item.key === key; })[0];
      if (entry) select(entry);
    });
    els.refresh.addEventListener("click", function () { loadCategories({ reloadFeeds: true }); });
    els.playerClose.addEventListener("click", closePlayer);

    // Categories edited in another tab arrive when this one comes back into
    // view. Only the list is re-read; the feeds reload only if the category on
    // screen was renamed into a different pairing or deleted.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.entries.length) loadCategories({ reloadFeeds: false });
    });

    loadCategories({ reloadFeeds: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
