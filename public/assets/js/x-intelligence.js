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

  var localModeKey = "xIntelligence:lastMode";
  var localKey = "xIntelligence:lastHandle";
  var localFeedKey = "xIntelligence:feedCache:v3";
  var ALL_MODE = "all";

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

  function sortByPublishedDesc(posts) {
    return posts.slice().sort(function (a, b) {
      var aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      var bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  function copyTextForPost(post, includeImageUrl) {
    var lines = ["@" + post.handle, "", post.text || "", "", "Tweet: " + post.url];
    if (includeImageUrl && post.image) lines.push("Photo: " + post.image);
    return lines.join("\n").trim();
  }

  function imageBlobToPng(blob) {
    if (!blob || !blob.type || blob.type === "image/png") return Promise.resolve(blob);
    if (!window.createImageBitmap) return Promise.resolve(blob);

    return createImageBitmap(blob).then(function (bitmap) {
      var canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (pngBlob) {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error("Image conversion failed"));
        }, "image/png");
      });
    });
  }

  function copyPostToClipboard(post) {
    var plainText = copyTextForPost(post, false);
    var fallbackText = copyTextForPost(post, true);

    if (!navigator.clipboard) {
      return Promise.reject(new Error("Clipboard is unavailable"));
    }

    if (post.image && window.ClipboardItem && navigator.clipboard.write) {
      return fetch(post.image, { mode: "cors" })
        .then(function (res) {
          if (!res.ok) throw new Error("Image request failed");
          return res.blob();
        })
        .then(imageBlobToPng)
        .then(function (blob) {
          var item = new ClipboardItem({
            "text/plain": new Blob([plainText], { type: "text/plain" }),
            "image/png": blob,
          });
          return navigator.clipboard.write([item]).then(function () { return "image"; });
        })
        .catch(function () {
          return navigator.clipboard.writeText(fallbackText).then(function () { return "textImageUrl"; });
        });
    }

    return navigator.clipboard.writeText(fallbackText).then(function () {
      return post.image ? "textImageUrl" : "text";
    });
  }

  function setCopyStatus(button, label) {
    button.textContent = label;
    window.setTimeout(function () {
      button.textContent = "Copy";
    }, 1800);
  }

  function renderPostCards(root, posts, emptyText) {
    root.innerHTML = "";
    root.classList.toggle("is-empty", !posts.length);
    var grid = document.createElement("div");
    grid.className = "x-post-grid";

    sortByPublishedDesc(posts).forEach(function (post) {
      var card = document.createElement("article");
      card.className = "x-post-card";

      var meta = document.createElement("div");
      meta.className = "x-post-meta";
      meta.innerHTML =
        '<span class="x-tag">@' + esc(post.handle) + "</span> &middot; " +
        (post.category ? esc(post.category) + " &middot; " : "") +
        formatRelativeDate(post.publishedAt);

      var text = document.createElement("div");
      text.className = "x-post-text";
      text.textContent = post.text;

      card.appendChild(meta);
      if (post.image) {
        var img = document.createElement("img");
        img.className = "x-post-image";
        img.src = post.image;
        img.loading = "lazy";
        img.alt = "";
        card.appendChild(img);
      }
      card.appendChild(text);

      var actions = document.createElement("div");
      actions.className = "x-post-actions";

      var openLink = document.createElement("a");
      openLink.className = "x-post-open";
      openLink.href = post.url;
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.textContent = "Open";

      var copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "x-post-copy";
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", function () {
        copyButton.disabled = true;
        copyButton.textContent = "Copying...";
        copyPostToClipboard(post)
          .then(function (mode) {
            setCopyStatus(
              copyButton,
              mode === "image" ? "Copied text + photo" : mode === "textImageUrl" ? "Copied text + photo URL" : "Copied text",
            );
          })
          .catch(function () {
            setCopyStatus(copyButton, "Copy failed");
          })
          .then(function () {
            copyButton.disabled = false;
          });
      });

      actions.appendChild(openLink);
      actions.appendChild(copyButton);
      card.appendChild(actions);
      grid.appendChild(card);
    });

    if (!posts.length) {
      var empty = document.createElement("div");
      empty.className = "x-empty";
      empty.textContent = emptyText || "No posts found yet.";
      grid.appendChild(empty);
    }

    root.appendChild(grid);
  }

  function renderFeedError(root, failedFeeds) {
    if (!failedFeeds || !failedFeeds.length) return;
    var err = document.createElement("div");
    err.className = "x-feed-error";
    err.textContent =
      "Couldn't load feed" + (failedFeeds.length > 1 ? "s" : "") + " for: " +
      failedFeeds.map(function (a) { return "@" + a.handle; }).join(", ");
    root.appendChild(err);
  }

  function renderStaleNotice(root, staleFeeds) {
    if (!staleFeeds || !staleFeeds.length) return;
    var note = document.createElement("div");
    note.className = "x-feed-stale";
    note.textContent =
      "Showing older cached posts for: " +
      staleFeeds.map(function (a) { return "@" + a.handle; }).join(", ") +
      " (live fetch unavailable)";
    root.appendChild(note);
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

  function readHashSelection(accounts) {
    var hash = decodeURIComponent(window.location.hash.slice(1) || "");
    if (!hash) return null;
    if (hash.toLowerCase() === "all") return { mode: ALL_MODE };
    var found = accounts.filter(function (a) {
      return a.handle.toLowerCase() === hash.toLowerCase();
    })[0];
    return found ? { mode: "account", handle: found.handle } : null;
  }

  function init() {
    var listRoot = document.getElementById("xAccountList");
    var pane = document.getElementById("xTimelinePane");
    var paneLabel = document.getElementById("xTimelineLabel");
    var paneLink = document.getElementById("xTimelineLink");
    if (!listRoot || !pane) return;

    var accounts = allAccounts();
    var hashSelection = readHashSelection(accounts);
    var lastHandle = readLastHandle();
    var validLast = accounts.some(function (a) { return a.handle === lastHandle; });
    var lastMode = readLastMode();
    var cached = readCachedFeed();
    var state = {
      mode: hashSelection ? hashSelection.mode : lastMode === ALL_MODE ? ALL_MODE : "account",
      handle: hashSelection && hashSelection.mode === "account"
        ? hashSelection.handle
        : validLast ? lastHandle : accounts[0].handle,
      feedData: cached || { posts: [], failedFeeds: [] },
      loaded: !!cached,
    };

    function renderPane() {
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
      renderPane();
      refreshList();
    }

    refreshList();
    if (state.mode === ALL_MODE) selectAll(); else selectHandle(state.handle);

    window.addEventListener("hashchange", function () {
      var next = readHashSelection(accounts);
      if (!next) return;
      if (next.mode === ALL_MODE) selectAll();
      else selectHandle(next.handle);
    });

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
