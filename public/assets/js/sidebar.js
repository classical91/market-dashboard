(function () {
  "use strict";

  if (window.AppSettings) {
    window.AppSettings.applyTheme(window.AppSettings.getTheme());
  }

  function isAlphaReviewMode() {
    try {
      return new URLSearchParams(window.location.search || "").get("view") === "alpha";
    } catch {
      return false;
    }
  }

  if (isAlphaReviewMode()) {
    document.documentElement.classList.add("alpha-review-mode");
  }

  var accountState = null;

  var workspace = [
    { href: "/terminal-suite.html", label: "Terminal Suite" },
    {
      // The label itself opens Overview; the caret beside it expands the
      // widget jump links and the Heatmaps page.
      href: "/",
      label: "Overview",
      children: [
        {
          label: "Widgets",
          children: [
            { href: "/#ticker", label: "Ticker" },
            { href: "/#kpiGrid", label: "Key Indicators" },
            { href: "/#onchain-intelligence", label: "On-Chain Intelligence" },
            { href: "/#market-pulse", label: "Market Pulse" },
            { href: "/#risk-meter", label: "Risk Meter" },
            { href: "/#alerts", label: "Alerts" },
            { href: "/#ovh-market-overview", label: "TV Market Overview" },
            { href: "/#ovh-technical-analysis", label: "Technical Analysis" },
            { href: "/#ovh-derivatives", label: "Derivatives & Positioning" },
            { href: "/#ovh-liquidity", label: "Liquidity & Volatility" },
          ],
        },
        {
          href: "/heatmaps.html",
          label: "Heatmaps",
          children: [
            { href: "/heatmaps.html#market-heatmap", label: "Market Heatmap" },
            { href: "/heatmaps.html#crypto-heatmap", label: "Crypto Heatmap" },
            { href: "/heatmaps.html#stock-heatmap", label: "Stock Heatmap" },
            { href: "/heatmaps.html#forex-heatmap", label: "Forex Heatmap" },
          ],
        },
      ],
    },
    {
      label: "TradeHunter",
      children: [
        // Each screener answers one question — direction, location, structure
        // — and My Trades is where the three are read together. Future
        // screeners (Derivatives, Volatility, Relative Strength) join this
        // group rather than the level above it.
        {
          label: "Screeners",
          children: [
            { href: "/directional-bias.html", label: "Directional Bias" },
            { href: "/local-extremes.html", label: "Local Extremes" },
            { href: "/pattern-scanner.html", label: "Pattern Scanner" },
            // The two Open Interest pages sit side by side: crypto perps
            // (live, per coin) and CFTC futures across asset classes (weekly).
            { href: "/open-interest.html", label: "Crypto Open Interest" },
            { href: "/cross-market-oi.html", label: "Cross-Market Open Interest" },
            // Momentum across markets and timeframes at once: RSI 14 on
            // 1W / 1D / 4H / 1H for crypto, indices, commodities and dominance.
            { href: "/rsi-matrix.html", label: "RSI Matrix" },
          ],
        },
        { href: "/pattern-scanner-trades.html", label: "My Trades" },
        { href: "/pattern-scanner-stats.html", label: "Track Record" },
        {
          href: "https://trading-strategy-production-1b41.up.railway.app/",
          label: "Decision Engine",
        },
      ],
    },
    {
      label: "AI Analysis",
      children: [
        { href: "/ai-analysis.html", label: "Presets" },
        { href: "/layout-analysis.html", label: "My Layouts" },
        { href: "/trading-lab.html", label: "Trading Lab Backtest" },
        { href: "/signal-diagnostics.html", label: "Signal Diagnostics" },
      ],
    },
    {
      label: "Reporter",
      children: [
        // The Reporter Room itself was reachable only by typing the URL: the
        // three entries below are single-desk pages that deliberately strip
        // the News Intelligence tab, Master News, the desk statuses and the
        // newsroom controls, so none of them can reach the newsroom.
        { href: "/reporter.html", label: "Reporter Room" },
        {
          // Moved out of Overview: these are newsroom inputs, and the Overview
          // page was carrying the same feeds the Reporter actually needs.
          label: "News Intelligence",
          children: [
            { href: "/reporter.html#economic-calendar", label: "Economic Calendar" },
            { href: "/reporter.html#top-stories", label: "Top Stories" },
            { href: "/reporter.html#news-pulse", label: "News Pulse" },
            { href: "/reporter.html#macro-calendar", label: "Macro Calendar" },
            { href: "/reporter.html#calendars-tools", label: "Calendars & Tools" },
          ],
        },
        { href: "/emerging-markets.html", label: "Emerging Markets" },
        { href: "/economics-top-10.html", label: "Economics Top 10" },
        { href: "/markets-top-10.html", label: "Markets Top 10" },
      ],
    },
    {
      label: "Market Intel Links",
      children: [
        { href: "/market-intel.html", label: "Market Intel Home" },
        {
          label: "Market Intel",
          children: [
            { href: "/market-intel.html#cross-asset-overview", label: "Cross-Asset Overview" },
            { href: "/market-intel.html#macro-indicators", label: "Macro Indicators" },
          ],
        },
        {
          label: "Crypto",
          children: [
            { href: "/crypto.html#crypto-research", label: "Bitcoin Research" },
            { href: "/crypto.html#alt-research", label: "Alt Research" },
            { href: "/crypto.html#interactive-dashboards", label: "Interactive Dashboards" },
            { href: "/crypto.html#tradingview-tickers", label: "TradingView Tickers" },
            { href: "/crypto.html#etf-flows", label: "ETF Flows" },
            { href: "/crypto.html#long-vs-shorts", label: "Long vs Shorts" },
            { href: "/crypto.html#market-overview-dashboard", label: "Market Volumes" },
            { href: "/crypto.html#news", label: "Crypto News" },
            { href: "/crypto.html#market-cap", label: "Market Cap" },
            { href: "/crypto.html#market-trends", label: "Market Trends" },
            { href: "/crypto.html#rankings", label: "Rankings" },
            { href: "/crypto.html#liquidations", label: "Liquidations" },
            { href: "/crypto.html#open-interest", label: "Open-Interest Links" },
            { href: "/crypto.html#heatmaps", label: "Heatmaps & Momentum" },
            {
              label: "On-Chain Analytics",
              children: [
                { href: "/on-chain.html", label: "On-Chain Hub" },
                { href: "/on-chain.html#platforms", label: "Platforms" },
                { href: "/on-chain.html#exchange-flows", label: "Exchange Flows" },
                { href: "/on-chain.html#network-activity", label: "Network Activity" },
                { href: "/on-chain.html#derivatives", label: "Derivatives" },
                { href: "/on-chain.html#cycle-indicators", label: "Cycle Indicators" },
                { href: "/on-chain.html#whale-tracking", label: "Whale Tracking" },
                { href: "/on-chain.html#stablecoin-flows", label: "Stablecoin Flows" },
                { href: "/on-chain.html#defi", label: "DeFi" },
              ],
            },
            { href: "/crypto.html#cmc-indicators", label: "Indicators" },
            { href: "/crypto.html#qualitative", label: "Qual. Analysis" },
          ],
        },
        {
          label: "Traditional",
          children: [
            { href: "/traditional.html#cnbc", label: "CNBC" },
            { href: "/traditional.html#news-analysis", label: "News & Analysis" },
            { href: "/traditional.html#market-data", label: "Market Data" },
            { href: "/traditional.html#macro", label: "Macro" },
            { href: "/traditional.html#global", label: "Global" },
            { href: "/traditional.html#commodities", label: "Commodities" },
          ],
        },
      ],
    },
    {
      label: "YouTube Intelligence",
      featured: "youtube",
      children: [
        { href: "/youtube-v2.html", label: "YouTube Intelligence" },
        { href: "https://www.youtube.com/", label: "YouTube.com" },
        {
          href: "https://yt-summarizer-production-4521.up.railway.app/",
          label: "YouTube Summarizer",
        },
      ],
    },
    {
      label: "X Intelligence",
      featured: "x",
      children: [
        { href: "https://x.com/", label: "Open X.com" },
        { href: "/x-intelligence.html", label: "X Intelligence" },
        { href: "/x-search.html", label: "Search X" },
      ],
    },
  ];

  var other = [
    {
      href: "https://www.worldmonitor.app/dashboard?lat=168.3787&lon=-46.4780&zoom=2.50&view=america&timeRange=48h&layers=conflicts%2Chotspots%2Csanctions%2Cweather%2Coutages%2Cnatural%2CiranAttacks",
      label: "Open WorldMonitor.com",
    },
  ];

  var tools = [
    {
      href: "https://t.me/tesr56788",
      label: "Trader Lab Telegram",
    },
    {
      href: "https://market-dashboard-production-b2f4.up.railway.app/bot-commands.html",
      label: "Bot Commands",
      newTab: false,
    },
    { href: "/indicators.html", label: "Indicators Glossary" },
    { href: "/settings.html", label: "Settings" },
  ];

  function currentPath() {
    var path = window.location.pathname || "/";
    return path === "/index.html" ? "/" : path;
  }

  function isActive(href) {
    if (!href || /^https?:\/\//.test(href)) return false;

    var parts = href.split("#");
    var path = parts[0] || "/";
    var hash = parts[1] ? "#" + parts[1] : "";
    var current = currentPath();
    var currentHash = window.location.hash;

    if (current !== path) return false;
    if (hash) return currentHash === hash;

    return true;
  }

  function alphaReviewPath(href) {
    if (!href || /^https?:\/\//.test(href)) return "";
    return (href.split("#")[0] || "/").split("?")[0] || "/";
  }

  function isAlphaAvailable(href) {
    var path = alphaReviewPath(href);
    // The Alpha Team review surface: the two screener pages the old Signal
    // Screener split into, the pattern scanner, and diagnostics. Everything
    // else renders as a disabled BETA item in review mode.
    return path === "/directional-bias.html"
      || path === "/local-extremes.html"
      || path === "/signal-screener.html"
      || path === "/pattern-scanner.html"
      || path === "/signal-diagnostics.html";
  }

  function alphaHref(href) {
    if (!isAlphaReviewMode() || !isAlphaAvailable(href)) return href;
    var parts = href.split("#");
    var path = parts[0].split("?")[0];
    var hash = parts[1] ? "#" + parts[1] : "";
    return path + "?view=alpha" + hash;
  }

  function betaNavItem(item, mode, subitem) {
    var prefix = mode === "command" ? "cmd-" : "";
    return (
      '<span class="' + prefix + "nav-item " + (subitem ? prefix + "nav-subitem " : "") + prefix + 'nav-item--beta" aria-disabled="true">' +
      '<span class="' + prefix + 'nav-text">' + item.label + '</span>' +
      '<span class="' + prefix + 'nav-beta-pill">BETA</span></span>'
    );
  }

  function dropdownKey(item, mode) {
    return "sidebar_dropdown_" + mode + "_" + String(item.label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function getStoredDropdownState(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function setStoredDropdownState(key, open) {
    try { localStorage.setItem(key, open ? "open" : "closed"); } catch {}
  }

  function hasActiveDescendant(item) {
    if (isActive(item.href)) return true;
    return !!(item.children && item.children.some(hasActiveDescendant));
  }

  function navItem(item, mode) {
    var prefix = mode === "command" ? "cmd-" : "";
    if (isAlphaReviewMode() && !isAlphaAvailable(item.href)) return betaNavItem(item, mode, false);
    var active = isActive(item.href);
    var external = /^https?:\/\//.test(item.href);
    var newTab = external && item.newTab !== false;
    var featuredClass = item.featured
      ? " " + prefix + "nav-item--featured " + prefix + "nav-item--" + item.featured
      : "";
    var icon = item.dot ? '<span class="' + prefix + 'nav-dot"></span>' : "";
    var href = alphaHref(item.href);
    return (
      '<a class="' + prefix + "nav-item" + featuredClass + (active ? " active" : "") + '" href="' + href +
      '" data-nav-href="' + item.href + '"' + (href !== item.href ? ' data-alpha-href="' + href + '"' : "") +
      (newTab ? ' target="_blank" rel="noopener"' : "") +
      (active ? ' aria-current="page"' : "") + ">" +
      icon + '<span class="' + prefix + 'nav-text">' + item.label + "</span></a>"
    );
  }

  function subNavItem(item, mode) {
    var prefix = mode === "command" ? "cmd-" : "";
    if (isAlphaReviewMode() && !isAlphaAvailable(item.href)) return betaNavItem(item, mode, true);
    var active = isActive(item.href);
    var external = /^https?:\/\//.test(item.href);
    var newTab = external && item.newTab !== false;
    var href = alphaHref(item.href);
    return (
      '<a class="' + prefix + 'nav-item ' + prefix + 'nav-subitem' + (active ? " active" : "") +
      '" href="' + href + '" data-nav-href="' + item.href + '"' +
      (newTab ? ' target="_blank" rel="noopener"' : "") +
      (active ? ' aria-current="page"' : "") +
      '><span class="' + prefix + 'nav-text">' + item.label +
      '</span>' + (external ? '<span class="' + prefix + 'nav-external" aria-hidden="true">&#8599;</span>' : "") +
      "</a>"
    );
  }

  function accountHtml(mode) {
    var prefix = mode === "command" ? "cmd-" : "";
    if (accountState && accountState.authenticated) {
      var identifier = accountState.identifier || (accountState.role === "alpha" ? "Alpha Team" : "Owner account");
      return (
        '<section class="' + prefix + 'account" aria-label="Account">' +
        '<div class="' + prefix + 'account-label">Account</div>' +
        '<div class="' + prefix + 'account-id">' + identifier + '</div>' +
        '<form action="/auth/logout" method="post" class="' + prefix + 'account-form">' +
        '<button type="submit" class="' + prefix + 'account-action">Logout</button></form></section>'
      );
    }
    return (
      '<section class="' + prefix + 'account" aria-label="Account">' +
      '<div class="' + prefix + 'account-label">Account</div>' +
      '<a class="' + prefix + 'account-action" href="/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search) + '">Login</a></section>'
    );
  }

  function dropdown(item, mode, instance, nested) {
    var prefix = mode === "command" ? "cmd-" : "";
    var id = prefix + "apps-menu-" + instance;
    var storageKey = dropdownKey(item, mode);
    var active = isActive(item.href) || item.children.some(hasActiveDescendant);
    var featuredClass = item.featured
      ? " " + prefix + "nav-item--featured " + prefix + "nav-item--" + item.featured
      : "";
    var storedState = getStoredDropdownState(storageKey);
    var open = storedState ? storedState === "open" : active;
    var children = item.children.map(function (child, index) {
      return child.children
        ? dropdown(child, mode, instance + "-" + index, true)
        : subNavItem(child, mode);
    }).join("");

    var caret = '<span class="' + prefix + 'nav-caret" aria-hidden="true">&#9656;</span>';
    var menu = '<div class="' + prefix + 'nav-dropdown-menu" id="' + id + '">' + children + "</div></div>";
    var rootOpen =
      '<div class="' + prefix + 'nav-dropdown' + (nested ? " " + prefix + "nav-subdropdown" : "") + (open ? " open" : "") + '" data-dropdown-key="' + storageKey + '">';

    // A dropdown with its own page splits in two: the label is a link that
    // opens the page, and only the caret expands the menu.
    if (item.href) {
      var selfActive = isActive(item.href);
      return (
        rootOpen +
        '<div class="' + prefix + 'nav-item ' + (nested ? prefix + "nav-subitem " : "") + prefix + 'nav-split' + featuredClass + (active ? " active" : "") + '">' +
        '<a class="' + prefix + 'nav-split-link" href="' + alphaHref(item.href) + '" data-nav-href="' + item.href + '"' +
        (selfActive ? ' aria-current="page"' : "") + '><span class="' + prefix + 'nav-text">' + item.label + '</span></a>' +
        '<button class="' + prefix + 'nav-dropdown-toggle ' + prefix + 'nav-split-toggle" type="button" aria-expanded="' + (open ? "true" : "false") +
        '" aria-controls="' + id + '" aria-label="Show ' + item.label + ' sections">' + caret + '</button></div>' +
        menu
      );
    }

    return (
      rootOpen +
      '<button class="' + prefix + 'nav-item ' + (nested ? prefix + "nav-subitem " : "") + prefix + 'nav-dropdown-toggle' + featuredClass + (active ? " active" : "") +
      '" type="button" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="' + id + '">' +
      '<span class="' + prefix + 'nav-text">' + item.label + '</span>' + caret + '</button>' +
      menu
    );
  }

  function navigationHtml(mode, instance) {
    var prefix = mode === "command" ? "cmd-" : "";
    var workspaceHtml = workspace.map(function (item, index) {
      return item.children ? dropdown(item, mode, instance + "-" + index) : navItem(item, mode);
    }).join("");
    var otherHtml = other.map(function (item, index) {
      return item.children ? dropdown(item, mode, instance + "-other-" + index) : navItem(item, mode);
    }).join("");
    var toolsHtml = tools.map(function (item, index) {
      return item.children ? dropdown(item, mode, instance + "-tools-" + index) : navItem(item, mode);
    }).join("");
    return (
      '<a class="' + prefix + 'brand" href="/">' +
      '<div class="' + prefix + 'brand-mark">M</div>' +
      '<div class="' + prefix + 'brand-text"><h1>Market Command</h1><span>Live dashboard system</span></div></a>' +
      accountHtml(mode) + '<div class="' + prefix + 'account-divider"></div>' +
      '<nav class="' + prefix + 'nav-primary" aria-label="Market Command">' + workspaceHtml + '</nav>' +
      '<nav class="' + prefix + 'nav-other" aria-label="Other"><div class="' + prefix + 'nav-label">Other</div>' + otherHtml + '</nav>' +
      '<nav class="' + prefix + 'nav-tools" aria-label="Trading and tools"><div class="' + prefix + 'nav-label">Trading &amp; Tools</div>' + toolsHtml + '</nav>'
    );
  }

  function wireDropdowns(root) {
    root.querySelectorAll(".nav-dropdown-toggle, .cmd-nav-dropdown-toggle").forEach(function (toggle) {
      toggle.addEventListener("click", function () {
        var dropdownRoot = toggle.closest(".nav-dropdown, .cmd-nav-dropdown");
        var open = dropdownRoot.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        setStoredDropdownState(dropdownRoot.getAttribute("data-dropdown-key"), open);
      });
    });
  }

  function fill(root, mode, instance) {
    root.innerHTML = navigationHtml(mode, instance);
    wireDropdowns(root);
    var logoutForm = root.querySelector("." + (mode === "command" ? "cmd-" : "") + "account-form");
    if (logoutForm) {
      logoutForm.addEventListener("submit", function (event) {
        event.preventDefault();
        fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } })
          .then(function (response) {
            if (!response.ok && response.status !== 204) throw new Error("Logout failed");
            accountState = { authenticated: false };
            refreshSidebars();
            window.location.assign("/login?returnTo=" + encodeURIComponent(window.location.pathname + window.location.search));
          })
          .catch(function () { logoutForm.submit(); });
      });
    }
  }

  function refreshSidebars() {
    document.querySelectorAll(".cmd-sidebar").forEach(function (root) { fill(root, "command", "desktop"); });
    document.querySelectorAll(".sidebar").forEach(function (root) { fill(root, "overview", "desktop"); });
    document.querySelectorAll(".cmd-drawer").forEach(function (root) { fill(root, "command", "mobile"); });
    document.querySelectorAll(".mob-drawer").forEach(function (root) { fill(root, "overview", "mobile"); });
  }

  function loadAccount() {
    return fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : { authenticated: false }; })
      .catch(function () { return { authenticated: false }; })
      .then(function (state) {
        accountState = state;
        refreshSidebars();
      });
  }

  function updateActiveStates() {
    document.querySelectorAll("[data-nav-href]").forEach(function (link) {
      var active = isActive(link.getAttribute("data-nav-href"));
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    document.querySelectorAll(".nav-dropdown, .cmd-nav-dropdown").forEach(function (dropdownRoot) {
      var active = !!dropdownRoot.querySelector("[data-nav-href].active");
      var storedState = getStoredDropdownState(dropdownRoot.getAttribute("data-dropdown-key"));
      var open = storedState ? storedState === "open" : active;
      var toggle = dropdownRoot.querySelector(".nav-dropdown-toggle, .cmd-nav-dropdown-toggle");
      var split = dropdownRoot.querySelector(".nav-split, .cmd-nav-split");
      dropdownRoot.classList.toggle("open", open);
      if (split && split.parentElement === dropdownRoot) {
        split.classList.toggle("active", active);
      } else if (toggle) {
        toggle.classList.toggle("active", active);
      }
      if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function addOverlay(id, className, closeDrawer) {
    var overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = className;
    overlay.addEventListener("click", closeDrawer);
    document.body.appendChild(overlay);
    return overlay;
  }

  function buildMobile(main, mode) {
    var command = mode === "command";
    var stem = command ? "cmd" : "mob";
    var bar = document.createElement("div");
    bar.className = command ? "cmd-mobile-bar" : "mob-bar";
    bar.id = stem + (command ? "-mobile-bar" : "-bar");
    bar.innerHTML = '<a class="' + (command ? 'cmd-mobile-brand' : 'mob-brand') + '" href="/"><div class="' +
      (command ? 'cmd-mobile-brand-mark' : 'mob-brand-mark') + '">M</div><span class="' +
      (command ? 'cmd-mobile-brand-name' : 'mob-brand-name') + '">Market Command</span></a>' +
      '<button class="' + (command ? 'cmd-hamburger' : 'mob-ham') + '" type="button" aria-label="Open navigation" aria-controls="' + stem + '-drawer" aria-expanded="false">&#9776;</button>';
    main.insertBefore(bar, main.firstChild);

    var drawer = document.createElement("div");
    drawer.className = stem + "-drawer";
    drawer.id = stem + "-drawer";
    fill(drawer, mode, "mobile");
    document.body.appendChild(drawer);

    var hamburger = bar.querySelector("button");
    var overlay;
    function closeDrawer() {
      drawer.classList.remove("open");
      overlay.classList.remove("open");
      hamburger.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    }
    overlay = addOverlay(stem + "-overlay", stem + "-overlay", closeDrawer);
    hamburger.addEventListener("click", function () {
      drawer.classList.add("open");
      overlay.classList.add("open");
      hamburger.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
    });
    // Tapping an actual nav link (not a dropdown toggle) closes the drawer so
    // in-page section jumps aren't hidden behind it.
    drawer.addEventListener("click", function (event) {
      if (event.target.closest("a[data-nav-href]")) closeDrawer();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeDrawer();
    });
  }

  function build() {
    var commandSidebar = document.querySelector(".cmd-sidebar");
    var overviewSidebar = document.querySelector(".sidebar");
    var commandMain = document.querySelector(".cmd-main");
    var overviewMain = document.querySelector(".main");

    if (commandSidebar) fill(commandSidebar, "command", "desktop");
    if (overviewSidebar) fill(overviewSidebar, "overview", "desktop");
    if (commandMain && !document.getElementById("cmd-mobile-bar")) buildMobile(commandMain, "command");
    if (overviewMain && !document.getElementById("mob-bar")) buildMobile(overviewMain, "overview");
    window.addEventListener("hashchange", updateActiveStates);
    loadAccount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
