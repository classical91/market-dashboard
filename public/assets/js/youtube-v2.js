(function () {
  "use strict";

  function embedUrl(id) {
    return "https://www.youtube.com/embed/" + id;
  }
  function watchUrl(id) {
    return "https://youtu.be/" + id;
  }
  function thumbUrl(id) {
    return "https://img.youtube.com/vi/" + id + "/hqdefault.jpg";
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

    return uploads.map(function (video) {
      return {
        video: video,
        channelLabel: video.channelLabel || video.channelHandle || "YouTube",
        channelCategory: video.channelCategory || "",
      };
    });
  }

  function buildCard(item, onSelect) {
    var video = item.video;
    var card = document.createElement("a");
    card.className = "yt-feed-card";
    if (video.state === "live") card.className += " yt-feed-card-live";
    if (video.state === "upcoming") card.className += " yt-feed-card-upcoming";
    card.href = video.url || "https://www.youtube.com/watch?v=" + video.id;
    card.target = "_blank";
    card.rel = "noopener";

    var thumb = document.createElement("div");
    thumb.className = "yt-feed-thumb";
    thumb.style.backgroundImage = "url('" + (video.thumbnail || thumbUrl(video.id)) + "')";

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
    title.textContent = video.title;

    var meta = document.createElement("div");
    meta.className = "yt-feed-meta";

    var tag = document.createElement("span");
    tag.className = "yt-tag";
    tag.textContent = item.channelLabel;
    meta.appendChild(tag);

    var detail;
    if (video.state === "live") {
      detail = formatViewers(video.concurrentViewers) || "Streaming now";
    } else if (video.state === "upcoming") {
      detail = formatCountdown(video.scheduledStartTime);
    } else {
      detail = formatRelativeDate(video.publishedAt);
    }

    if (detail) {
      var detailNode = document.createElement("span");
      detailNode.className = "yt-feed-detail";
      detailNode.textContent = " · " + detail;
      meta.appendChild(detailNode);
    }

    body.appendChild(title);
    body.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(body);

    card.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !video.id) return;
      e.preventDefault();
      onSelect(video.id);
    });

    return card;
  }

  function renderGrid(root, items, emptyText, onSelect) {
    if (!root) return;
    root.innerHTML = "";

    var grid = document.createElement("div");
    grid.className = "yt-channel-videos";
    items.forEach(function (item) {
      grid.appendChild(buildCard(item, onSelect));
    });

    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "yt-empty";
      empty.textContent = emptyText;
      grid.appendChild(empty);
    }

    root.appendChild(grid);
    return grid;
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

  function render(roots, data, onSelect) {
    var meta = data.meta || {};
    var failed = data.failedFeeds || [];
    var items = normalizeUploads(data);

    function wrap(list) {
      return list.map(function (video) {
        return {
          video: video,
          channelLabel: video.channelLabel || video.channelHandle || "YouTube",
          channelCategory: video.channelCategory || "",
        };
      });
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

    renderGrid(roots.live, live, emptyLiveText(meta, "live"), onSelect);
    renderGrid(roots.upcoming, upcoming, emptyLiveText(meta, "upcoming"), onSelect);
    renderGrid(roots.uploads, uploads, "No videos found yet.", onSelect);
    renderFailures(roots.uploads, failed);

    var first = live[0] || upcoming[0] || uploads[0];
    return first && first.video ? first.video.id : null;
  }

  function loadFeeds(roots, onSelect, onInitialVideo) {
    fetch("/api/youtube/channels")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var firstId = render(roots, data || {}, onSelect);
        if (firstId && onInitialVideo) onInitialVideo(firstId);
      })
      .catch(function () {
        Object.keys(roots).forEach(function (key) {
          if (roots[key]) {
            roots[key].innerHTML = '<div class="yt-empty">Channel feeds are unavailable right now.</div>';
          }
        });
      });
  }

  function init() {
    var player = document.getElementById("ytPlayer");
    var playerLink = document.getElementById("ytPlayerLink");
    if (!player) return;

    var roots = {
      live: document.getElementById("ytLiveFeeds"),
      upcoming: document.getElementById("ytUpcomingFeeds"),
      uploads: document.getElementById("ytChannelFeeds"),
    };

    var state = { activeId: null };

    function loadActive() {
      if (!state.activeId) return;
      player.src = embedUrl(state.activeId);
      if (playerLink) playerLink.href = watchUrl(state.activeId);
    }

    loadFeeds(
      roots,
      function (id) {
        state.activeId = id;
        loadActive();
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      function (id) {
        if (state.activeId) return;
        state.activeId = id;
        loadActive();
      }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
