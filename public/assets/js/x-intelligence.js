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

  function groupLabel(key) {
    var match = GROUPS.filter(function (g) { return g.key === key; })[0];
    return match ? match.label : key;
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

  function renderList(root, activeFilter, activeHandle, onSelect) {
    root.innerHTML = "";
    var groups = activeFilter === "all"
      ? GROUPS
      : GROUPS.filter(function (g) { return g.key === activeFilter; });

    groups.forEach(function (group) {
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

  function init() {
    var listRoot = document.getElementById("xAccountList");
    var pane = document.getElementById("xTimelinePane");
    var paneLabel = document.getElementById("xTimelineLabel");
    var paneLink = document.getElementById("xTimelineLink");
    var filters = document.querySelectorAll(".x-filter");
    if (!listRoot || !pane) return;

    var accounts = allAccounts();
    var lastHandle = readLastHandle();
    var validLast = accounts.some(function (a) { return a.handle === lastHandle; });
    var state = {
      filter: "all",
      handle: validLast ? lastHandle : accounts[0].handle,
    };

    function selectHandle(handle) {
      state.handle = handle;
      writeLastHandle(handle);
      renderTimeline(pane, handle);
      if (paneLabel) paneLabel.textContent = "@" + handle;
      if (paneLink) paneLink.href = "https://x.com/" + handle;
      renderList(listRoot, state.filter, state.handle, selectHandle);
    }

    filters.forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filter = btn.dataset.filter || "all";
        filters.forEach(function (b) { b.classList.toggle("active", b === btn); });
        renderList(listRoot, state.filter, state.handle, selectHandle);
      });
    });

    renderList(listRoot, state.filter, state.handle, selectHandle);
    selectHandle(state.handle);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
