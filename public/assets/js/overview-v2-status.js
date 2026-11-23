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
      return '<a class="ov2-desk ' + tone + '" href="/briefings/' + desk.key + '" data-news-desk="' + desk.key + '" aria-haspopup="dialog" aria-controls="ov2-news-review">' +
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
          partial: results[0] === null || run === undefined,
          title: useReporter ? null : cat && cat.latest && cat.latest.title,
          text: useReporter ? run.content : cat && cat.latest && cat.latest.text,
          noBriefing: Boolean(useReporter && run.noBriefing),
        };
      });
      renderDesks();
    });
  }

  desksEl.addEventListener("click", function (event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest("[data-news-desk]");
    if (!link || !deskRuns || !window.OverviewNewsReview) return;
    var desk = deskRuns.filter(function (item) { return item.key === link.getAttribute("data-news-desk"); })[0];
    if (desk && window.OverviewNewsReview.open(desk)) event.preventDefault();
  });

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
        return loadGeneration("presets", "/api/ai-analysis", "/api/ai-analysis/log", function (data) {
          gen.presets.presets = data.presets || [];
          gen.presets.intervals = data.availableIntervals || [];
        }).then(logSummary);
      },
    },
    {
      id: "layouts", label: "My Layouts", href: "/layout-analysis.html", verb: "Last run",
      load: function () {
        return loadGeneration("layouts", "/api/layout-analysis", "/api/layout-analysis/log", function (data) {
          gen.layouts.configured = data.layouts || [];
        }).then(logSummary);
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

  // ── Generation widget: My Layouts / Presets ─────────────────
  // Two tabs over the same layout: timeframe tiles on top (latest verdict
  // each), the generation log below. My Layouts shows one tile per saved
  // layout; Presets has a symbol dropdown and one tile per timeframe for
  // that symbol. Selecting a tile filters the log. Shares the status tiles'
  // reads; opening Overview never generates anything.
  var layoutLogEl = document.getElementById("ov2-generation-log");
  var presetsEl = document.getElementById("ov2-presets");
  var filterLabelEl = document.getElementById("ov2-generation-filter");
  var openLinkEl = document.getElementById("ov2-generation-open");
  var subtitleEl = document.getElementById("ov2-generation-subtitle");
  var symbolWrapEl = document.getElementById("ov2-generation-symbol-wrap");
  var symbolEl = document.getElementById("ov2-generation-symbol");
  var GEN_TABS = ["layouts", "presets"];
  var tabEls = GEN_TABS.map(function (name) { return document.getElementById("ov2-gen-tab-" + name); });
  var GEN_TAB_KEY = "overviewV2.generationTab";
  var GEN_SYMBOL_KEY = "overviewV2.generationSymbol";
  var TF_UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };
  var gen = {
    tab: "layouts",
    layouts: { entries: null, configured: [], error: null, active: null },
    presets: { entries: null, presets: [], intervals: [], error: null, symbol: null, active: null },
  };
  try {
    if (localStorage.getItem(GEN_TAB_KEY) === "presets") gen.tab = "presets";
    gen.presets.symbol = localStorage.getItem(GEN_SYMBOL_KEY);
  } catch (e) { /* private mode */ }

  // "BTC 4h" → { symbol: "BTC", tf: "4h", ms }. Labels without a trailing
  // timeframe keep their full text and sort after the ones with one.
  function parseTimeframe(label) {
    var text = String(label || "").trim();
    var match = text.match(/^(.*?)[\s·\-_/]+(\d*)\s*(mo|[smhdwy]|M)$/i) || text.match(/^(.*?)[\s·\-_/]+(\d+)()$/);
    if (!match) return { symbol: text, tf: "", ms: Infinity };
    var unit = match[3] === "M" ? "mo" : (match[3] || "m").toLowerCase();
    var count = match[2] ? parseInt(match[2], 10) : 1;
    var tf = (match[2] || "1") + (unit === "mo" ? "M" : unit === "h" || unit === "m" || unit === "s" ? unit : unit.toUpperCase());
    return { symbol: match[1].trim() || text, tf: tf, ms: count * TF_UNIT_MS[unit] };
  }

  function latestOf(entries) {
    var best = null;
    (entries || []).forEach(function (entry) {
      var at = time(entry.generatedAt);
      if (at !== null && (!best || at > best.at)) best = { at: at, verdict: entry.verdict };
    });
    return best;
  }

  function verdictOf(value) {
    return ["BUY", "SELL", "HOLD"].indexOf(value) !== -1 ? value : "NO CALL";
  }

  function verdictChip(value, extraClass) {
    var verdict = verdictOf(value);
    var tone = verdict === "NO CALL" ? "" : " aia-verdict--" + verdict.toLowerCase();
    return '<span class="aia-verdict ' + extraClass + tone + '">' + verdict + "</span>";
  }

  // My Layouts tiles: configured layouts plus any layout seen in the log
  // (so the strip still works if the layout list fails), shortest first.
  function layoutTiles() {
    var state = gen.layouts;
    var byId = {};
    var order = [];
    function add(id, label) {
      if (!id || byId[id]) return;
      byId[id] = { id: id, label: label || id };
      order.push(id);
    }
    state.configured.forEach(function (layout) { add(layout.id, layout.label); });
    (state.entries || []).forEach(function (entry) { add(entry.layoutId, entry.label); });
    return order.map(function (id, i) {
      var tile = byId[id];
      var parsed = parseTimeframe(tile.label);
      return {
        id: id, label: tile.label, tf: parsed.tf || tile.label, sub: parsed.tf ? parsed.symbol : "", ms: parsed.ms, index: i,
        latest: latestOf((state.entries || []).filter(function (e) { return e.layoutId === id; })),
        href: "/layout-analysis.html?layout=" + encodeURIComponent(id),
      };
    }).sort(function (a, b) { return a.ms - b.ms || a.index - b.index; });
  }

  // Presets symbols: the configured presets, then any other symbol in the log.
  function presetSymbols() {
    var state = gen.presets;
    var seen = {};
    var list = [];
    function add(symbol, label) {
      if (!symbol || seen[symbol]) return;
      seen[symbol] = true;
      list.push({ symbol: symbol, label: label || symbol });
    }
    state.presets.forEach(function (p) { add(p.symbol, p.label); });
    (state.entries || []).forEach(function (e) { add(e.symbol, e.label); });
    return list;
  }

  function presetTiles() {
    var state = gen.presets;
    var symbolEntries = (state.entries || []).filter(function (e) { return e.symbol === state.symbol; });
    var intervals = state.intervals.slice();
    symbolEntries.forEach(function (e) { if (e.interval && intervals.indexOf(e.interval) === -1) intervals.push(e.interval); });
    var label = (presetSymbols().filter(function (s) { return s.symbol === state.symbol; })[0] || {}).label || state.symbol;
    return intervals.map(function (interval, i) {
      return {
        id: interval, label: label + " " + interval, tf: interval, sub: "", ms: parseTimeframe("x " + interval).ms, index: i,
        latest: latestOf(symbolEntries.filter(function (e) { return e.interval === interval; })),
        href: "/ai-analysis.html",
      };
    }).sort(function (a, b) { return a.ms - b.ms || a.index - b.index; });
  }

  function renderTiles(tiles, active) {
    var todayKey = new Date().toDateString();
    presetsEl.innerHTML = tiles.map(function (tile) {
      var latest = tile.latest;
      var isToday = latest && new Date(latest.at).toDateString() === todayKey;
      var when = latest
        ? '<time class="ov2-preset-when' + (isToday ? " is-today" : "") + '" datetime="' + new Date(latest.at).toISOString() + '">' + esc(ago(latest.at)) + "</time>"
        : '<span class="ov2-preset-when">' + (gen.tab === "presets" ? "Not generated" : "Not captured yet") + "</span>";
      return '<button type="button" class="ov2-preset" data-preset="' + esc(tile.id) + '" aria-pressed="' + (tile.id === active) + '"' +
        ' title="' + esc(tile.label + (latest ? " · " + verdictOf(latest.verdict) + " · " + stamp(latest.at) : "")) + '">' +
        '<span class="ov2-preset-top"><span class="ov2-preset-tf">' + esc(tile.tf) + "</span>" +
        (latest ? verdictChip(latest.verdict, "") : "") + "</span>" +
        (tile.sub ? '<span class="ov2-preset-sym">' + esc(tile.sub) + "</span>" : "") +
        when + "</button>";
    }).join("");
  }

  function renderSymbolSelect() {
    var symbols = presetSymbols();
    var state = gen.presets;
    if (!symbols.some(function (s) { return s.symbol === state.symbol; })) state.symbol = symbols.length ? symbols[0].symbol : null;
    symbolEl.innerHTML = symbols.map(function (s) {
      return '<option value="' + esc(s.symbol) + '"' + (s.symbol === state.symbol ? " selected" : "") + ">" + esc(s.label) + "</option>";
    }).join("");
    symbolEl.disabled = !symbols.length;
  }

  function renderGeneration() {
    var isPresets = gen.tab === "presets";
    var state = gen[gen.tab];
    tabEls.forEach(function (tab, i) {
      var on = GEN_TABS[i] === gen.tab;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    symbolWrapEl.hidden = !isPresets;
    subtitleEl.textContent = isPresets ? "AI Analysis presets: latest read per timeframe" : "Saved layouts: latest read per timeframe";
    presetsEl.setAttribute("aria-label", isPresets ? "Timeframes for the selected preset — select one to filter the log" : "Saved layouts by timeframe — select one to filter the log");

    if (state.entries === null) {
      if (state.error) {
        presetsEl.innerHTML = '<p class="ov2-note ov2-warn" role="status">' + (isPresets ? "Presets" : "Layouts") + " unavailable.</p>";
        layoutLogEl.innerHTML = '<p class="ov2-note ov2-warn" role="status">Failed to load ' + (isPresets ? "runs" : "captures") +
          " (" + esc(state.error) + "). Use Refresh all to retry.</p>";
      } else {
        presetsEl.innerHTML = '<p class="ov2-note" role="status">Loading…</p>';
        layoutLogEl.innerHTML = '<p class="ov2-note" role="status">Loading…</p>';
      }
      if (isPresets) renderSymbolSelect();
      filterLabelEl.textContent = "Recent runs";
      return;
    }

    if (isPresets) renderSymbolSelect();
    var tiles = isPresets ? presetTiles() : layoutTiles();
    if (state.active && !tiles.some(function (t) { return t.id === state.active; })) state.active = null;
    var tile = tiles.filter(function (t) { return t.id === state.active; })[0];

    if (tiles.length) renderTiles(tiles, state.active);
    else presetsEl.innerHTML = '<p class="ov2-note" role="status">' + (isPresets ? "No presets configured." : "No saved layouts. Add them to AI_ANALYSIS_LAYOUTS.") + "</p>";

    var entries;
    var scope;
    if (isPresets) {
      var symbolLabel = (presetSymbols().filter(function (sym) { return sym.symbol === state.symbol; })[0] || {}).label || "";
      entries = state.entries.filter(function (e) { return e.symbol === state.symbol && (!tile || e.interval === tile.id); })
        .map(function (e) { return { verdict: e.verdict, generatedAt: e.generatedAt, label: (e.label || e.symbol) + " " + e.interval }; });
      scope = tile ? tile.label : symbolLabel + " · all timeframes";
      openLinkEl.href = "/ai-analysis.html";
      openLinkEl.textContent = "Open Presets ↗";
    } else {
      entries = state.entries.filter(function (e) { return !tile || e.layoutId === tile.id; });
      scope = tile ? tile.label : "all layouts";
      openLinkEl.href = tile ? tile.href : "/layout-analysis.html#aia-log";
      openLinkEl.textContent = tile ? "Open " + tile.tf + " ↗" : "Full log ↗";
    }
    filterLabelEl.textContent = "Recent " + (isPresets ? "runs" : "captures") + " · " + scope;
    renderLayoutLog(entries, tile ? tile.label : null);
  }

  function setGenTab(tab, focus) {
    gen.tab = tab;
    try { localStorage.setItem(GEN_TAB_KEY, tab); } catch (e) { /* private mode */ }
    renderGeneration();
    if (focus) document.getElementById("ov2-gen-tab-" + tab).focus();
  }

  tabEls.forEach(function (tab, i) {
    tab.addEventListener("click", function () { setGenTab(GEN_TABS[i], false); });
    tab.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      var next = event.key === "Home" ? 0 : event.key === "End" ? tabEls.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + tabEls.length) % tabEls.length;
      setGenTab(GEN_TABS[next], true);
    });
  });

  symbolEl.addEventListener("change", function () {
    gen.presets.symbol = symbolEl.value;
    gen.presets.active = null;
    try { localStorage.setItem(GEN_SYMBOL_KEY, symbolEl.value); } catch (e) { /* private mode */ }
    renderGeneration();
  });

  presetsEl.addEventListener("click", function (event) {
    var tile = event.target.closest("[data-preset]");
    if (!tile) return;
    var id = tile.getAttribute("data-preset");
    var state = gen[gen.tab];
    state.active = state.active === id ? null : id;
    renderGeneration();
    var again = presetsEl.querySelector('[data-preset="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (again && again.focus) again.focus();
  });

  // Called by the status loaders. The list read only adds tiles with no run
  // yet; if it fails, tiles come from the log alone.
  function loadGeneration(tab, listUrl, logUrl, applyList) {
    var state = gen[tab];
    var list = getJson(listUrl).then(applyList, function () { /* log-only tiles */ });
    return getJson(logUrl).then(function (data) {
      state.entries = data.entries || [];
      state.error = null;
      list.then(function () { if (gen.tab === tab) renderGeneration(); });
      if (gen.tab === tab) renderGeneration();
      return data.entries;
    }, function (err) {
      state.entries = null;
      state.error = err.message;
      if (gen.tab === tab) renderGeneration();
      throw err;
    });
  }

  function renderLayoutLog(entries, scopeLabel) {
    var recent = (entries || []).slice().sort(function (a, b) {
      return (time(b.generatedAt) || 0) - (time(a.generatedAt) || 0);
    }).slice(0, 12);
    if (!recent.length) {
      var none = gen.tab === "presets" ? "No runs" : "No captures";
      layoutLogEl.innerHTML = '<p class="ov2-note" role="status">' +
        (scopeLabel ? none + " of " + esc(scopeLabel) + " yet." : gen.tab === "presets" ? "No runs for this preset yet. Open Presets to generate one." : "No captures yet. Open My Layouts to capture a chart.") + "</p>";
      return;
    }
    var today = new Date();
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    var previousDay = null;
    var html = "";
    recent.forEach(function (entry) {
      var at = time(entry.generatedAt);
      var date = at === null ? null : new Date(at);
      var key = date ? date.toDateString() : "Unknown date";
      var isToday = key === today.toDateString();
      var label = isToday ? "Today" : key === yesterday.toDateString() ? "Yesterday"
        : date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : key;
      if (key !== previousDay) {
        if (previousDay !== null) html += "</div>";
        html += '<div class="aia-log-group"><div class="aia-log-group-title' + (isToday ? ' aia-log-group-title--today' : '') + '">' + esc(label) + '</div>';
        previousDay = key;
      }
      var clock = date ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "Unknown time";
      html += '<div class="aia-log-item' + (isToday ? ' aia-log-item--today' : '') + '">' +
        verdictChip(entry.verdict, "aia-log-verdict") +
        '<span class="aia-log-symbol" title="' + esc(entry.label || entry.layoutId || "Layout") + '">' + esc(entry.label || entry.layoutId || "Layout") + '</span>' +
        (date ? '<time class="aia-log-time" datetime="' + date.toISOString() + '" title="' + esc(stamp(at)) + '">' + esc(clock) + '</time>'
          : '<span class="aia-log-time">Unknown time</span>') + '</div>';
    });
    layoutLogEl.innerHTML = html + "</div>";
  }

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
