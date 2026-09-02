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

  var THEME_KEY = "yt:theme";

  function readStoredTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY) || "";
    } catch (e) {
      // Private mode and blocked site data both throw here. A remembered theme
      // is a convenience; losing it must not stop the page rendering.
      return "";
    }
  }

  function storeTheme(id) {
    try {
      window.localStorage.setItem(THEME_KEY, id);
    } catch (e) {
      /* best effort */
    }
  }

  function themeHandles(theme) {
    return (theme && theme.channels ? theme.channels : []).map(function (member) {
      return normalizeHandle(member.handle);
    });
  }

  /**
   * Narrows a list of items to the channels a theme owns.
   *
   * An item whose handle the payload never supplied is kept rather than
   * dropped: older payloads carry no channelHandle, and silently hiding every
   * video would look like an outage rather than a missing field.
   */
  function filterToTheme(items, theme) {
    var handles = themeHandles(theme);
    if (!handles.length) return [];
    return items.filter(function (item) {
      return !item.channelHandle || handles.indexOf(item.channelHandle) >= 0;
    });
  }

  function render(roots, data, onSelect, theme) {
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

    if (theme) {
      var handles = themeHandles(theme);

      // A theme with no channels yet is the normal state of a newly added one.
      // Saying "no videos found" there reads as a failed fetch and hides the
      // one thing that would fix it.
      if (!handles.length) {
        renderGrid(roots.live, [], "No channels in this theme yet.", onSelect);
        renderGrid(roots.upcoming, [], "No channels in this theme yet.", onSelect);
        renderGrid(
          roots.uploads,
          [],
          "No channels in this theme yet — add them to src/config/youtube-themes.js.",
          onSelect,
        );
        return null;
      }

      live = filterToTheme(live, theme);
      upcoming = filterToTheme(upcoming, theme);
      uploads = filterToTheme(uploads, theme);
      // Only failures for channels this theme owns: another theme's dead feed
      // is not this view's problem to report.
      failed = failed.filter(function (channel) {
        return handles.indexOf(normalizeHandle(channel.handle)) >= 0;
      });
    }

    renderGrid(roots.live, live, emptyLiveText(meta, "live"), onSelect);
    renderGrid(roots.upcoming, upcoming, emptyLiveText(meta, "upcoming"), onSelect);
    renderGrid(roots.uploads, uploads, "No videos found yet.", onSelect);
    renderFailures(roots.uploads, failed);

    var first = live[0] || upcoming[0] || uploads[0];
    return first && first.video ? first.video.id : null;
  }

  /**
   * Builds the theme switcher. Returns a function that re-renders it, or null
   * when the payload carries no themes — an older server, in which case the
   * switcher stays hidden and the page renders every channel as it always did.
   */
  function setupThemeSwitcher(themes, onChange) {
    var switcher = document.getElementById("ytThemeSwitcher");
    var trigger = document.getElementById("ytThemeTrigger");
    var label = document.getElementById("ytThemeTriggerLabel");
    var menu = document.getElementById("ytThemeMenu");
    var description = document.getElementById("ytThemeDescription");
    if (!switcher || !trigger || !menu || !themes.length) return null;

    switcher.hidden = false;

    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }

    document.addEventListener("click", function (e) {
      if (!switcher.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    trigger.addEventListener("click", function () {
      setOpen(menu.hidden);
    });

    return function renderSwitcher(activeId) {
      var active = themes.filter(function (theme) { return theme.id === activeId; })[0] || themes[0];
      if (label) label.textContent = active.name;
      if (description) description.textContent = active.description || "";
      document.body.setAttribute("data-yt-accent", active.accent || "market");

      menu.innerHTML = "";
      themes.forEach(function (theme) {
        var option = document.createElement("button");
        option.type = "button";
        option.className = "yt-theme-option" + (theme.id === active.id ? " active" : "");

        var name = document.createElement("span");
        name.className = "yt-theme-option-name";
        name.textContent = theme.name;

        var count = document.createElement("span");
        count.className = "yt-theme-option-count";
        var total = (theme.channels || []).length;
        count.textContent = total + (total === 1 ? " channel" : " channels");

        option.appendChild(name);
        option.appendChild(count);
        option.addEventListener("click", function () {
          setOpen(false);
          onChange(theme.id);
        });
        menu.appendChild(option);
      });
    };
  }

  function loadFeeds(roots, onSelect, onInitialVideo) {
    fetch("/api/youtube/channels")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var payload = data || {};
        var themes = payload.themes || [];
        var stored = readStoredTheme();
        // A stored id that no longer exists (a theme removed in a deploy) falls
        // back to the first theme rather than rendering an empty page.
        var activeId = themes.filter(function (theme) { return theme.id === stored; })[0]
          ? stored
          : (themes[0] ? themes[0].id : "");

        function activeTheme() {
          return themes.filter(function (theme) { return theme.id === activeId; })[0] || null;
        }

        var renderSwitcher = setupThemeSwitcher(themes, function (id) {
          if (id === activeId) return;
          activeId = id;
          storeTheme(id);
          if (renderSwitcher) renderSwitcher(activeId);
          // Re-render from the payload already in hand: switching themes is a
          // view change, so it costs no request and no YouTube quota.
          render(roots, payload, onSelect, activeTheme());
        });
        if (renderSwitcher) renderSwitcher(activeId);

        var firstId = render(roots, payload, onSelect, activeTheme());
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
