(function () {
  "use strict";

  if (window.AppSettings) {
    window.AppSettings.applyTheme(window.AppSettings.getTheme());
  }

  var workspace = [
    { href: "/", dot: true, label: "Overview" },
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
    { href: "https://www.youtube.com/", icon: "&#9654;&#65039;", label: "YouTube" },
    { href: "https://x.com/", icon: "&#120143;", label: "X" },
    {
      href: "https://trading-strategy-production-1b41.up.railway.app/",
      icon: "&#129504;",
      label: "Decision Engine",
      featured: "decision",
    },
    {
      href: "https://traderclaw-production.up.railway.app/",
      icon: "&#129408;",
      label: "TraderClaw",
      featured: "traderclaw",
    },
    {
      href: "https://www.worldmonitor.app/dashboard?lat=168.3787&lon=-46.4780&zoom=2.50&view=america&timeRange=48h&layers=conflicts%2Chotspots%2Csanctions%2Cweather%2Coutages%2Cnatural%2CiranAttacks",
      icon: "&#127758;",
      label: "World Monitor",
    },
    { href: "/market-intel.html", icon: "&#128200;", label: "Market Intel Links" },
    { href: "/reporter.html", icon: "&#128240;", label: "Reporter" },
    { href: "https://earth-watch-production-e3c6.up.railway.app/", icon: "&#127757;", label: "Earth Watch" },
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

  function dropdown(item, mode, instance) {
    var prefix = mode === "command" ? "cmd-" : "";
    var id = prefix + "apps-menu-" + instance;
    var children = item.children.map(function (child) {
      return (
        '<a class="' + prefix + 'nav-item ' + prefix + 'nav-subitem" href="' + child.href +
        '" target="_blank" rel="noopener"><span class="' + prefix + 'nav-icon" aria-hidden="true">' +
        child.icon + '</span><span class="' + prefix + 'nav-text">' + child.label +
        '</span><span class="' + prefix + 'nav-external" aria-hidden="true">&#8599;</span></a>'
      );
    }).join("");

    return (
      '<div class="' + prefix + 'nav-dropdown">' +
      '<button class="' + prefix + 'nav-item ' + prefix + 'nav-dropdown-toggle" type="button" aria-expanded="false" aria-controls="' + id + '">' +
      '<span class="' + prefix + 'nav-icon" aria-hidden="true">' + item.icon + '</span>' +
      '<span class="' + prefix + 'nav-text">' + item.label + '</span>' +
      '<span class="' + prefix + 'nav-caret" aria-hidden="true">&#9656;</span></button>' +
      '<div class="' + prefix + 'nav-dropdown-menu" id="' + id + '">' + children + "</div></div>"
    );
  }

  function navigationHtml(mode, instance) {
    var prefix = mode === "command" ? "cmd-" : "";
    var workspaceHtml = workspace.map(function (item) {
      return item.children ? dropdown(item, mode, instance) : navItem(item, mode);
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
