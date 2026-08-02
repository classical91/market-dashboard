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

  // Bumped to :v2 to drop selections saved under the old default, where an
  // unset mode meant "first account" — devices that had never explicitly
  // chosen were stuck on a single handle's 8 posts.
  var localModeKey = "xIntelligence:lastMode:v2";
  var localKey = "xIntelligence:lastHandle";
  var localFeedKey = "xIntelligence:feedCache:v3";
  var ALL_MODE = "all";

  var renderPostCards = window.XPosts.renderPostCards;
  var renderFeedError = window.XPosts.renderFeedError;
  var renderStaleNotice = window.XPosts.renderStaleNotice;

  function readCachedFeed() {
    try {
      var parsed = JSON.parse(localStorage.getItem(localFeedKey) || "null");
      if (!parsed || !Array.isArray(parsed.posts)) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeCachedFeed(data) {
    try { localStorage.setItem(localFeedKey, JSON.stringify(data)); } catch (err) {}
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

  function readLastMode() {
    try { return localStorage.getItem(localModeKey) || ""; } catch (err) { return ""; }
  }

  function writeLastMode(mode) {
    try { localStorage.setItem(localModeKey, mode); } catch (err) {}
  }

  function renderList(root, activeMode, activeHandle, onSelectAll, onSelect) {
    root.innerHTML = "";

    var allCard = document.createElement("button");
    allCard.type = "button";
    allCard.className = "x-account-card x-account-card--all" + (activeMode === ALL_MODE ? " active" : "");
    allCard.innerHTML = '<span class="x-account-handle">&#127760; All Accounts</span>';
    allCard.addEventListener("click", onSelectAll);
    root.appendChild(allCard);

    GROUPS.forEach(function (group) {
      var heading = document.createElement("div");
      heading.className = "x-account-group-title";
      heading.textContent = group.label;
      root.appendChild(heading);

      group.accounts.forEach(function (handle) {
        var card = document.createElement("button");
        card.type = "button";
        card.className = "x-account-card" + (activeMode !== ALL_MODE && handle === activeHandle ? " active" : "");
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

  function loadAccountsFeed() {
    return fetch("/api/x/accounts")
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .catch(function () {
        return { posts: [], failedFeeds: [] };
      });
  }

  function init() {
    var listRoot = document.getElementById("xAccountList");
    var pane = document.getElementById("xTimelinePane");
    var paneLabel = document.getElementById("xTimelineLabel");
    var paneLink = document.getElementById("xTimelineLink");
    var panel = document.getElementById("xAccountPanel");
    var panelToggle = document.getElementById("xAccountToggle");
    var panelToggleLabel = document.getElementById("xAccountToggleLabel");
    if (!listRoot || !pane) return;

    // Mobile only (CSS hides the toggle above 980px): the account list starts
    // collapsed so the page opens on the posts, and folds itself away again
    // once a selection is made.
    function setPanelOpen(open) {
      if (!panel) return;
      if (open) panel.classList.remove("is-collapsed");
      else panel.classList.add("is-collapsed");
      if (panelToggle) panelToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function visiblePostCount() {
      var posts = state.feedData.posts || [];
      if (state.mode === ALL_MODE) return posts.length;
      return posts.filter(function (p) { return p.handle === state.handle; }).length;
    }

    // Reads e.g. "Accounts · All Accounts (147)" — the count makes it obvious
    // that a single handle is a much smaller slice than the full feed.
    function syncPanelLabel() {
      if (!panelToggleLabel) return;
      var selection = state.mode === ALL_MODE ? "All Accounts" : "@" + state.handle;
      panelToggleLabel.textContent =
        "Accounts · " + selection + (state.loaded ? " (" + visiblePostCount() + ")" : "");
    }

    if (panelToggle && panel) {
      panelToggle.addEventListener("click", function () {
        setPanelOpen(panel.classList.contains("is-collapsed"));
      });
    }

    var accounts = allAccounts();
    var lastHandle = readLastHandle();
    var validLast = accounts.some(function (a) { return a.handle === lastHandle; });
    var lastMode = readLastMode();
    var cached = readCachedFeed();
    var state = {
      // Default to the full feed; a single account only shows its own posts.
      mode: lastMode === "account" ? "account" : ALL_MODE,
      handle: validLast ? lastHandle : accounts[0].handle,
      feedData: cached || { posts: [], failedFeeds: [] },
      loaded: !!cached,
    };

    function renderPane() {
      syncPanelLabel();
      if (!state.loaded) {
        renderPostCards(pane, [], "Loading latest posts…");
        return;
      }
      if (state.mode === ALL_MODE) {
        renderPostCards(pane, state.feedData.posts, "No posts found yet.");
        renderFeedError(pane, state.feedData.failedFeeds);
        renderStaleNotice(pane, state.feedData.staleFeeds);
        return;
      }
      var handlePosts = state.feedData.posts.filter(function (p) { return p.handle === state.handle; });
      var failed = (state.feedData.failedFeeds || []).some(function (a) { return a.handle === state.handle; });
      var stale = (state.feedData.staleFeeds || []).filter(function (a) { return a.handle === state.handle; });
      renderPostCards(
        pane,
        handlePosts,
        failed
          ? "Couldn't load current posts for @" + state.handle + " right now."
          : "No recent posts found for @" + state.handle + "."
      );
      renderStaleNotice(pane, stale);
    }

    function refreshList() {
      renderList(listRoot, state.mode, state.handle, selectAll, selectHandle);
    }

    function selectAll() {
      state.mode = ALL_MODE;
      writeLastMode(ALL_MODE);
      if (paneLabel) paneLabel.textContent = "All Accounts";
      if (paneLink) paneLink.href = "https://x.com/";
      setPanelOpen(false);
      renderPane();
      refreshList();
    }

    function selectHandle(handle) {
      state.mode = "account";
      state.handle = handle;
      writeLastMode("account");
      writeLastHandle(handle);
      if (paneLabel) paneLabel.textContent = "@" + handle;
      if (paneLink) paneLink.href = "https://x.com/" + handle;
      setPanelOpen(false);
      renderPane();
      refreshList();
    }

    refreshList();
    if (state.mode === ALL_MODE) selectAll(); else selectHandle(state.handle);

    loadAccountsFeed().then(function (data) {
      var hasFreshPosts = Array.isArray(data.posts) && data.posts.length > 0;
      // Keep whatever was cached/shown if this fetch came back empty (e.g. a
      // transient failure), instead of wiping out posts that were already
      // on screen.
      if (hasFreshPosts || !state.loaded) {
        state.feedData = {
          posts: data.posts || [],
          failedFeeds: data.failedFeeds || [],
          staleFeeds: (data.accounts || []).filter(function (a) { return a.stale; }),
        };
      }
      state.loaded = true;
      if (hasFreshPosts) writeCachedFeed(state.feedData);
      renderPane();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
