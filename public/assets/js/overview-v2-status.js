/* Overview v2 — top-of-page status.
 *
 *   News desks     the four desk briefings (phone upload or Reporter run,
 *                  whichever is newer), in a tab that collapses to one line
 *                  showing when the last report ran.
 *   System status  a count and the last run / update time for AI Presets,
 *                  My Layouts, Active Trades and Potential Buys.
 *   Market Matrix  the four Market Matrix panels as sparklines, in the same
 *                  symbols and timeframes as the full page's saved workspace.
 *
 * Read-only: every request is a GET the full pages already make. A failed
 * source says so on its own tile; nothing is shown as 0 when it is unknown.
 */
(function () {
  "use strict";

  var esc = window.ScreenerUI.escapeHtml;
  var freshness = window.BriefingFreshness;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var NEWS_OPEN_KEY = "overviewV2.newsOpen";

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function time(value) {
    var at = typeof value === "number" ? value : value ? new Date(value).getTime() : NaN;
    return isFinite(at) ? at : null;
  }

  function ago(at) {
    var ms = Date.now() - at;
    if (ms < 60 * 1000) return "just now";
    var mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 48) return hours + "h ago";
    return Math.floor(hours / 24) + "d " + (hours % 24) + "h ago";
  }

  function stamp(at) {
    return new Date(at).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
  }

  function timeTag(at, cls) {
    var iso = new Date(at).toISOString();
    return '<time class="' + cls + '" datetime="' + iso + '" title="' + esc(stamp(at)) + '">' + esc(stamp(at)) + "</time>";
  }

  // ── News desks ─────────────────────────────────────────────
  var DESKS = [
    { key: "geopolitics", section: "geopolitics", label: "Geopolitics", icon: "🌐" },
    { key: "economics", section: "economics", label: "Economics", icon: "🏛️" },
    { key: "stocks", section: "markets", label: "Stocks", icon: "📈" },
    { key: "crypto", section: "crypto", label: "Crypto", icon: "₿" },
  ];
  var newsEl = document.getElementById("ov2-news");
  var desksEl = document.getElementById("ov2-desks");
  var newsLastEl = document.getElementById("ov2-news-last");
  var deskRuns = null;

  function renderDesks() {
    if (!deskRuns) return;
    var newest = null;
    desksEl.innerHTML = deskRuns.map(function (desk) {
      var at = desk.at;
      if (at && (!newest || at > newest.at)) newest = desk;
      var iso = at ? new Date(at).toISOString() : null;
      var tone = freshness.state(iso);
      var meta = tone === "empty" ? "No run recorded" : (desk.reporter ? "⚡ " : "📱 ") + ago(at) + " · " + freshness.label(iso);
      return '<a class="ov2-desk ' + tone + '" href="/briefings/' + desk.key + '">' +
        '<span class="ov2-desk-name">' + esc(desk.icon + " " + desk.label) + "</span>" +
        '<span class="ov2-desk-meta">' + esc(meta) + "</span>" +
        (at ? timeTag(at, "ov2-desk-time") : '<span class="ov2-desk-time">' + (desk.failed ? "Source unavailable" : "&nbsp;") + "</span>") +
        "</a>";
    }).join("");
    newsLastEl.innerHTML = newest
      ? "Last report " + esc(ago(newest.at)) + " · " + esc(newest.label) + " · " + timeTag(newest.at, "ov2-news-stamp")
      : "No report recorded";
  }

  function loadDesks() {
    var phone = getJson("/api/phone-briefings").then(function (data) { return data.categories || []; }, function () { return null; });
    var reporter = Promise.all(DESKS.map(function (desk) {
      return getJson("/api/daily-report/generations?section=" + desk.section + "&limit=1")
        .then(function (data) { return (data.generations || [])[0] || null; }, function () { return undefined; });
    }));
    return Promise.all([phone, reporter]).then(function (results) {
      var categories = results[0] || [];
      deskRuns = DESKS.map(function (desk, i) {
        var cat = categories.filter(function (c) { return c.key === desk.key; })[0];
        var phoneAt = time(cat && cat.latest && cat.latest.receivedAt);
        var run = results[1][i];
        var runAt = time(run && run.generatedAt);
        var useReporter = runAt !== null && (phoneAt === null || runAt > phoneAt);
        return {
          key: desk.key, label: desk.label, icon: desk.icon,
          at: useReporter ? runAt : phoneAt,
          reporter: useReporter,
          failed: results[0] === null && run === undefined,
        };
      });
      renderDesks();
    });
  }

  try { if (localStorage.getItem(NEWS_OPEN_KEY) === "0") newsEl.open = false; } catch (e) { /* private mode */ }
  newsEl.addEventListener("toggle", function () {
    try { localStorage.setItem(NEWS_OPEN_KEY, newsEl.open ? "1" : "0"); } catch (e) { /* private mode */ }
  });

  // ── System status ──────────────────────────────────────────
  var systemEl = document.getElementById("ov2-system");
  var SYSTEMS = [
    {
      id: "presets", label: "Presets", href: "/ai-analysis.html", verb: "Last run",
      load: function () {
        return getJson("/api/ai-analysis/log").then(function (data) { return logSummary(data.entries); });
      },
    },
    {
      id: "layouts", label: "My Layouts", href: "/layout-analysis.html", verb: "Last run",
      load: function () {
        return getJson("/api/layout-analysis/log").then(function (data) { return logSummary(data.entries); });
      },
    },
    {
      id: "trades", label: "Active Trades", href: "/pattern-scanner-trades.html", verb: "Last updated",
      load: function () {
        return getJson("/api/watchlist").then(function (data) {
          var items = data.items || [];
          return { count: items.length, unit: items.length === 1 ? "pair tracked" : "pairs tracked", at: newestOf(items, "addedAt") };
        });
      },
    },
    {
      id: "buys", label: "Potential Buys", href: "/potential-buys.html", verb: "Last updated",
      load: function () {
        return getJson("/api/potential-buys/summary").then(function (data) {
          return {
            count: data.total, unit: "saved",
            extra: typeof data.addedLast24h === "number" ? "+" + data.addedLast24h + " in 24h" : "",
            at: time(data.newestAt),
          };
        });
      },
    },
  ];

  function newestOf(items, field) {
    var best = null;
    (items || []).forEach(function (item) {
      var at = time(item && item[field]);
      if (at !== null && (best === null || at > best)) best = at;
    });
    return best;
  }

  // The generation logs keep the latest 200 runs; the count is runs in the
  // last 24 hours, the time is the newest run.
  function logSummary(entries) {
    var since = Date.now() - DAY_MS;
    var count = (entries || []).filter(function (e) { var at = time(e && e.generatedAt); return at !== null && at >= since; }).length;
    return { count: count, unit: count === 1 ? "run in 24h" : "runs in 24h", at: newestOf(entries, "generatedAt") };
  }

  function systemShell(sys) {
    return '<a class="ov2-sys" id="ov2-sys-' + sys.id + '" href="' + sys.href + '">' +
      '<span class="ov2-sys-label">' + esc(sys.label) + "</span>" +
      '<span class="ov2-sys-count">…</span><span class="ov2-sys-when">Loading…</span></a>';
  }

  function loadSystem(sys) {
    var tile = document.getElementById("ov2-sys-" + sys.id);
    var countEl = tile.querySelector(".ov2-sys-count");
    var whenEl = tile.querySelector(".ov2-sys-when");
    return sys.load().then(function (result) {
      var known = typeof result.count === "number" && isFinite(result.count);
      countEl.innerHTML = known
        ? "<strong>" + esc(result.count) + "</strong> " + esc(result.unit) + (result.extra ? ' <em>' + esc(result.extra) + "</em>" : "")
        : "<strong>—</strong>";
      whenEl.className = "ov2-sys-when" + (result.at ? "" : " ov2-flat");
      whenEl.innerHTML = result.at
        ? esc(sys.verb + " " + ago(result.at)) + " · " + timeTag(result.at, "ov2-sys-stamp")
        : esc(sys.verb === "Last run" ? "No run recorded" : "Nothing saved yet");
    }, function (err) {
      countEl.innerHTML = "<strong>—</strong>";
      whenEl.className = "ov2-sys-when ov2-warn";
      whenEl.textContent = "Unavailable (" + err.message + ")";
    });
  }

  systemEl.innerHTML = SYSTEMS.map(systemShell).join("");

  // ── Market Matrix ──────────────────────────────────────────
  var matrixEl = document.getElementById("ov2-matrix");
  var matrixMetaEl = document.getElementById("ov2-matrix-meta");
  var MATRIX_DEFAULTS = [
    { symbol: "TOTAL", tf: "1h" }, { symbol: "DXY", tf: "1h" }, { symbol: "BTC", tf: "1h" }, { symbol: "USDT.D", tf: "1h" },
  ];

  // Same panels as the Market Matrix page: its saved workspace when there is
  // one in this browser, the page defaults otherwise. The server rejects an
  // unknown symbol or timeframe, and that panel says so.
  function matrixPanels() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem("marketMatrixWorkspace.v1") || "null"); } catch (e) { saved = null; }
    return MATRIX_DEFAULTS.map(function (def, i) {
      var p = saved && Array.isArray(saved.panels) ? saved.panels[i] || {} : {};
      return {
        symbol: typeof p.symbol === "string" && p.symbol ? p.symbol : def.symbol,
        tf: typeof p.tf === "string" && p.tf ? p.tf : def.tf,
      };
    });
  }

  function compactUsd(value) {
    var abs = Math.abs(value);
    if (abs >= 1e12) return "$" + (value / 1e12).toFixed(3) + "T";
    if (abs >= 1e9) return "$" + (value / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (value / 1e6).toFixed(2) + "M";
    return "$" + Math.round(value).toLocaleString();
  }

  function formatValue(value, format) {
    if (typeof value !== "number" || !isFinite(value)) return "—";
    if (format === "usd-compact") return compactUsd(value);
    if (format === "percent") return value.toFixed(3) + "%";
    var abs = Math.abs(value);
    var digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 5;
    return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function sparkline(candles) {
    var closes = candles.slice(-96).map(function (c) { return c.close; }).filter(function (v) { return typeof v === "number" && isFinite(v); });
    if (closes.length < 2) return "";
    var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    var span = max - min || 1;
    var w = 200, h = 56;
    var points = closes.map(function (v, i) {
      return (i / (closes.length - 1) * w).toFixed(1) + "," + (h - 3 - (v - min) / span * (h - 6)).toFixed(1);
    }).join(" ");
    var tone = closes[closes.length - 1] >= closes[0] ? "ov2-spark-up" : "ov2-spark-down";
    return '<svg class="ov2-spark ' + tone + '" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + points + '" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" /></svg>';
  }

  function matrixPanel(panel, data, err) {
    var head = '<div class="ov2-mm-head"><strong>' + esc(data ? data.symbol.label : panel.symbol) + "</strong><span>" +
      esc(data ? data.timeframeLabel : panel.tf) + "</span></div>";
    if (err || !data || !data.available) {
      return '<div class="ov2-mm-panel">' + head + '<p class="ov2-mm-empty ov2-warn">' +
        esc(err ? err.message : (data && data.error) || "Unavailable") + "</p></div>";
    }
    var change = data.changePct;
    var changeTxt = typeof change === "number" && isFinite(change) ? (change > 0 ? "+" : "") + change.toFixed(2) + "%" : "—";
    var tone = !(typeof change === "number") || change === 0 ? "ov2-flat" : change > 0 ? "ov2-bull" : "ov2-bear";
    return '<div class="ov2-mm-panel" title="' + esc(data.symbol.name + " · " + data.source.label) + '">' + head +
      '<div class="ov2-mm-value"><strong>' + esc(formatValue(data.value, data.symbol.format)) + '</strong><span class="' + tone + '">' +
      esc(changeTxt) + "</span></div>" + sparkline(data.candles || []) + "</div>";
  }

  function loadMatrix() {
    var panels = matrixPanels();
    return Promise.all(panels.map(function (panel) {
      return getJson("/api/market-matrix/chart?symbol=" + encodeURIComponent(panel.symbol) + "&tf=" + encodeURIComponent(panel.tf))
        .then(function (data) { return matrixPanel(panel, data, null); }, function (err) { return matrixPanel(panel, null, err); });
    })).then(function (html) {
      matrixEl.innerHTML = html.join("");
      matrixMetaEl.textContent = "Received " + new Date().toLocaleTimeString();
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────
  function loadAll() {
    loadDesks();
    SYSTEMS.forEach(loadSystem);
    loadMatrix();
  }

  document.getElementById("ov2-refresh").addEventListener("click", loadAll);
  loadAll();
  // Ages tick without refetching; data reloads every five minutes while visible.
  setInterval(renderDesks, 60 * 1000);
  setInterval(function () { if (!document.hidden) loadAll(); }, 5 * 60 * 1000);
})();
