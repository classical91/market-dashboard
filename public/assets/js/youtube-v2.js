(function () {
  "use strict";

  function embedUrl(id, start) {
    return "https://www.youtube.com/embed/" + encodeURIComponent(id) + "?autoplay=1" + (start ? "&start=" + start : "");
  }

  // Gemini can only summarize a finished video: a live stream is still being
  // recorded and an upcoming one has no content yet.
  function canSummarize(video) {
    return Boolean(video && video.id) && video.state !== "live" && video.state !== "upcoming";
  }

  // Set by init(): opens the Gemini summary popup for a feed item.
  var summarizeItem = null;
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

  function buildCard(item, onSelect, activeId) {
    var video = item.video;
    var card = document.createElement("a");
    card.className = "yt-feed-card";
    card.href = video.url || watchUrl(video.id);
    card.target = "_blank";
    card.rel = "noopener";
    if (video.id === activeId) card.setAttribute("aria-current", "true");

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

    card.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || !video.id) return;
      e.preventDefault();
      onSelect(item, card);
    });
    card.dataset.videoId = video.id || "";

    // The summary button sits beside the link, not inside it: a button nested
    // in an <a> is invalid and would also trigger playback.
    var wrap = document.createElement("div");
    wrap.className = "yt-feed-item";
    wrap.appendChild(card);
    if (summarizeItem && canSummarize(video)) {
      var summary = document.createElement("button");
      summary.type = "button";
      summary.className = "yt-summary-chip";
      summary.textContent = "Summary";
      summary.setAttribute("aria-label", "Summarize " + (video.title || "video") + " with Gemini");
      summary.addEventListener("click", function () { summarizeItem(item); });
      wrap.appendChild(summary);
    }
    return wrap;
  }

  function setMessage(root, message) {
    var empty = document.createElement("div");
    empty.className = "yt-empty";
    empty.setAttribute("role", "status");
    empty.textContent = message;
    root.replaceChildren(empty);
  }

  function renderGrid(root, items, emptyText, onSelect, activeId, searchTerms) {
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
      grid.appendChild(buildCard(item, onSelect, activeId));
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

  function render(roots, data, onSelect, activeId, query) {
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
    var count = renderGrid(roots.live, live, emptyLiveText(meta, "live"), onSelect, activeId, searchTerms);
    count += renderGrid(roots.upcoming, upcoming, emptyLiveText(meta, "upcoming"), onSelect, activeId, searchTerms);
    count += renderGrid(roots.uploads, uploads, "No videos found yet.", onSelect, activeId, searchTerms);
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
    var summarizeButton = document.getElementById("ytSummarize");
    var payload;
    var request;
    var playingId = null;
    var playingItem = null;
    var feedNote = "";

    function renderFeed() {
      if (!payload) return;
      var count = render(roots, payload, onSelect, playingId, search.value);
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

    function onSelect(item, card) {
      selectedCard()?.removeAttribute("aria-current");
      card.setAttribute("aria-current", "true");
      var video = item.video;
      watchTitle.textContent = video.title;
      watchChannel.textContent = item.channelLabel;
      watchDetail.textContent = videoDetail(video);
      player.title = "YouTube video: " + video.title;
      playerLink.href = card.href;
      watch.hidden = false;
      document.body.classList.add("yt-focus");
      if (playingId !== video.id) player.src = embedUrl(video.id);
      playingId = video.id;
      playingItem = item;
      if (summarizeButton) summarizeButton.hidden = !canSummarize(video) || !window.YoutubeSummary;
      watch.scrollIntoView({ block: "start" });
      watchTitle.focus({ preventScroll: true });
    }

    function closeWatch(restoreFocus) {
      if (!playingId) return;
      var card = selectedCard();
      card?.removeAttribute("aria-current");
      player.removeAttribute("src");
      watch.hidden = true;
      document.body.classList.remove("yt-focus");
      playingId = null;
      playingItem = null;
      if (restoreFocus) (card || search).focus();
    }

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

    // A [mm:ss] link in the summary plays the video from that point in the
    // page's own player instead of leaving for youtube.com.
    function seekTo(item, seconds) {
      var id = item.video.id;
      if (playingId !== id) {
        var card = document.querySelector('.yt-feed-card[data-video-id="' + CSS.escape(id) + '"]');
        if (!card) return false;
        onSelect(item, card);
      }
      player.src = embedUrl(id, seconds);
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
    } else if (summarizeButton) {
      summarizeButton.hidden = true;
    }

    search.addEventListener("input", renderFeed);
    refresh.addEventListener("click", loadFeeds);
    document.getElementById("ytCloseWatch").addEventListener("click", function () { closeWatch(true); });
    document.addEventListener("keydown", function (event) {
      // Escape leaves focus mode unless a dialog (e.g. Manage channels) owns the key.
      if (event.key !== "Escape" || event.defaultPrevented || !playingId) return;
      if (document.querySelector('.manage-overlay, [role="dialog"][aria-modal="true"]')) return;
      closeWatch(true);
    });
    loadFeeds();

    var manage = document.getElementById("ytManageChannels");
    if (manage && window.YoutubeChannelsAdmin) {
      manage.addEventListener("click", function () {
        window.YoutubeChannelsAdmin.open({
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
