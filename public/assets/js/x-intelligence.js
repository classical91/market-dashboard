(function () {
  "use strict";

  var GROUPS = [
    {
      key: "market-data",
      label: "Market Data",
      accounts: ["Barchart"],
    },
    {
      key: "crypto-traders",
      label: "Crypto Traders",
      accounts: [
        "jasonpizzino", "TechDev_52", "TraderAlejito", "trader1sz",
        "RoccobullboTTom", "CryptoFaibik", "doerXBT", "joker_szn",
        "52kskew", "LH_btc", "hupzy_agent",
      ],
    },
    {
      key: "ta-signals",
      label: "TA & Signals",
      accounts: [
        "Luckshuryy", "wacy_time1", "CoinSignals_", "leviathancrypto",
        "StockmoneyL", "clifton_ideas", "TATrader_Alan", "CryptoCaesarTA",
        "cryptic_heych", "CharTTrapperZ",
      ],
    },
  ];

  var localKey = "xIntelligence:lastHandle";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function allAccounts() {
    var seen = {};
    var out = [];
    GROUPS.forEach(function (group) {
      group.accounts.forEach(function (handle) {
        if (seen[handle]) return;
        seen[handle] = true;
        out.push({ handle: handle, group: group.key });
      });
    });
    return out;
  }

  function readLastHandle() {
    try { return localStorage.getItem(localKey) || ""; } catch (err) { return ""; }
  }

  function writeLastHandle(handle) {
    try { localStorage.setItem(localKey, handle); } catch (err) {}
  }

  function loadWidgetsScript(cb) {
    if (window.twttr && window.twttr.widgets) { cb(); return; }
    var existing = document.getElementById("twitter-wjs");
    if (existing) {
      existing.addEventListener("load", cb);
      return;
    }
    var script = document.createElement("script");
    script.id = "twitter-wjs";
    script.src = "https://platform.twitter.com/widgets.js";
    script.async = true;
    script.onload = cb;
    document.head.appendChild(script);
  }

  function renderList(root, activeHandle, onSelect) {
    root.innerHTML = "";

    GROUPS.forEach(function (group) {
      var heading = document.createElement("div");
      heading.className = "x-account-group-title";
      heading.textContent = group.label;
      root.appendChild(heading);

      group.accounts.forEach(function (handle) {
        var card = document.createElement("button");
        card.type = "button";
        card.className = "x-account-card" + (handle === activeHandle ? " active" : "");
        card.innerHTML =
          '<span class="x-account-handle">@' + handle + "</span>" +
          '<a class="x-account-open" href="https://x.com/' + handle + '" target="_blank" rel="noopener">Open &#8599;</a>';
        card.addEventListener("click", function (e) {
          if (e.target && e.target.classList.contains("x-account-open")) return;
          onSelect(handle);
        });
        root.appendChild(card);
      });
    });
  }

  function renderTimeline(pane, handle) {
    pane.innerHTML = "";
    var anchor = document.createElement("a");
    anchor.className = "twitter-timeline";
    anchor.setAttribute("data-theme", "dark");
    anchor.setAttribute("data-chrome", "noheader nofooter transparent");
    anchor.href = "https://twitter.com/" + handle + "?ref_src=twsrc%5Etfw";
    anchor.textContent = "Tweets by @" + handle;
    pane.appendChild(anchor);

    loadWidgetsScript(function () {
      if (window.twttr && window.twttr.widgets) {
        window.twttr.widgets.load(pane);
      }
    });
  }

  function formatRelativeDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var diffMs = Date.now() - date.getTime();
    var hour = 60 * 60 * 1000;
    var hours = Math.floor(diffMs / hour);
    if (hours < 1) return "Just now";
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    var months = Math.floor(days / 30);
    return months + (months === 1 ? " month ago" : " months ago");
  }

  function renderPostFeed(root, data) {
    root.innerHTML = "";
    var posts = (data.posts || []).slice().sort(function (a, b) {
      var aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      var bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bTime - aTime;
    });

    var grid = document.createElement("div");
    grid.className = "x-post-grid";

    posts.forEach(function (post) {
      var card = document.createElement("a");
      card.className = "x-post-card";
      card.href = post.url;
      card.target = "_blank";
      card.rel = "noopener";

      var meta = document.createElement("div");
      meta.className = "x-post-meta";
      meta.innerHTML =
        '<span class="x-tag">@' + post.handle + "</span> &middot; " +
        (post.category ? esc(post.category) + " &middot; " : "") +
        formatRelativeDate(post.publishedAt);

      var text = document.createElement("div");
      text.className = "x-post-text";
      text.textContent = post.text;

      card.appendChild(meta);
      card.appendChild(text);
      grid.appendChild(card);
    });

    if (!posts.length) {
      var empty = document.createElement("div");
      empty.className = "x-empty";
      empty.textContent = "No posts found yet.";
      grid.appendChild(empty);
    }

    root.appendChild(grid);

    var failed = data.failedFeeds || [];
    if (failed.length) {
      var err = document.createElement("div");
      err.className = "x-feed-error";
      err.textContent =
        "Couldn't load feed" + (failed.length > 1 ? "s" : "") + " for: " +
        failed.map(function (a) { return "@" + a.handle; }).join(", ");
      root.appendChild(err);
    }
  }

  function loadPostFeed(root) {
    if (!root) return;
    fetch("/api/x/accounts")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        renderPostFeed(root, data || {});
      })
      .catch(function () {
        root.innerHTML = '<div class="x-empty">Latest posts are unavailable right now.</div>';
      });
  }

  function init() {
    var listRoot = document.getElementById("xAccountList");
    var pane = document.getElementById("xTimelinePane");
    var paneLabel = document.getElementById("xTimelineLabel");
    var paneLink = document.getElementById("xTimelineLink");
    var postFeedRoot = document.getElementById("xPostFeed");
    loadPostFeed(postFeedRoot);
    if (!listRoot || !pane) return;

    var accounts = allAccounts();
    var lastHandle = readLastHandle();
    var validLast = accounts.some(function (a) { return a.handle === lastHandle; });
    var state = {
      handle: validLast ? lastHandle : accounts[0].handle,
    };

    function selectHandle(handle) {
      state.handle = handle;
      writeLastHandle(handle);
      renderTimeline(pane, handle);
      if (paneLabel) paneLabel.textContent = "@" + handle;
      if (paneLink) paneLink.href = "https://x.com/" + handle;
      renderList(listRoot, state.handle, selectHandle);
    }

    renderList(listRoot, state.handle, selectHandle);
    selectHandle(state.handle);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
