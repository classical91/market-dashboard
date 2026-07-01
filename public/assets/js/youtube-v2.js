(function () {
  "use strict";

  var videos = [
    {
      id: "8chUwQM-5fk",
      title: "Saved YouTube Video 1",
      category: "Market",
      type: "saved-video",
    },
    {
      id: "UhDaBroN1ps",
      title: "Saved YouTube Video 2",
      category: "Market",
      type: "saved-video",
    },
  ];

  function embedUrl(id) {
    return "https://www.youtube.com/embed/" + id;
  }
  function watchUrl(id) {
    return "https://youtu.be/" + id;
  }
  function thumbUrl(id) {
    return "https://img.youtube.com/vi/" + id + "/hqdefault.jpg";
  }

  function categories() {
    var seen = {};
    var list = ["All"];
    videos.forEach(function (v) {
      if (!seen[v.category]) { seen[v.category] = true; list.push(v.category); }
    });
    return list;
  }

  function renderFilters(root, activeCategory, onSelect) {
    root.innerHTML = "";
    categories().forEach(function (cat) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "yt-filter" + (cat === activeCategory ? " active" : "");
      btn.textContent = cat;
      btn.addEventListener("click", function () { onSelect(cat); });
      root.appendChild(btn);
    });
  }

  function renderQueue(root, activeCategory, activeId, onSelect) {
    root.innerHTML = "";
    var filtered = videos.filter(function (v) {
      return activeCategory === "All" || v.category === activeCategory;
    });

    if (!filtered.length) {
      var empty = document.createElement("div");
      empty.className = "yt-empty";
      empty.textContent = "No videos in this category yet.";
      root.appendChild(empty);
      return;
    }

    filtered.forEach(function (v) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "yt-card" + (v.id === activeId ? " active" : "");

      var thumb = document.createElement("div");
      thumb.className = "yt-card-thumb";
      thumb.style.backgroundImage = "url('" + thumbUrl(v.id) + "')";

      var body = document.createElement("div");
      body.className = "yt-card-body";

      var title = document.createElement("div");
      title.className = "yt-card-title";
      title.textContent = v.title;

      var meta = document.createElement("div");
      meta.className = "yt-card-meta";
      meta.innerHTML = '<span class="yt-tag">' + v.category + '</span>';

      body.appendChild(title);
      body.appendChild(meta);
      card.appendChild(thumb);
      card.appendChild(body);

      card.addEventListener("click", function () { onSelect(v.id); });
      root.appendChild(card);
    });
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

  function renderChannelFeeds(root, channels, onSelect) {
    root.innerHTML = "";

    channels.forEach(function (channel) {
      var block = document.createElement("div");
      block.className = "yt-channel-block";

      var head = document.createElement("div");
      head.className = "yt-channel-head";
      head.innerHTML =
        '<span class="yt-channel-name">' + channel.label + "</span>" +
        '<span class="yt-tag">' + channel.category + "</span>";
      block.appendChild(head);

      if (channel.error) {
        var err = document.createElement("div");
        err.className = "yt-channel-error";
        err.textContent = "Couldn't load this channel's feed right now.";
        block.appendChild(err);
        root.appendChild(block);
        return;
      }

      var grid = document.createElement("div");
      grid.className = "yt-channel-videos";

      (channel.videos || []).forEach(function (video) {
        var card = document.createElement("a");
        card.className = "yt-feed-card";
        card.href = video.url || ("https://www.youtube.com/watch?v=" + video.id);
        card.target = "_blank";
        card.rel = "noopener";

        var thumb = document.createElement("div");
        thumb.className = "yt-feed-thumb";
        thumb.style.backgroundImage = "url('" + (video.thumbnail || thumbUrl(video.id)) + "')";

        var body = document.createElement("div");
        body.className = "yt-feed-body";

        var title = document.createElement("div");
        title.className = "yt-feed-title";
        title.textContent = video.title;

        var meta = document.createElement("div");
        meta.className = "yt-feed-meta";
        meta.textContent = formatRelativeDate(video.publishedAt);

        body.appendChild(title);
        body.appendChild(meta);
        card.appendChild(thumb);
        card.appendChild(body);

        card.addEventListener("click", function (e) {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !video.id) return;
          e.preventDefault();
          onSelect(video.id);
        });

        grid.appendChild(card);
      });

      if (!(channel.videos || []).length) {
        var empty = document.createElement("div");
        empty.className = "yt-empty";
        empty.textContent = "No videos found yet.";
        grid.appendChild(empty);
      }

      block.appendChild(grid);
      root.appendChild(block);
    });
  }

  function loadChannelFeeds(root, onSelect) {
    if (!root) return;
    fetch("/api/youtube/channels")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderChannelFeeds(root, data.channels || [], onSelect);
      })
      .catch(function () {
        root.innerHTML = '<div class="yt-empty">Channel feeds are unavailable right now.</div>';
      });
  }

  function init() {
    var player = document.getElementById("ytPlayer");
    var playerLink = document.getElementById("ytPlayerLink");
    var queueRoot = document.getElementById("ytQueue");
    var filterRoot = document.getElementById("ytFilters");
    var channelFeedsRoot = document.getElementById("ytChannelFeeds");
    if (!player || !queueRoot || !filterRoot) return;

    var state = {
      category: "All",
      activeId: videos[0] ? videos[0].id : null,
    };

    function loadActive() {
      if (!state.activeId) return;
      player.src = embedUrl(state.activeId);
      if (playerLink) playerLink.href = watchUrl(state.activeId);
    }

    function render() {
      renderFilters(filterRoot, state.category, function (cat) {
        state.category = cat;
        var visible = videos.filter(function (v) { return cat === "All" || v.category === cat; });
        if (visible.length && !visible.some(function (v) { return v.id === state.activeId; })) {
          state.activeId = visible[0].id;
          loadActive();
        }
        render();
      });
      renderQueue(queueRoot, state.category, state.activeId, function (id) {
        state.activeId = id;
        loadActive();
        render();
      });
    }

    loadActive();
    render();
    loadChannelFeeds(channelFeedsRoot, function (id) {
      state.activeId = id;
      loadActive();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
