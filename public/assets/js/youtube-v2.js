(function () {
  "use strict";

  var YT_ORIGIN = "https://www.youtube.com";

  // enablejsapi lets the page hear when a video ends so the queue can advance.
  function embedUrl(id, start) {
    var origin = window.location.origin && window.location.origin !== "null" ? "&origin=" + encodeURIComponent(window.location.origin) : "";
    return YT_ORIGIN + "/embed/" + encodeURIComponent(id) + "?autoplay=1&enablejsapi=1" + origin + (start ? "&start=" + start : "");
  }

  // Gemini can only summarize a finished video: a live stream is still being
  // recorded and an upcoming one has no content yet.
  function canSummarize(video) {
    return Boolean(video && video.id) && video.state !== "live" && video.state !== "upcoming";
  }
  function watchUrl(id) {
    return "https://youtu.be/" + encodeURIComponent(id);
  }
  function thumbUrl(id) {
    return "https://img.youtube.com/vi/" + encodeURIComponent(id) + "/hqdefault.jpg";
  }

  function formatRelativeDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var diffMs = Date.now() - date.getTime();
    var day = 24 * 60 * 60 * 1000;
    var days = Math.floor(diffMs / day);
    if (days < 1) return "Today";
    if (days === 1) return "1 day ago";
    if (days < 30) return days + " days ago";
    var months = Math.floor(days / 30);
    if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
    var years = Math.floor(months / 12);
    return years + (years === 1 ? " year ago" : " years ago");
  }

  // Scheduled streams read forwards, not backwards: "in 2 hours", not "2 hours ago".
  function formatCountdown(iso) {
    if (!iso) return "Start time TBA";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "Start time TBA";
    var diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return "Starting now";
    var minutes = Math.round(diffMs / 60000);
    if (minutes < 60) return "in " + minutes + (minutes === 1 ? " minute" : " minutes");
    var hours = Math.round(minutes / 60);
    if (hours < 24) return "in " + hours + (hours === 1 ? " hour" : " hours");
    var days = Math.round(hours / 24);
    return "in " + days + (days === 1 ? " day" : " days");
  }

  function formatViewers(count) {
    if (typeof count !== "number" || !isFinite(count)) return "";
    if (count < 1000) return count + " watching";
    return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K watching";
  }

  // The API returns a flat `videos` list; older payloads only had per-channel
  // `channels[].videos`, so keep reading both.
  function normalizeUploads(data) {
    var uploads = data.videos || [];

    if (!uploads.length && data.channels) {
      uploads = [];
      data.channels.forEach(function (channel) {
        (channel.videos || []).forEach(function (video) {
          uploads.push(
            Object.assign({}, video, {
              channelHandle: video.channelHandle || channel.handle,
              channelLabel: video.channelLabel || channel.label,
              channelCategory: video.channelCategory || channel.category,
            })
          );
        });
      });

      uploads.sort(function (a, b) {
        var aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        var bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return bTime - aTime;
      });
    }

    return uploads.map(toItem);
  }

  function toItem(video) {
    return {
      video: video,
      // The handle, not the label, is what a theme's membership is keyed by:
      // labels are display text and two channels may share one.
      channelHandle: normalizeHandle(video.channelHandle),
      channelLabel: video.channelLabel || video.channelHandle || "YouTube",
      channelCategory: video.channelCategory || "",
    };
  }

  function normalizeHandle(value) {
    return String(value == null ? "" : value).trim().replace(/^@+/, "").toLowerCase();
  }

  function videoDetail(video) {
    if (video.state === "live") return formatViewers(video.concurrentViewers) || "Streaming now";
    if (video.state === "upcoming") return formatCountdown(video.scheduledStartTime);
    return formatRelativeDate(video.publishedAt);
  }

  function queueLabel(queued, title) {
    return (queued ? "Remove from queue: " : "Add to queue: ") + title;
  }

  function syncQueueButton(button, queued) {
    button.setAttribute("aria-pressed", queued ? "true" : "false");
    button.setAttribute("aria-label", queueLabel(queued, button.dataset.title || "video"));
    button.title = queued ? "Remove from queue" : "Add to queue";
  }

  function buildCard(item, ctx) {
    var video = item.video;
    var wrap = document.createElement("div");
    wrap.className = "yt-card";
    var card = document.createElement("a");
    card.className = "yt-feed-card";
    card.href = video.url || watchUrl(video.id);
    card.target = "_blank";
    card.rel = "noopener";
    if (video.id) card.dataset.videoId = video.id;
    if (video.id === ctx.activeId) card.setAttribute("aria-current", "true");
    var watched = Boolean(video.id && ctx.watched && ctx.watched.has(video.id));
    if (watched) wrap.classList.add("is-watched");

    var thumb = document.createElement("div");
    thumb.className = "yt-feed-thumb";

    var image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", function () {
      image.remove();
      thumb.classList.add("is-missing");
    }, { once: true });
    image.src = video.thumbnail || thumbUrl(video.id);
    thumb.appendChild(image);

    var play = document.createElement("span");
    play.className = "yt-thumb-play";
    play.setAttribute("aria-hidden", "true");
    thumb.appendChild(play);

    if (video.state === "live" || video.state === "upcoming") {
      var badge = document.createElement("span");
      badge.className = "yt-badge yt-badge-" + video.state;
      badge.textContent = video.state === "live" ? "LIVE" : "UPCOMING";
      thumb.appendChild(badge);
    }

    if (watched) thumb.appendChild(watchedBadge());

    var body = document.createElement("div");
    body.className = "yt-feed-body";

    var monogram = document.createElement("span");
    monogram.className = "yt-channel-monogram";
    monogram.setAttribute("aria-hidden", "true");
    monogram.textContent = Array.from(item.channelLabel.trim().replace(/^@+/, ""))[0]?.toUpperCase() || "Y";
    body.appendChild(monogram);

    var copy = document.createElement("div");
    var title = document.createElement("div");
    title.className = "yt-feed-title";
    title.textContent = video.title;
    title.title = video.title;
    copy.appendChild(title);

    var meta = document.createElement("div");
    meta.className = "yt-feed-meta";

    var channel = document.createElement("span");
    channel.textContent = item.channelLabel;
    meta.appendChild(channel);

    var detail = videoDetail(video);
    if (detail) {
      var detailNode = document.createElement("span");
      detailNode.textContent = detail;
      meta.appendChild(detailNode);
    }

    copy.appendChild(meta);
    body.appendChild(copy);
    card.appendChild(thumb);
    card.appendChild(body);

    // Opening the video on youtube.com in a new tab (modifier or middle click)
    // counts as watching it too.
    card.addEventListener("auxclick", function (e) {
      if (e.button === 1 && video.id && ctx.onWatched) ctx.onWatched(video.id);
    });
    card.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || !video.id) {
        if (e.button === 0 && video.id && ctx.onWatched) ctx.onWatched(video.id);
        return;
      }
      e.preventDefault();
      ctx.onSelect(item, card);
    });

    wrap.appendChild(card);

    // A sibling of the link, not a child: a button inside <a> is invalid and
    // would also trigger playback.
    if (video.id && ctx.queue) {
      var queueButton = document.createElement("button");
      queueButton.type = "button";
      queueButton.className = "yt-queue-toggle";
      queueButton.dataset.queueId = video.id;
      queueButton.dataset.title = video.title || "video";
      var icon = document.createElement("span");
      icon.className = "yt-queue-icon";
      icon.setAttribute("aria-hidden", "true");
      queueButton.appendChild(icon);
      syncQueueButton(queueButton, ctx.queue.has(video.id));
      queueButton.addEventListener("click", function () { ctx.onToggleQueue(item); });
      wrap.appendChild(queueButton);
    }

    // Gemini summary pill, top-left of the thumbnail (the queue toggle is top-right).
    if (ctx.onSummarize && canSummarize(video)) {
      var summary = document.createElement("button");
      summary.type = "button";
      summary.className = "yt-summary-chip";
      summary.textContent = "Summary";
      summary.setAttribute("aria-label", "Summarize " + (video.title || "video") + " with Gemini");
      summary.addEventListener("click", function () { ctx.onSummarize(item); });
      wrap.appendChild(summary);
    }

    return wrap;
  }

  function watchedBadge() {
    var node = document.createElement("span");
    node.className = "yt-watched-badge";
    node.textContent = "Watched";
    return node;
  }

  // Videos this browser has played, newest last. Kept in localStorage per
  // viewer; capped so the list cannot grow without bound.
  var WATCHED_KEY = "yt:watched";
  var WATCHED_LIMIT = 1000;

  function createWatchedStore(storage) {
    var ids = [];
    function load() {
      try {
        var parsed = JSON.parse(storage?.getItem(WATCHED_KEY) || "[]");
        ids = Array.isArray(parsed) ? parsed.filter(function (id) { return typeof id === "string" && id; }) : [];
      } catch (e) {
        ids = [];
      }
    }
    load();
    return {
      key: WATCHED_KEY,
      has: function (id) { return ids.indexOf(id) !== -1; },
      add: function (id) {
        if (!id) return false;
        var fresh = ids.indexOf(id) === -1;
        ids = ids.filter(function (other) { return other !== id; }).concat(id).slice(-WATCHED_LIMIT);
        try { storage?.setItem(WATCHED_KEY, JSON.stringify(ids)); } catch (e) { /* best effort */ }
        return fresh;
      },
      reload: load,
    };
  }

  function setMessage(root, message) {
    var empty = document.createElement("div");
    empty.className = "yt-empty";
    empty.setAttribute("role", "status");
    empty.textContent = message;
    root.replaceChildren(empty);
  }

  function renderGrid(root, items, emptyText, ctx, searchTerms) {
    var matches = items.filter(function (item) {
      var text = [item.video.title, item.channelLabel, item.channelHandle].join(" ").toLowerCase();
      return searchTerms.every(function (term) { return text.includes(term); });
    });
    if (!matches.length) {
      setMessage(root, items.length ? "No matches for your search." : emptyText);
      return 0;
    }

    var grid = document.createElement("div");
    grid.className = "yt-channel-videos";
    matches.forEach(function (item) {
      grid.appendChild(buildCard(item, ctx));
    });
    root.replaceChildren(grid);
    return matches.length;
  }

  // Failure reasons from the API. The server logs the full cause; the page
  // only ever renders these fixed strings, so nothing sensitive can leak here.
  var REASON_HINTS = {
    "missing-api-key": "YouTube Data API key not configured on the server",
    "quota-exceeded": "YouTube API daily quota exhausted",
    "api-rejected": "YouTube API rejected the request",
    "rss-failed": "YouTube feed did not respond",
    "channel-id-unresolved": "channel ID could not be resolved",
  };

  function renderFailures(root, failed) {
    if (!root || !failed.length) return;

    var err = document.createElement("div");
    err.className = "yt-channel-error";

    var byReason = {};
    failed.forEach(function (channel) {
      var reason = channel.reason || "rss-failed";
      if (!byReason[reason]) byReason[reason] = [];
      byReason[reason].push(channel.label);
    });

    err.textContent = Object.keys(byReason)
      .map(function (reason) {
        return (
          byReason[reason].join(", ") +
          " unavailable — " +
          (REASON_HINTS[reason] || "feed request failed")
        );
      })
      .join(" · ");

    root.appendChild(err);
  }

  function emptyLiveText(meta, kind) {
    if (meta && meta.liveDetection === "unavailable") {
      return "Live detection needs a YouTube Data API key on the server.";
    }
    if (meta && meta.liveDetection === "degraded") {
      return "Live status is temporarily unavailable — showing uploads only.";
    }
    return kind === "live" ? "No channels are live right now." : "No streams scheduled right now.";
  }

  var CATEGORY_KEY = "yt:category";

  function readStoredCategory() {
    try {
      return window.localStorage.getItem(CATEGORY_KEY) || "";
    } catch (e) {
      // Private mode and blocked site data both throw here. A remembered category
      // is a convenience; losing it must not stop the page rendering.
      return "";
    }
  }

  function storeCategory(id) {
    try {
      window.localStorage.setItem(CATEGORY_KEY, id);
    } catch (e) {
      /* best effort */
    }
  }

  function render(roots, data, ctx, query) {
    var meta = data.meta || {};
    var failed = data.failedFeeds || [];
    var items = normalizeUploads(data);

    function wrap(list) {
      return list.map(toItem);
    }

    var live = data.live
      ? wrap(data.live)
      : items.filter(function (item) {
          return item.video.state === "live";
        });
    var upcoming = data.upcoming
      ? wrap(data.upcoming)
      : items.filter(function (item) {
          return item.video.state === "upcoming";
        });

    // Streams already have their own sections above; the uploads feed shows
    // everything else so nothing is listed twice.
    var uploads = items.filter(function (item) {
      return item.video.state !== "live" && item.video.state !== "upcoming";
    });

    var searchTerms = query.toLowerCase().split(/\s+/).map(function (term) {
      return term.replace(/^@+/, "");
    }).filter(Boolean);
    var count = renderGrid(roots.live, live, emptyLiveText(meta, "live"), ctx, searchTerms);
    count += renderGrid(roots.upcoming, upcoming, emptyLiveText(meta, "upcoming"), ctx, searchTerms);
    count += renderGrid(roots.uploads, uploads, "No videos found yet.", ctx, searchTerms);
    renderFailures(roots.uploads, failed);
    return count;
  }

  function setupCategoryFilter(select, categories, activeId, onChange) {
    var all = {
      id: "all",
      name: "All Categories",
      channelCount: categories.reduce(function (sum, category) {
        return sum + Number(category.channelCount || 0);
      }, 0),
    };
    select.replaceChildren();
    [all].concat(categories).forEach(function (category) {
      var option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name + " (" + Number(category.channelCount || 0) + ")";
      select.appendChild(option);
    });
    select.value = activeId;
    select.onchange = function () { onChange(select.value); };
  }

  // A category deleted in another tab leaves this page holding an ID the server
  // no longer knows, which it answers with a 400. That is recoverable: fall
  // back to All Categories rather than blanking the page.
  function safeStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function staleCategoryError(status, categoryId) {
    return status === 400 && categoryId && categoryId !== "all";
  }

  function init() {
    var player = document.getElementById("ytPlayer");
    if (!player) return;

    var watch = document.getElementById("ytWatch");
    var watchTitle = document.getElementById("ytWatchTitle");
    var watchChannel = document.getElementById("ytWatchChannel");
    var watchDetail = document.getElementById("ytWatchDetail");
    var playerLink = document.getElementById("ytPlayerLink");
    var copyLinkButton = document.getElementById("ytCopyLink");
    var copyLinkLabel = copyLinkButton ? copyLinkButton.innerHTML : "";
    var copyLinkTimer = null;
    var search = document.getElementById("ytSearch");
    var select = document.getElementById("ytCategoryFilter");
    var refresh = document.getElementById("ytRefresh");
    var status = document.getElementById("ytFeedStatus");
    var loginLink = document.getElementById("ytLoginLink");
    var roots = {
      live: document.getElementById("ytLiveFeeds"),
      upcoming: document.getElementById("ytUpcomingFeeds"),
      uploads: document.getElementById("ytChannelFeeds"),
    };
    var stage = document.getElementById("ytStage");
    var queueSection = document.getElementById("ytQueue");
    var queueList = document.getElementById("ytQueueList");
    var queueCount = document.getElementById("ytQueueCount");
    var queuePlay = document.getElementById("ytQueuePlay");
    var queueClear = document.getElementById("ytQueueClear");
    var queueAutoplay = document.getElementById("ytQueueAutoplay");
    var queueCollapse = document.getElementById("ytQueueCollapse");
    var menuToggle = document.getElementById("ytMenuToggle");
    var queueAnnounce = document.getElementById("ytQueueAnnounce");
    var playNextButton = document.getElementById("ytPlayNext");
    var summarizeButton = document.getElementById("ytSummarize");
    var summarizeItem = null;
    var playingItem = null;
    var queue = window.YoutubeQueue && queueSection
      ? window.YoutubeQueue.createQueue({ storage: safeStorage() })
      : null;
    var watchedStore = createWatchedStore(safeStorage());
    var payload;
    var request;
    var playingId = null;
    var feedNote = "";
    var pendingFocus = null;
    var dragId = null;
    var listenTimer = null;
    var heardPlayer = false;
    var endedFor = null;

    function renderFeed() {
      if (!payload) return;
      var ctx = { onSelect: onSelect, activeId: playingId, queue: queue, onToggleQueue: toggleQueue, onSummarize: summarizeItem, watched: watchedStore, onWatched: markWatched };
      var count = render(roots, payload, ctx, search.value);
      status.textContent = (search.value.trim() ? count + (count === 1 ? " matching video. " : " matching videos. ") : "") + feedNote;
    }

    function setFeedMessage(message) {
      payload = null;
      Object.values(roots).forEach(function (root) { setMessage(root, message); });
    }

    function beginRequest() {
      if (request) request.abort();
      request = new AbortController();
      refresh.disabled = true;
      refresh.textContent = "Refreshing…";
      status.textContent = "Loading YouTube videos…";
      loginLink.hidden = true;
      Object.values(roots).forEach(function (root) { root.setAttribute("aria-busy", "true"); });
      setFeedMessage("Loading YouTube videos…");
      return request.signal;
    }

    function finishRequest(signal) {
      if (signal.aborted) return;
      refresh.disabled = false;
      refresh.textContent = "Refresh feeds";
      Object.values(roots).forEach(function (root) { root.removeAttribute("aria-busy"); });
    }

    function showError(error) {
      var expired = error.status === 401;
      var message = expired ? "Your session expired. Log in again to load feeds." : "Channel feeds are unavailable right now. Use Refresh feeds to try again.";
      setFeedMessage(message);
      status.textContent = message;
      loginLink.hidden = !expired;
    }

    async function fetchJson(url, signal) {
      var res = await fetch(url, { signal: signal, headers: { Accept: "application/json" } });
      if (!res.ok) {
        var error = new Error("Request failed: " + res.status);
        error.status = res.status;
        throw error;
      }
      return res.json();
    }

    function describeFeed(data) {
      var checked = new Date(data.meta?.generatedAt);
      var note = isNaN(checked.getTime()) ? "Feed loaded." : "Feed checked at " + checked.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ".";
      var stale = data.channels.filter(function (channel) { return channel.stale; }).length;
      var failed = (data.failedFeeds || []).length;
      if (stale) note += " " + stale + (stale === 1 ? " channel is" : " channels are") + " showing cached uploads; recent videos may be missing.";
      if (failed) note += " " + failed + (failed === 1 ? " channel could" : " channels could") + " not be loaded.";
      return note;
    }

    function selectedCard() {
      return document.querySelector('.yt-feed-card[aria-current="true"]');
    }

    function cardsFor(id) {
      return Array.from(document.querySelectorAll(".yt-feed-card")).filter(function (card) {
        return card.dataset.videoId === id;
      });
    }

    function play(item) {
      var video = item.video;
      // The video now playing leaves "Up next", as it does on YouTube.
      if (queue) queue.remove(video.id);
      document.querySelectorAll('.yt-feed-card[aria-current="true"]').forEach(function (node) {
        node.removeAttribute("aria-current");
      });
      cardsFor(video.id).forEach(function (node) { node.setAttribute("aria-current", "true"); });
      markWatched(video.id);
      watchTitle.textContent = video.title;
      watchChannel.textContent = item.channelLabel;
      watchDetail.textContent = videoDetail(video);
      player.title = "YouTube video: " + video.title;
      playerLink.href = video.url || watchUrl(video.id);
      resetCopyLink();
      watch.hidden = false;
      document.body.classList.add("yt-focus");
      if (playingId !== video.id) {
        endedFor = null;
        player.src = embedUrl(video.id);
      }
      playingId = video.id;
      playingItem = item;
      syncMenu();
      if (summarizeButton) summarizeButton.hidden = !summarizeItem || !canSummarize(video);
      renderQueue();
      watch.scrollIntoView({ block: "start" });
      watchTitle.focus({ preventScroll: true });
    }

    function onSelect(item) {
      play(item);
    }

    // Mark the cards in place rather than re-rendering, which would reset
    // scroll and focus in the grid.
    function markWatched(id) {
      if (!watchedStore.add(id)) return;
      cardsFor(id).forEach(function (card) {
        var wrap = card.parentElement;
        if (!wrap || wrap.classList.contains("is-watched")) return;
        wrap.classList.add("is-watched");
        card.querySelector(".yt-feed-thumb")?.appendChild(watchedBadge());
      });
    }

    function closeWatch(restoreFocus) {
      if (!playingId) return;
      var card = selectedCard();
      card?.removeAttribute("aria-current");
      stopListening();
      player.removeAttribute("src");
      watch.hidden = true;
      document.body.classList.remove("yt-focus");
      playingId = null;
      playingItem = null;
      syncMenu();
      renderQueue();
      if (restoreFocus) (card || search).focus();
    }

    /* ---- Movie mode menu ----
       While a video plays the sidebar tucks away so the player gets the
       screen; "Show menu" brings it back and the choice is remembered. */

    var MENU_KEY = "yt:movie:menu";
    var menuShown = false;
    try { menuShown = window.localStorage.getItem(MENU_KEY) === "shown"; } catch (err) { /* default hidden */ }

    function syncMenu() {
      var tucked = !!playingId && !menuShown;
      document.body.classList.toggle("yt-menu-tucked", tucked);
      if (!menuToggle) return;
      menuToggle.textContent = menuShown ? "Hide menu" : "Show menu";
      menuToggle.setAttribute("aria-pressed", menuShown ? "true" : "false");
    }

    menuToggle?.addEventListener("click", function () {
      menuShown = !menuShown;
      try { window.localStorage.setItem(MENU_KEY, menuShown ? "shown" : "hidden"); } catch (err) { /* best effort */ }
      syncMenu();
    });

    /* ---- Copy link ---- */

    function resetCopyLink() {
      if (!copyLinkButton) return;
      window.clearTimeout(copyLinkTimer);
      copyLinkButton.innerHTML = copyLinkLabel;
    }

    function flashCopyLink(label) {
      copyLinkButton.textContent = label;
      window.clearTimeout(copyLinkTimer);
      copyLinkTimer = window.setTimeout(resetCopyLink, 2000);
    }

    function copyTextFallback(text) {
      var field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      field.remove();
      return ok;
    }

    function copyVideoLink() {
      var url = playerLink.href;
      if (!url) return;
      var done = function () { flashCopyLink("Link copied \u2713"); announce("Video link copied."); };
      var fail = function () {
        if (copyTextFallback(url)) return done();
        flashCopyLink("Copy failed");
        announce("Could not copy the video link.");
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, fail);
      } else {
        fail();
      }
    }

    /* ---- Up next queue ---- */

    function announce(message) {
      if (!queueAnnounce) return;
      queueAnnounce.textContent = "";
      // A fresh text node makes repeated messages ("Added to queue") re-announce.
      window.setTimeout(function () { queueAnnounce.textContent = message; }, 30);
    }

    function toQueueEntry(item) {
      var video = item.video;
      return {
        id: video.id,
        title: video.title,
        channelLabel: item.channelLabel,
        channelHandle: item.channelHandle,
        channelCategory: item.channelCategory,
        thumbnail: video.thumbnail || thumbUrl(video.id),
        url: video.url || watchUrl(video.id),
        state: video.state,
        publishedAt: video.publishedAt,
        scheduledStartTime: video.scheduledStartTime,
      };
    }

    // Prefer the feed's current copy (fresh live/viewer state); fall back to
    // what the queue stored, e.g. a video queued under another category.
    function itemForEntry(entry) {
      if (payload) {
        var lists = [payload.live || [], payload.upcoming || [], payload.videos || []];
        (payload.channels || []).forEach(function (channel) { lists.push(channel.videos || []); });
        for (var i = 0; i < lists.length; i++) {
          var match = lists[i].filter(function (video) { return video && video.id === entry.id; })[0];
          if (match) return toItem(Object.assign({ channelLabel: entry.channelLabel, channelHandle: entry.channelHandle }, match));
        }
      }
      return toItem(entry);
    }

    function toggleQueue(item) {
      if (!queue) return;
      var video = item.video;
      if (queue.has(video.id)) {
        queue.remove(video.id);
        announce("Removed from queue: " + video.title);
      } else if (video.id === playingId) {
        announce("Already playing: " + video.title);
      } else if (queue.add(toQueueEntry(item))) {
        announce("Added to queue: " + video.title + ". " + queue.size() + " in queue.");
      } else {
        announce("The queue is full. Remove a video to add another.");
      }
    }

    function playNext() {
      var entry = queue && queue.shift();
      if (!entry) return false;
      play(itemForEntry(entry));
      return true;
    }

    function autoplayOn() {
      return !queueAutoplay || queueAutoplay.checked;
    }

    function queueRow(entry, index, total) {
      var li = document.createElement("li");
      li.className = "yt-queue-item";
      li.dataset.rowId = entry.id;
      li.draggable = true;

      var pos = document.createElement("span");
      pos.className = "yt-queue-pos";
      pos.setAttribute("aria-hidden", "true");
      pos.textContent = String(index + 1);
      li.appendChild(pos);

      var main = document.createElement("button");
      main.type = "button";
      main.className = "yt-queue-main";
      main.dataset.action = "play";
      main.setAttribute("aria-label", "Play now: " + entry.title + (entry.channelLabel ? " — " + entry.channelLabel : ""));

      var thumb = document.createElement("span");
      thumb.className = "yt-queue-thumb";
      var image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", function () { image.remove(); }, { once: true });
      image.src = entry.thumbnail || thumbUrl(entry.id);
      thumb.appendChild(image);
      if (entry.state === "live" || entry.state === "upcoming") {
        var badge = document.createElement("span");
        badge.className = "yt-badge yt-badge-" + entry.state;
        badge.textContent = entry.state === "live" ? "LIVE" : "UPCOMING";
        thumb.appendChild(badge);
      }
      main.appendChild(thumb);

      var copy = document.createElement("span");
      copy.className = "yt-queue-copy";
      var title = document.createElement("span");
      title.className = "yt-queue-title";
      title.textContent = entry.title;
      title.title = entry.title;
      copy.appendChild(title);
      var meta = document.createElement("span");
      meta.className = "yt-queue-meta";
      meta.textContent = entry.channelLabel || "YouTube";
      copy.appendChild(meta);
      main.appendChild(copy);
      li.appendChild(main);

      var actions = document.createElement("span");
      actions.className = "yt-queue-row-actions";
      [
        ["up", "Move up", "\u2191", index === 0],
        ["down", "Move down", "\u2193", index === total - 1],
        ["remove", "Remove", "\u2715", false],
      ].forEach(function (spec) {
        var button = document.createElement("button");
        button.type = "button";
        button.dataset.action = spec[0];
        button.setAttribute("aria-label", spec[1] + ": " + entry.title);
        button.title = spec[1];
        button.textContent = spec[2];
        button.disabled = spec[3];
        actions.appendChild(button);
      });
      li.appendChild(actions);
      return li;
    }

    function restoreQueueFocus() {
      if (!pendingFocus) return;
      var want = pendingFocus;
      pendingFocus = null;
      var rows = Array.from(queueList.children);
      var row = rows.filter(function (node) { return node.dataset.rowId === want.id; })[0];
      if (!row) row = rows[Math.min(want.index, rows.length - 1)];
      if (!row) { (playingId ? watchTitle : search).focus({ preventScroll: true }); return; }
      var action = row.dataset.rowId === want.id ? want.action : "remove";
      var target = row.querySelector('[data-action="' + action + '"]');
      if (!target || target.disabled) target = row.querySelector('[data-action="up"]:not(:disabled), [data-action="down"]:not(:disabled)') || row.querySelector('[data-action="play"]');
      target.focus({ preventScroll: true });
    }

    function renderQueue() {
      if (!queue) return;
      var entries = queue.list();
      var n = entries.length;
      queueSection.hidden = !n;
      stage.classList.toggle("has-queue", n > 0);
      stage.classList.toggle("is-playing", !!playingId);
      queueCount.textContent = n + (n === 1 ? " video" : " videos") +
        (n && queueSection.classList.contains("is-collapsed") ? " · Next: " + entries[0].title : "");
      queuePlay.hidden = !n || !!playingId;
      playNextButton.hidden = !n;
      if (n) {
        playNextButton.title = "Play next: " + entries[0].title;
        playNextButton.setAttribute("aria-label", "Play next: " + entries[0].title);
      }
      queueList.replaceChildren.apply(queueList, entries.map(function (entry, index) { return queueRow(entry, index, n); }));
      document.querySelectorAll(".yt-queue-toggle").forEach(function (button) {
        syncQueueButton(button, queue.has(button.dataset.queueId));
      });
      restoreQueueFocus();
    }

    function setupQueue() {
      if (!queue) return;
      queue.subscribe(renderQueue);

      queueList.addEventListener("click", function (event) {
        var button = event.target.closest("button[data-action]");
        var row = button && button.closest(".yt-queue-item");
        if (!row) return;
        var id = row.dataset.rowId;
        var index = Array.from(queueList.children).indexOf(row);
        var action = button.dataset.action;
        if (action === "play") {
          var entry = queue.list().filter(function (item) { return item.id === id; })[0];
          if (entry) play(itemForEntry(entry));
          return;
        }
        pendingFocus = { id: id, index: index, action: action };
        if (action === "up") queue.move(id, index - 1);
        else if (action === "down") queue.move(id, index + 1);
        else if (action === "remove") {
          queue.remove(id);
          announce("Removed from queue.");
        }
        // A no-op move leaves no render to consume the focus request.
        pendingFocus = null;
      });

      // Drag a row to reorder, as on YouTube. The arrow buttons cover keyboard use.
      function clearDropMarks() {
        queueList.querySelectorAll(".is-drop-before, .is-drop-after").forEach(function (node) {
          node.classList.remove("is-drop-before", "is-drop-after");
        });
      }
      function dropAfter(row, event) {
        var box = row.getBoundingClientRect();
        return event.clientY > box.top + box.height / 2;
      }
      queueList.addEventListener("dragstart", function (event) {
        var row = event.target.closest && event.target.closest(".yt-queue-item");
        if (!row) return;
        dragId = row.dataset.rowId;
        row.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        try { event.dataTransfer.setData("text/plain", dragId); } catch (err) { /* older engines */ }
      });
      queueList.addEventListener("dragover", function (event) {
        var row = event.target.closest && event.target.closest(".yt-queue-item");
        if (!dragId || !row) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        clearDropMarks();
        if (row.dataset.rowId !== dragId) row.classList.add(dropAfter(row, event) ? "is-drop-after" : "is-drop-before");
      });
      queueList.addEventListener("drop", function (event) {
        var row = event.target.closest && event.target.closest(".yt-queue-item");
        if (!dragId || !row) return;
        event.preventDefault();
        var rows = Array.from(queueList.children);
        var from = rows.findIndex(function (node) { return node.dataset.rowId === dragId; });
        var to = rows.indexOf(row) + (dropAfter(row, event) ? 1 : 0);
        if (from !== -1 && from < to) to -= 1;
        var id = dragId;
        dragId = null;
        queue.move(id, to);
      });
      queueList.addEventListener("dragend", function () {
        dragId = null;
        clearDropMarks();
        queueList.querySelectorAll(".is-dragging").forEach(function (node) { node.classList.remove("is-dragging"); });
      });

      queuePlay.addEventListener("click", playNext);
      playNextButton.addEventListener("click", playNext);
      queueClear.addEventListener("click", function () {
        queue.clear();
        announce("Queue cleared.");
        (playingId ? watchTitle : search).focus({ preventScroll: true });
      });

      var COLLAPSED_KEY = "yt:queue:collapsed";
      function setCollapsed(collapsed) {
        queueSection.classList.toggle("is-collapsed", collapsed);
        queueList.hidden = collapsed;
        queueCollapse.setAttribute("aria-expanded", collapsed ? "false" : "true");
        queueCollapse.title = collapsed ? "Expand queue" : "Collapse queue";
      }
      if (queueCollapse) {
        try { setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "on"); } catch (err) { /* default open */ }
        queueCollapse.addEventListener("click", function () {
          var collapsed = !queueSection.classList.contains("is-collapsed");
          setCollapsed(collapsed);
          try { window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "on" : "off"); } catch (err) { /* best effort */ }
          renderQueue();
        });
      }

      var AUTOPLAY_KEY = "yt:queue:autoplay";
      try { queueAutoplay.checked = window.localStorage.getItem(AUTOPLAY_KEY) !== "off"; } catch (err) { /* default on */ }
      queueAutoplay.addEventListener("change", function () {
        try { window.localStorage.setItem(AUTOPLAY_KEY, queueAutoplay.checked ? "on" : "off"); } catch (err) { /* best effort */ }
      });

      // Another tab edited the queue.
      window.addEventListener("storage", function (event) {
        if (event.key === queue.key || event.key === null) queue.reload();
      });

      renderQueue();
    }

    /* ---- Player end detection (YouTube iframe postMessage protocol) ---- */

    function postToPlayer(message) {
      try {
        player.contentWindow?.postMessage(JSON.stringify(Object.assign({ id: "ytPlayer", channel: "widget" }, message)), YT_ORIGIN);
      } catch (err) { /* player not ready */ }
    }

    function stopListening() {
      window.clearInterval(listenTimer);
      listenTimer = null;
    }

    function startListening() {
      stopListening();
      heardPlayer = false;
      var tries = 0;
      function ping() {
        if (heardPlayer || ++tries > 30) { stopListening(); return; }
        postToPlayer({ event: "listening" });
      }
      ping();
      listenTimer = window.setInterval(ping, 400);
    }

    player.addEventListener("load", function () {
      if (player.getAttribute("src")) startListening();
    });

    window.addEventListener("message", function (event) {
      if (event.origin !== YT_ORIGIN || event.source !== player.contentWindow) return;
      var data;
      try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch (err) { return; }
      if (!data || typeof data !== "object") return;
      if (!heardPlayer) {
        heardPlayer = true;
        stopListening();
        postToPlayer({ event: "command", func: "addEventListener", args: ["onStateChange"] });
      }
      var state;
      if (data.event === "onStateChange") state = data.info;
      else if (data.event === "infoDelivery" && data.info && typeof data.info === "object") state = data.info.playerState;
      if (state === 1) endedFor = null;
      if (state !== 0 || !playingId || endedFor === playingId) return;
      endedFor = playingId;
      if (autoplayOn() && queue && queue.size()) playNext();
    });

    async function loadCategory(categoryId, fallbackToAll) {
      var signal = beginRequest();
      try {
        var data = await fetchJson("/api/youtube/channels?categoryId=" + encodeURIComponent(categoryId), signal);
        if (signal.aborted) return;
        if (!data || !data.channels || !data.channels.length) {
          var name = data?.selectedCategory?.name;
          var message = categoryId === "all"
            ? "Add your first YouTube channel to start building intelligence feeds."
            : "No channels in " + (name || "this category") + " yet — add a channel.";
          setFeedMessage(message);
          status.textContent = message;
          return;
        }
        payload = data;
        feedNote = describeFeed(data);
        renderFeed();
      } catch (error) {
        if (signal.aborted) return;
        if (staleCategoryError(error.status, categoryId)) fallbackToAll(categoryId);
        else showError(error);
      } finally {
        finishRequest(signal);
      }
    }

    async function loadFeeds() {
      select.disabled = true;
      var signal = beginRequest();
      try {
        var config = await fetchJson("/api/youtube/channels/config", signal);
        if (signal.aborted) return;
        var categories = config.categories || [];

        function hasCategory(id) {
          return id === "all" || categories.some(function (category) { return category.id === id; });
        }
        function fallbackToAll(staleId) {
          categories = categories.filter(function (category) { return category.id !== staleId; });
          setupCategoryFilter(select, categories, "all", choose);
          choose("all");
        }
        function choose(id) {
          storeCategory(id);
          closeWatch(false);
          loadCategory(id, fallbackToAll);
        }

        // The Intelligence Portal's link wins over the remembered category on entry.
        var linked = new URL(window.location.href).searchParams.get("category");
        var stored = readStoredCategory();
        var activeId = hasCategory(linked) && !select.onchange ? linked : stored;
        if (!hasCategory(activeId)) activeId = "all";
        storeCategory(activeId);
        setupCategoryFilter(select, categories, activeId, choose);
        select.disabled = false;
        loadCategory(activeId, fallbackToAll);
      } catch (error) {
        if (!signal.aborted) {
          select.disabled = !select.onchange;
          showError(error);
          finishRequest(signal);
        }
      }
    }

    // A [mm:ss] link in a summary plays the video from that point in the
    // page's own player instead of leaving for youtube.com.
    function seekTo(item, seconds) {
      if (playingId !== item.video.id) play(item);
      endedFor = null;
      player.src = embedUrl(item.video.id, seconds);
      window.YoutubeSummary.close();
      watch.scrollIntoView({ block: "start" });
      return true;
    }

    if (window.YoutubeSummary) {
      summarizeItem = function (item) {
        window.YoutubeSummary.open({
          video: item.video,
          channelLabel: item.channelLabel,
          onTimestamp: function (seconds) { return seekTo(item, seconds); },
        });
      };
      summarizeButton?.addEventListener("click", function () {
        if (playingItem) summarizeItem(playingItem);
      });
    }
    if (summarizeButton) summarizeButton.hidden = true;

    search.addEventListener("input", renderFeed);
    refresh.addEventListener("click", loadFeeds);
    document.getElementById("ytCloseWatch").addEventListener("click", function () { closeWatch(true); });
    copyLinkButton?.addEventListener("click", copyVideoLink);
    document.addEventListener("keydown", function (event) {
      // Shift+N plays the next queued video, as on YouTube.
      if (event.key === "N" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.defaultPrevented) {
        var target = event.target;
        var typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
        if (!typing && playingId && queue && queue.size()) {
          event.preventDefault();
          playNext();
        }
        return;
      }
      // Escape leaves focus mode unless a dialog (e.g. Manage channels) owns the key.
      if (event.key !== "Escape" || event.defaultPrevented || !playingId) return;
      if (document.querySelector('.manage-overlay, [role="dialog"][aria-modal="true"]')) return;
      closeWatch(true);
    });
    // Another tab watched something.
    window.addEventListener("storage", function (event) {
      if (event.key !== watchedStore.key && event.key !== null) return;
      watchedStore.reload();
      renderFeed();
    });
    setupQueue();
    loadFeeds();

    var manage = document.getElementById("ytManageChannels");
    if (manage && window.YoutubeChannelsAdmin) {
      manage.addEventListener("click", function () {
        window.YoutubeChannelsAdmin.open({
          // Open on the category this page is showing, so a channel added from
          // here lands in it without picking it again.
          categoryId: select.value,
          // Channel management changes the category counts and the feed.
          onChange: loadFeeds,
        });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
