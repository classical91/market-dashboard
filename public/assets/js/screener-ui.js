/**
 * Shared chrome for the two screener pages — Directional Bias and Local
 * Extremes. They ask different questions of the same engine output, but they
 * are the same kind of page: one ranked table of the shared token universe on
 * a chosen timeframe, with TradingView links, My Trades stars and a freshness
 * readout per row.
 *
 * Everything numeric arrives from the server already computed. Nothing in
 * this file calculates an indicator, re-scores a row, or turns a reading into
 * a trade instruction.
 */
(function (global) {
  "use strict";

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtPrice(px) {
    if (px == null) return "—";
    if (px >= 1000) return px.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (px >= 1) return px.toFixed(4);
    return px.toFixed(6);
  }

  function fmtNumber(value, digits) {
    return value == null ? "—" : Number(value).toFixed(digits == null ? 1 : digits);
  }

  function clampScore(score) {
    return Math.max(0, Math.min(100, Number(score) || 0));
  }

  var TV_INTERVALS = { "1h": "60", "4h": "240", "1D": "D" };

  function tvChartUrl(symbol, interval) {
    return "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent("BINANCE:" + symbol) +
      "&interval=" + encodeURIComponent(TV_INTERVALS[interval] || "240");
  }

  // A plain (non-link) label plus an always-visible, clearly-a-button chart
  // link — a hover-tinted arrow next to plain text doesn't read as tappable
  // on mobile, where there is no hover state at all.
  function tickerLink(symbol, interval) {
    // The label carries the whole meaning on a phone, where the link narrows
    // to its icon.
    var label = "Open " + escapeHtml(symbol) + " " + escapeHtml(interval) + " on TradingView";
    return (
      '<span class="ss-ticker-cell">' +
        '<span class="ss-ticker-label">' + escapeHtml(symbol) + "</span>" +
        '<a class="ss-chart-link" href="' + tvChartUrl(symbol, interval) + '" target="_blank" rel="noopener" ' +
        'title="' + label + '" aria-label="' + label + '">' +
          '<span aria-hidden="true">&#128200;</span><span class="ss-chart-link-text">Chart</span>' +
        "</a>" +
      "</span>"
    );
  }

  /**
   * Data freshness, in the project's own vocabulary.
   *
   * The states come from src/services/data-freshness.js unchanged — this page
   * invents no rules of its own. Only the wording of UNKNOWN is translated at
   * the presentation boundary: "UNAVAILABLE" is what a reader needs to hear
   * when a row reports no age at all, and reading absent evidence as current
   * evidence is exactly what that module exists to prevent.
   */
  var FRESHNESS_LABELS = { FRESH: "FRESH", STALE: "STALE", UNKNOWN: "UNAVAILABLE" };

  function freshnessLabel(freshness) {
    var state = (freshness && freshness.state) || "UNKNOWN";
    return FRESHNESS_LABELS[state] || "UNAVAILABLE";
  }

  function freshnessBadge(freshness) {
    var state = (freshness && freshness.state) || "UNKNOWN";
    var reasons = (freshness && freshness.staleReasons) || [];
    var title = reasons.length ? reasons.join(" · ") : (freshness && freshness.summary) || "No data age reported";
    return (
      '<span class="ss-fresh ss-fresh--' + escapeHtml(state.toLowerCase()) + '" title="' + escapeHtml(title) + '">' +
      escapeHtml(freshnessLabel(freshness)) + "</span>"
    );
  }

  /**
   * My Trades stars, keyed by symbol *and* timeframe: the same token followed
   * on 4h and on 1D is two watchlist entries, so the star must reflect the
   * timeframe currently on screen.
   */
  function createWatchlist(getInterval, onChange) {
    var trackedKeys = {};

    function trackKey(symbol, interval) {
      return symbol + ":" + interval;
    }

    function isTracked(symbol) {
      return Boolean(trackedKeys[trackKey(symbol, getInterval())]);
    }

    function button(symbol) {
      var tracked = isTracked(symbol);
      var interval = getInterval();
      return (
        '<button class="ss-track-btn' + (tracked ? " ss-track-btn--active" : "") + '" type="button" data-role="track-btn" ' +
        'data-symbol="' + escapeHtml(symbol) + '" data-interval="' + escapeHtml(interval) + '" ' +
        'data-label="' + escapeHtml(symbol.replace(/USDT$/, "")) + '" ' +
        'title="' + (tracked ? "Remove from My Trades" : "Add to My Trades") + '" ' +
        'aria-label="' + (tracked ? "Remove " : "Add ") + escapeHtml(symbol) + " " + escapeHtml(interval) +
        (tracked ? " from" : " to") + ' My Trades">' + (tracked ? "&#9733;" : "&#9734;") + "</button>"
      );
    }

    function load() {
      return fetch("/api/watchlist")
        .then(function (res) { return res.json(); })
        .then(function (data) {
          trackedKeys = {};
          (data.items || []).forEach(function (item) { trackedKeys[trackKey(item.symbol, item.interval)] = true; });
        })
        .catch(function () { /* anonymous or offline: stars stay unfilled */ });
    }

    function toggle(btn) {
      var symbol = btn.getAttribute("data-symbol");
      var interval = btn.getAttribute("data-interval");
      var key = trackKey(symbol, interval);
      var tracked = Boolean(trackedKeys[key]);
      btn.disabled = true;
      global.AdminKey.fetch("/api/watchlist", {
        method: tracked ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: symbol, interval: interval, label: btn.getAttribute("data-label") }),
      })
        .then(function (res) { return res.json(); })
        .then(function () {
          if (tracked) delete trackedKeys[key];
          else trackedKeys[key] = true;
          if (onChange) onChange();
        })
        .catch(function () { /* leave the star as-is; the user can retry */ })
        .finally(function () { btn.disabled = false; });
    }

    // Delegated, so it keeps working across every re-render without being
    // re-bound per row.
    function bind(container) {
      container.addEventListener("click", function (event) {
        var btn = event.target.closest('[data-role="track-btn"]');
        if (btn) toggle(btn);
      });
    }

    return { load: load, bind: bind, button: button, isTracked: isTracked };
  }

  /**
   * The timeframe selection survives a reload: coming back to a page silently
   * reset to 4h, with no visual difference from the 1D you left it on, is the
   * kind of staleness that gets read as live.
   */
  function rememberSelect(select, storageKey) {
    function restore() {
      try {
        var saved = global.localStorage.getItem(storageKey);
        if (saved && Array.prototype.some.call(select.options, function (o) { return o.value === saved; })) {
          select.value = saved;
        }
      } catch (e) { /* private mode: the default stands */ }
    }
    function remember() {
      try { global.localStorage.setItem(storageKey, select.value); } catch (e) { /* nothing to persist */ }
    }
    return { restore: restore, remember: remember };
  }

  // Calendar-day difference, not a 24h rolling window — a scan at 11:58pm read
  // the next morning should say "yesterday", not "0 days ago".
  function daysAgo(date, now) {
    var startOfDay = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
    return Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  }

  /**
   * "Page refreshed" clock. It reports when this browser last asked, which is
   * deliberately not a claim about the data — each row carries its own age.
   */
  function createUpdatedStamp(element, className) {
    var lastScanAt = null;
    function render() {
      if (!lastScanAt) return;
      var now = new Date();
      var age = daysAgo(lastScanAt, now);
      var full = lastScanAt.toLocaleString(undefined, {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      if (age <= 0) {
        element.className = className;
        element.textContent = "Updated " + full;
      } else {
        element.className = className + " " + className + "--stale";
        var when = age === 1 ? "yesterday" : age + " days ago";
        element.textContent = "⚠️ Last scanned " + when + " — " + full;
      }
    }
    function mark() {
      lastScanAt = new Date();
      render();
    }
    global.setInterval(render, 1000);
    return { mark: mark, render: render };
  }

  global.ScreenerUI = {
    escapeHtml: escapeHtml,
    fmtPrice: fmtPrice,
    fmtNumber: fmtNumber,
    clampScore: clampScore,
    tvChartUrl: tvChartUrl,
    tickerLink: tickerLink,
    freshnessBadge: freshnessBadge,
    freshnessLabel: freshnessLabel,
    FRESHNESS_LABELS: FRESHNESS_LABELS,
    createWatchlist: createWatchlist,
    rememberSelect: rememberSelect,
    createUpdatedStamp: createUpdatedStamp,
    daysAgo: daysAgo,
  };
})(window);
