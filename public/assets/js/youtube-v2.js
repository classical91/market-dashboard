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

  function init() {
    var player = document.getElementById("ytPlayer");
    var playerLink = document.getElementById("ytPlayerLink");
    var queueRoot = document.getElementById("ytQueue");
    var filterRoot = document.getElementById("ytFilters");
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
