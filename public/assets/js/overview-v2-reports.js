/* Overview v2 — report widget tabs.
 *
 *   📰 News desks       the four desk tiles (overview-v2-status.js).
 *   📊 BTC Analytics    reports the phone's BTC Analytics Shortcut pushes to
 *                       /api/phone-briefings/btc-analytics.
 *   🥧 Market Dominance  reports from /api/phone-briefings/dominance.
 *
 * Each analytics tab shows its newest report and the few before it as tiles,
 * with the same freshness colours as the desks; a tile opens the same review
 * dialog. Read-only: nothing here generates or broadcasts.
 */
(function () {
  "use strict";

  var newsEl = document.getElementById("ov2-news");
  if (!newsEl) return;
  var esc = window.ScreenerUI.escapeHtml;
  var freshness = window.BriefingFreshness;
  var TAB_KEY = "overviewV2.newsTab";
  var TILES = 4;
  var REPORTS = [
    { key: "btc-analytics", label: "BTC Analytics", icon: "📊" },
    { key: "dominance", label: "Market Dominance", icon: "🥧" },
  ];
  var TABS = ["news"].concat(REPORTS.map(function (r) { return r.key; }));
  var tabEls = TABS.map(function (key) { return document.getElementById("ov2-news-tab-" + key); });
  var state = {};
  REPORTS.forEach(function (r) { state[r.key] = { runs: null, latest: null, error: false }; });

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function time(value) {
    var at = value ? new Date(value).getTime() : NaN;
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
    return '<time class="' + cls + '" datetime="' + new Date(at).toISOString() + '" title="' + esc(stamp(at)) + '">' + esc(stamp(at)) + "</time>";
  }

  // ── Tabs ───────────────────────────────────────────────────
  function setTab(tab, focus) {
    if (TABS.indexOf(tab) === -1) tab = "news";
    TABS.forEach(function (key, i) {
      var on = key === tab;
      tabEls[i].setAttribute("aria-selected", on ? "true" : "false");
      tabEls[i].tabIndex = on ? 0 : -1;
      document.getElementById("ov2-news-panel-" + key).hidden = !on;
    });
    newsEl.querySelectorAll("[data-news-part]").forEach(function (part) {
      part.hidden = part.getAttribute("data-news-part") !== tab;
    });
    try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* private mode */ }
    if (focus) tabEls[TABS.indexOf(tab)].focus();
  }

  tabEls.forEach(function (tab, i) {
    tab.addEventListener("click", function () { setTab(TABS[i], false); });
    tab.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      var next = event.key === "Home" ? 0 : event.key === "End" ? tabEls.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + tabEls.length) % tabEls.length;
      setTab(TABS[next], true);
    });
  });

  var saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch (e) { /* private mode */ }
  setTab(saved || "news", false);

  document.querySelectorAll("[data-report-endpoint]").forEach(function (code) {
    code.textContent = window.location.origin + "/api/phone-briefings/" + code.getAttribute("data-report-endpoint");
  });

  // ── Analytics reports ──────────────────────────────────────
  function render(report) {
    var s = state[report.key];
    var box = document.getElementById("ov2-reports-" + report.key);
    var last = document.getElementById("ov2-news-last-" + report.key);
    if (s.runs === null) {
      if (s.error) {
        box.innerHTML = '<span class="ov2-flat" role="status">Could not load ' + esc(report.label) + " reports. They will retry shortly.</span>";
        last.textContent = "Source unavailable";
      }
      return;
    }
    if (!s.runs.length) {
      box.innerHTML = '<span class="ov2-flat">No ' + esc(report.label) + " report yet. Point its Shortcut at the address below.</span>";
      last.textContent = "No report recorded";
      return;
    }
    box.innerHTML = s.runs.slice(0, TILES).map(function (run, i) {
      var at = time(run.receivedAt);
      var tone = i === 0 ? freshness.state(run.receivedAt) : "past";
      var name = i === 0 ? "Latest" : "Earlier";
      var meta = "📱 " + (at ? ago(at) : "time unknown") + (i === 0 ? " · " + freshness.label(run.receivedAt) : "");
      return '<a class="ov2-desk ' + tone + '" href="/api/phone-briefings/' + report.key + "/" + encodeURIComponent(run.id) + '"' +
        ' data-report-key="' + report.key + '" data-report-id="' + esc(run.id) + '" aria-haspopup="dialog" aria-controls="ov2-news-review">' +
        '<span class="ov2-desk-name">' + esc(name + (run.title ? " · " + run.title : "")) + "</span>" +
        '<span class="ov2-desk-meta">' + esc(meta) + "</span>" +
        (at ? timeTag(at, "ov2-desk-time") : '<span class="ov2-desk-time">&nbsp;</span>') +
        "</a>";
    }).join("");
    var newest = time(s.runs[0].receivedAt);
    last.innerHTML = newest
      ? "Last report " + esc(ago(newest)) + " · " + timeTag(newest, "ov2-news-stamp")
      : "Last report time unknown";
  }

  function load(report) {
    var s = state[report.key];
    return getJson("/api/phone-briefings/" + report.key).then(function (data) {
      s.runs = Array.isArray(data.runs) ? data.runs : [];
      s.error = false;
    }, function () {
      s.error = true;
    }).then(function () { render(report); });
  }

  function loadAll() { REPORTS.forEach(load); }

  function openRun(report, id) {
    var review = window.OverviewNewsReview;
    if (!review) return false;
    var s = state[report.key];
    var run = (s.runs || []).filter(function (r) { return r.id === id; })[0];
    var base = { key: report.key, label: report.label, icon: report.icon, deskHref: null };
    getJson("/api/phone-briefings/" + report.key + "/" + encodeURIComponent(id)).then(function (entry) {
      review.open(Object.assign(base, { at: time(entry.receivedAt), title: entry.title, text: entry.text }));
    }, function () {
      review.open(Object.assign(base, { at: run ? time(run.receivedAt) : null, failed: true }));
    });
    return true;
  }

  REPORTS.forEach(function (report) {
    document.getElementById("ov2-reports-" + report.key).addEventListener("click", function (event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      var link = event.target.closest("[data-report-id]");
      if (!link) return;
      if (openRun(report, link.getAttribute("data-report-id"))) event.preventDefault();
    });
  });

  loadAll();
  setInterval(function () { REPORTS.forEach(render); }, 60 * 1000);
  setInterval(function () { if (!document.hidden) loadAll(); }, 5 * 60 * 1000);
})();
