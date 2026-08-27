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
  // Bumped to :v4 for the timestamped schema. The v3 entries it replaces had
  // no saved-at time, so a browser could show them indefinitely with nothing
  // to say how old they were — they cannot be repaired in place, only
  // stranded, which is what the new key does. v3 is dropped on sight to
  // reclaim the space rather than leaving it to linger.
  var localFeedKey = "xIntelligence:feedCache:v4";
  var legacyFeedKeys = ["xIntelligence:feedCache:v3"];
  var FEED_CACHE_TTL_MS = 45 * 60 * 1000;
  var ALL_MODE = "all";

  var renderPostCards = window.XPosts.renderPostCards;
  var renderFeedError = window.XPosts.renderFeedError;
  var renderStaleNotice = window.XPosts.renderStaleNotice;
  var renderFeedStatus = window.XPosts.renderFeedStatus;
  // Shared with the Node tests, so the page and the tests agree on what
  // the reader is told about freshness.
  var relativeTime = window.XFreshness.formatRelativeTime;
  var decideRefresh = window.XFreshness.decideRefresh;
  var computeStatus = window.XFreshness.describeStatus;

  function dropLegacyCaches() {
    legacyFeedKeys.forEach(function (key) {
      try { localStorage.removeItem(key); } catch (err) {}
    });
  }

  /* Returns the cached payload together with when it was saved and whether
     that has expired. The age travels with the data so nothing downstream can
     present it without knowing how old it is. */
  function readCachedFeed() {
    try {
      var parsed = JSON.parse(localStorage.getItem(localFeedKey) || "null");
      if (!parsed || !parsed.payload || !Array.isArray(parsed.payload.posts)) return null;
      var savedAt = Number(parsed.savedAt);
      if (!isFinite(savedAt) || savedAt <= 0) return null;
      return {
        payload: parsed.payload,
        savedAt: savedAt,
        savedAtIso: new Date(savedAt).toISOString(),
        expired: Date.now() - savedAt > FEED_CACHE_TTL_MS,
      };
    } catch (err) {
      return null;
    }
  }

  function writeCachedFeed(payload) {
    try {
      localStorage.setItem(localFeedKey, JSON.stringify({ savedAt: Date.now(), payload: payload }));
    } catch (err) {}
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

  /* Resolves to {ok:true, data} or {ok:false, reason}. It must never turn a
     failure into an empty-but-successful feed: that is what made an outage
     indistinguishable from "no posts today", and left last week's posts on
     screen looking current. */
  function loadAccountsFeed() {
    return fetch("/api/x/accounts", { headers: { Accept: "application/json" } }).then(
      function (res) {
        if (!res.ok) {
          return { ok: false, reason: "The dashboard server returned " + res.status };
        }
        return res.json().then(
          function (data) {
            if (!data || !Array.isArray(data.posts) || !Array.isArray(data.accounts)) {
              return { ok: false, reason: "The feed response was malformed" };
            }
            return { ok: true, data: data };
          },
          function () {
            return { ok: false, reason: "The feed response could not be parsed" };
          }
        );
      },
      function () {
        return { ok: false, reason: "Couldn't reach the dashboard server" };
      }
    );
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
    dropLegacyCaches();
    var cached = readCachedFeed();
    var state = {
      // Default to the full feed; a single account only shows its own posts.
      mode: lastMode === "account" ? "account" : ALL_MODE,
      handle: validLast ? lastHandle : accounts[0].handle,
      feedData: cached ? cached.payload : { posts: [], accounts: [], failedFeeds: [] },
      // Set while what is on screen came out of the browser cache rather than
      // this page load's fetch; cleared as soon as the server answers.
      cache: cached,
      transport: { ok: true },
      loaded: !!cached,
    };

    function renderPane() {
      syncPanelLabel();
      if (!state.loaded) {
        renderPostCards(pane, [], "Loading latest posts…");
        return;
      }
      if (state.mode === ALL_MODE) {
        renderPostCards(
          pane,
          state.feedData.posts,
          state.transport.ok ? "No posts found yet." : "Couldn't load posts."
        );
        renderFeedError(pane, state.feedData.failedFeeds);
        renderStaleNotice(pane, state.feedData.staleFeeds);
        renderFeedStatus(pane, computeStatus(state, null));
        return;
      }
      var handlePosts = state.feedData.posts.filter(function (p) { return p.handle === state.handle; });
      var failed = (state.feedData.failedFeeds || []).some(function (a) { return a.handle === state.handle; });
      var stale = (state.feedData.staleFeeds || []).filter(function (a) { return a.handle === state.handle; });
      renderPostCards(
        pane,
        handlePosts,
        failed || !state.transport.ok
          ? "Couldn't load current posts for @" + state.handle + " right now."
          : "No recent posts found for @" + state.handle + "."
      );
      renderStaleNotice(pane, stale);
      renderFeedStatus(pane, computeStatus(state, state.handle));
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

    loadAccountsFeed().then(function (result) {
      state.loaded = true;

      if (result.ok) {
        var data = result.data;
        var payload = {
          status: data.status,
          generatedAt: data.generatedAt,
          lastCheckedAt: data.lastCheckedAt,
          mostRecentSuccessfulFetchAt: data.mostRecentSuccessfulFetchAt,
          oldestSuccessfulFetchAt: data.oldestSuccessfulFetchAt,
          newestPostAt: data.newestPostAt,
          counts: data.counts || {},
          posts: data.posts,
          accounts: data.accounts,
          failedFeeds: data.failedFeeds || [],
          staleFeeds: data.staleFeeds || [],
        };

        // The outage the server can still answer through: every provider is
        // down, so this 200 carries no posts. Replacing on it would delete
        // the last-known-good history and overwrite the stored cache with the
        // empty response — losing the data at the exact moment it is the only
        // thing left. Hold what we have and say why.
        if (decideRefresh(state.cache, payload).action === "preserve") {
          state.transport = { ok: true };
          state.serverOutage = payload;
          renderPane();
          return;
        }

        // Otherwise the server is authoritative about freshness and replaces
        // what is on screen — post count is not evidence either way.
        state.feedData = payload;
        state.transport = { ok: true };
        state.serverOutage = null;
        state.cache = null;
        writeCachedFeed(payload);
        renderPane();
        return;
      }

      // A transport failure stays a failure. Anything still on screen came
      // out of the browser cache and gets labelled as such, with its age.
      state.transport = { ok: false, reason: result.reason };
      renderPane();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
