(function () {
  "use strict";

  if (window.AppSettings) {
    window.AppSettings.applyTheme(window.AppSettings.getTheme());
  }

  var workspace = [
    { href: "/", dot: true, label: "Overview" },
    {
      label: "Market Intel Links",
      icon: "&#128200;",
      children: [
        { href: "/market-intel.html", icon: "&#128200;", label: "Market Intel Home" },
        {
          label: "Market Intel",
          icon: "&#128202;",
          children: [
            { href: "/market-intel.html#cross-asset-overview", icon: "&#128200;", label: "Cross-Asset Overview" },
            { href: "/market-intel.html#macro-indicators", icon: "&#128202;", label: "Macro Indicators" },
          ],
        },
        {
          label: "Crypto",
          icon: "&#8383;",
          children: [
            { href: "/crypto.html#interactive-dashboards", icon: "&#128225;", label: "Interactive Dashboards" },
            { href: "/crypto.html#crypto-research", icon: "&#8383;", label: "Bitcoin Research" },
            { href: "/crypto.html#alt-research", icon: "&#9672;", label: "Alt Research" },
            { href: "/crypto.html#etf-flows", icon: "&#127974;", label: "ETF Flows" },
            { href: "/crypto.html#market-overview-dashboard", icon: "&#128202;", label: "Market Volumes" },
            { href: "/crypto.html#news", icon: "&#128240;", label: "Crypto News" },
            { href: "/crypto.html#market-cap", icon: "&#128200;", label: "Market Cap" },
            { href: "/crypto.html#market-trends", icon: "&#128293;", label: "Market Trends" },
            { href: "/crypto.html#rankings", icon: "&#127942;", label: "Rankings" },
            { href: "/crypto.html#liquidations", icon: "&#9889;", label: "Liquidations" },
            { href: "/crypto.html#open-interest", icon: "&#128200;", label: "Open-Interest Overview" },
            { href: "/crypto.html#heatmaps", icon: "&#127777;", label: "Heatmaps & Momentum" },
            {
              label: "On-Chain Analytics",
              icon: "&#128279;",
              children: [
                { href: "/on-chain.html",                        icon: "&#128279;", label: "On-Chain Hub" },
                { href: "/on-chain.html#platforms",              icon: "&#128225;", label: "Platforms" },
                { href: "/on-chain.html#exchange-flows",         icon: "&#8652;",   label: "Exchange Flows" },
                { href: "/on-chain.html#network-activity",       icon: "&#128200;", label: "Network Activity" },
                { href: "/on-chain.html#derivatives",            icon: "&#9889;",   label: "Derivatives" },
                { href: "/on-chain.html#cycle-indicators",       icon: "&#128204;", label: "Cycle Indicators" },
                { href: "/on-chain.html#whale-tracking",         icon: "&#128011;", label: "Whale Tracking" },
                { href: "/on-chain.html#stablecoin-flows",       icon: "&#128176;", label: "Stablecoin Flows" },
                { href: "/on-chain.html#defi",                   icon: "&#127963;", label: "DeFi" },
              ],
            },
            { href: "/crypto.html#cmc-indicators", icon: "&#128204;", label: "Indicators" },
            { href: "/crypto.html#qualitative", icon: "&#9998;", label: "Qual. Analysis" },
          ],
        },
        {
          label: "Traditional",
          icon: "&#127974;",
          children: [
            { href: "/traditional.html#cnbc", icon: "&#128250;", label: "CNBC" },
            { href: "/traditional.html#news-analysis", icon: "&#128240;", label: "News & Analysis" },
            { href: "/traditional.html#market-data", icon: "&#128200;", label: "Market Data" },
            { href: "/traditional.html#macro", icon: "&#127757;", label: "Macro" },
            { href: "/traditional.html#global", icon: "&#127760;", label: "Global" },
            { href: "/traditional.html#commodities", icon: "&#9981;", label: "Commodities" },
          ],
        },
      ],
    },
    {
      label: "AI Apps",
      icon: "&#129302;",
      children: [
        {
          href: "https://chatgpt.com/share/6a3ad954-cdf4-83e8-81bb-77966ffefab6",
          icon: "&#129302;",
          label: "AI Market Trader",
        },
        {
          href: "https://commentfarm-production-fc8b.up.railway.app/image-converter",
          icon: "&#128444;",
          label: "Image Converter",
        },
      ],
    },
    { href: "https://www.youtube.com/", icon: "&#9654;&#65039;", label: "Open YouTube.com", featured: "youtube" },
    { href: "https://x.com/", icon: "&#120143;", label: "Open X.com", featured: "x" },
    {
      href: "https://www.worldmonitor.app/dashboard?lat=168.3787&lon=-46.4780&zoom=2.50&view=america&timeRange=48h&layers=conflicts%2Chotspots%2Csanctions%2Cweather%2Coutages%2Cnatural%2CiranAttacks",
      icon: "&#127758;",
      label: "Open WorldMonitor.com",
      featured: "worldmonitor",
    },
    { href: "https://www.tradingview.com/", icon: "&#128200;", label: "Open TradingView.com", featured: "tradingview" },
    {
      href: "https://trading-strategy-production-1b41.up.railway.app/",
      icon: "&#129504;",
      label: "Decision Engine",
    },
    {
      href: "https://traderclaw-production.up.railway.app/",
      icon: "&#129408;",
      label: "Traderclaw Backtest",
    },
    {
      href: "https://t.me/tesr56788",
      icon: "&#9992;&#65039;",
      label: "Trader Lab",
    },
    { href: "/reporter.html", icon: "&#128240;", label: "Reporter" },
    { href: "https://earth-watch-production-e3c6.up.railway.app/", icon: "&#127757;", label: "Earth Watch" },
    { href: "/indicators.html", icon: "&#128218;", label: "Indicators Glossary" },
    { href: "/settings.html", icon: "&#9881;&#65039;", label: "Settings" },
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
    var active = isActive(item.href);
    var external = /^https?:\/\//.test(item.href);
    var featuredClass = item.featured
      ? " " + prefix + "nav-item--featured " + prefix + "nav-item--" + item.featured
      : "";
    var icon = item.dot
      ? '<span class="' + prefix + 'nav-dot"></span>'
      : '<span class="' + prefix + 'nav-icon" aria-hidden="true">' + item.icon + "</span>";
    return (
      '<a class="' + prefix + "nav-item" + featuredClass + (active ? " active" : "") + '" href="' + item.href +
      '" data-nav-href="' + item.href + '"' + (external ? ' target="_blank" rel="noopener"' : "") +
      (active ? ' aria-current="page"' : "") + ">" +
      icon + '<span class="' + prefix + 'nav-text">' + item.label + "</span></a>"
    );
  }

  function subNavItem(item, mode) {
    var prefix = mode === "command" ? "cmd-" : "";
    var active = isActive(item.href);
    var external = /^https?:\/\//.test(item.href);
    return (
      '<a class="' + prefix + 'nav-item ' + prefix + 'nav-subitem' + (active ? " active" : "") +
      '" href="' + item.href + '" data-nav-href="' + item.href + '"' +
      (external ? ' target="_blank" rel="noopener"' : "") +
      (active ? ' aria-current="page"' : "") +
      '><span class="' + prefix + 'nav-icon" aria-hidden="true">' +
      item.icon + '</span><span class="' + prefix + 'nav-text">' + item.label +
      '</span>' + (external ? '<span class="' + prefix + 'nav-external" aria-hidden="true">&#8599;</span>' : "") +
      "</a>"
    );
  }

  function dropdown(item, mode, instance, nested) {
    var prefix = mode === "command" ? "cmd-" : "";
    var id = prefix + "apps-menu-" + instance;
    var storageKey = dropdownKey(item, mode);
    var active = item.children.some(hasActiveDescendant);
    var storedState = getStoredDropdownState(storageKey);
    var open = storedState ? storedState === "open" : active;
    var children = item.children.map(function (child, index) {
      return child.children
        ? dropdown(child, mode, instance + "-" + index, true)
        : subNavItem(child, mode);
    }).join("");

    return (
      '<div class="' + prefix + 'nav-dropdown' + (nested ? " " + prefix + "nav-subdropdown" : "") + (open ? " open" : "") + '" data-dropdown-key="' + storageKey + '">' +
      '<button class="' + prefix + 'nav-item ' + (nested ? prefix + "nav-subitem " : "") + prefix + 'nav-dropdown-toggle' + (active ? " active" : "") +
      '" type="button" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="' + id + '">' +
      '<span class="' + prefix + 'nav-icon" aria-hidden="true">' + item.icon + '</span>' +
      '<span class="' + prefix + 'nav-text">' + item.label + '</span>' +
      '<span class="' + prefix + 'nav-caret" aria-hidden="true">&#9656;</span></button>' +
      '<div class="' + prefix + 'nav-dropdown-menu" id="' + id + '">' + children + "</div></div>"
    );
  }

  function navigationHtml(mode, instance) {
    var prefix = mode === "command" ? "cmd-" : "";
    var workspaceHtml = workspace.map(function (item, index) {
      return item.children ? dropdown(item, mode, instance + "-" + index) : navItem(item, mode);
    }).join("");
    return (
      '<a class="' + prefix + 'brand" href="/">' +
      '<div class="' + prefix + 'brand-mark">M</div>' +
      '<div class="' + prefix + 'brand-text"><h1>Market Command</h1><span>Live dashboard system</span></div></a>' +
      '<div class="' + prefix + 'nav-label">Workspace</div>' + workspaceHtml
    );
  }

  function wireDropdowns(root) {
    root.querySelectorAll(".nav-dropdown-toggle, .cmd-nav-dropdown-toggle").forEach(function (toggle) {
      toggle.addEventListener("click", function () {
        var dropdownRoot = toggle.parentElement;
        var open = dropdownRoot.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        setStoredDropdownState(dropdownRoot.getAttribute("data-dropdown-key"), open);
      });
    });
  }

  function fill(root, mode, instance) {
    root.innerHTML = navigationHtml(mode, instance);
    wireDropdowns(root);
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
      dropdownRoot.classList.toggle("open", open);
      if (toggle) {
        toggle.classList.toggle("active", active);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      }
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
