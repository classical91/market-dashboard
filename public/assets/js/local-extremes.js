/**
 * Local Extremes screener.
 *
 * One question only: is price stretched toward a local top or a local bottom
 * right now? That is location and exhaustion — where price sits inside the
 * move — and it is not a direction, not a forecast, and not an entry. A
 * confirmed local top inside a bullish trend is a legitimate reading, so
 * nothing here is translated into BUY / SELL / LONG / SHORT.
 *
 * Everything on screen comes from /api/local-extremes, a projection of the
 * shared screener scan that local-extreme-engine.js already produced. This
 * file re-scores nothing and recalculates no indicator.
 */
(function () {
  "use strict";

  var S = window.ScreenerUI;
  var escapeHtml = S.escapeHtml;

  var tbody = document.getElementById("lx-tbody");
  var summary = document.getElementById("lx-summary");
  var notice = document.getElementById("lx-notice");
  var refreshBtn = document.getElementById("lx-refresh-btn");
  var intervalSelect = document.getElementById("lx-interval");
  var searchInput = document.getElementById("lx-search");
  var filters = document.getElementById("lx-filters");
  var hideNoneToggle = document.getElementById("lx-hide-none");
  var updated = S.createUpdatedStamp(document.getElementById("lx-updated"), "ss-updated");
  var intervalMemory = S.rememberSelect(intervalSelect, "localExtremesInterval");

  var results = [];
  var filter = "ALL";

  var watchlist = S.createWatchlist(
    function () { return intervalSelect.value; },
    function () { render(); },
  );

  // BTC sets the weather for everything else on the board, so it is read as
  // context rather than as one more ranked candidate: pinned to the top and
  // never consuming a rank.
  var PINNED_SYMBOLS = ["BTCUSDT"];

  function isPinned(symbol) {
    return PINNED_SYMBOLS.indexOf(symbol) !== -1;
  }

  // What has actually triggered outranks what is merely stretched: a
  // CANDIDATE 90 has exhaustion evidence but no confirmation, while a
  // CONFIRMED 85 has turned back inside the band or broken structure. Score
  // breaks ties inside a tier.
  var STATE_RANK = { CONFIRMED: 4, CONFIRMING: 3, CANDIDATE: 2, WATCH: 1, NONE: 0 };

  function stateRank(entry) {
    if (entry.error) return -1;
    var rank = STATE_RANK[entry.state];
    return rank == null ? 0 : rank;
  }

  function peakScore(entry) {
    if (entry.error) return -1;
    return Math.max(S.clampScore(entry.bottomScore), S.clampScore(entry.topScore));
  }

  function scoreMeter(score, side) {
    var value = S.clampScore(score);
    return (
      '<span class="ss-extreme-meter ss-extreme-meter--' + side + '">' +
        "<strong>" + value + "</strong>" +
        '<span class="ss-extreme-track" aria-hidden="true"><span style="width:' + value + '%"></span></span>' +
      "</span>"
    );
  }

  /**
   * The visual label the page is read by: BOTTOM CONFIRMED, TOP CONFIRMING,
   * BOTTOM CANDIDATE. It names a location and how far its evidence has got —
   * never an action to take on it.
   */
  function extremeLabel(entry) {
    if (!entry.dominant || !entry.state || entry.state === "NONE") return "NONE";
    return entry.dominant.toUpperCase() + " " + entry.state;
  }

  // The side and the state sit in adjacent columns and are read across as one
  // label — TOP CONFIRMED, BOTTOM CANDIDATE. The badge itself prints only the
  // state, so the two cells don't stutter, and carries the full phrase as its
  // accessible name for anyone reading the cell on its own.
  function stateCell(entry) {
    var state = entry.state || "NONE";
    var label = extremeLabel(entry);
    return '<td data-label="State"><span class="lx-state lx-state--' + escapeHtml(state.toLowerCase()) +
      '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">' +
      escapeHtml(state) + "</span></td>";
  }

  function dominantCell(entry) {
    var side = entry.dominant ? entry.dominant.toUpperCase() : "NONE";
    return '<td data-label="Extreme"><span class="lx-side lx-side--' + escapeHtml(side.toLowerCase()) + '">' +
      escapeHtml(side) + "</span></td>";
  }

  // The engine's evidence components, in its own vocabulary. A chip is lit
  // only when that component actually scored, so an empty chip row means the
  // reading rests on nothing but price location.
  var EVIDENCE_CHIPS = [
    ["priceLocation", "BB", "Bollinger excursion"],
    ["momentum", "RSI", "RSI at an extreme"],
    ["divergence", "DIV", "Regular divergence"],
    ["liquidity", "SWEEP", "Liquidity sweep"],
    ["volume", "VOL", "Volume climax"],
    ["confirmation", "CONF", "Reversal confirmation"],
  ];

  function evidenceCell(entry) {
    var components = entry.components || {};
    var chips = EVIDENCE_CHIPS.map(function (chip) {
      var on = Boolean(components[chip[0]]);
      return '<span class="lx-chip' + (on ? " lx-chip--on" : "") + '" title="' + escapeHtml(chip[2]) +
        (on ? "" : " — not present") + '">' + escapeHtml(chip[1]) + "</span>";
    }).join("");
    var reasons = (entry.reasons || []).slice(0, 3).join(" · ") || "No active extreme";
    return (
      '<td class="lx-evidence" data-label="Evidence" title="' + escapeHtml(reasons) + '">' +
        '<span class="lx-chips">' + chips + "</span>" +
        '<span class="lx-reasons">' + escapeHtml(reasons) + "</span>" +
      "</td>"
    );
  }

  function trendCell(entry) {
    var trend = entry.trend && entry.trend !== "UNKNOWN" ? entry.trend : "Warming up";
    var tone = entry.trend === "UPTREND" ? "up" : entry.trend === "DOWNTREND" ? "down" : "flat";
    return '<td data-label="Trend"><span class="lx-trend lx-trend--' + tone + '">' + escapeHtml(trend) + "</span></td>";
  }

  function setupCell(entry) {
    var setup = entry.setupType && entry.setupType !== "none" ? entry.setupType : "—";
    return '<td class="lx-setup" data-label="Setup">' + escapeHtml(setup) + "</td>";
  }

  function rowMarker(rank) {
    return rank == null
      ? '<span class="ss-pin-tag">Context</span>'
      : '<span class="ss-rank">#' + rank + "</span>";
  }

  function tokenCell(symbol, rank) {
    return '<td><span class="ss-token-head">' + rowMarker(rank) +
      S.tickerLink(symbol, intervalSelect.value) + watchlist.button(symbol) + "</span></td>";
  }

  function renderRow(entry, rank) {
    if (entry.error) {
      return '<tr class="ss-error-row">' + tokenCell(entry.symbol, rank) +
        '<td colspan="10">' + escapeHtml(entry.error) + "</td>" +
        '<td data-label="Freshness">' + S.freshnessBadge(entry.freshness) + "</td></tr>";
    }
    var pinned = rank == null;
    return (
      '<tr class="lx-row lx-row--' + escapeHtml(entry.dominant || "none") + (pinned ? " lx-row--pinned" : "") + '">' +
        tokenCell(entry.symbol, rank) +
        '<td data-label="Price">' + S.fmtPrice(entry.price) + "</td>" +
        '<td data-label="Bottom">' + scoreMeter(entry.bottomScore, "bottom") + "</td>" +
        '<td data-label="Top">' + scoreMeter(entry.topScore, "top") + "</td>" +
        dominantCell(entry) +
        stateCell(entry) +
        setupCell(entry) +
        trendCell(entry) +
        // The engine reports RSI as evidence, so it is filled only when RSI
        // actually reached the extreme threshold on the leading side. A dash
        // means "not part of this reading", not "unknown".
        '<td data-label="RSI" title="RSI at the leading side\u2019s extreme \u2014 blank when RSI never reached the threshold">' +
          S.fmtNumber(entry.metrics && entry.metrics.rsi) + "</td>" +
        evidenceCell(entry) +
        '<td data-label="Timeframe"><span class="ss-summary-tf">' + escapeHtml(entry.interval) + "</span></td>" +
        '<td data-label="Freshness">' + S.freshnessBadge(entry.freshness) + "</td>" +
      "</tr>"
    );
  }

  function matchesFilters(entry) {
    var query = (searchInput.value || "").trim().toUpperCase();
    if (query && String(entry.symbol || "").indexOf(query) === -1) return false;
    if (entry.error) return true;
    // Weak rows are hidden by default so the page opens on what is actually
    // stretched; the toggle brings the whole universe back.
    if (hideNoneToggle.checked && (!entry.dominant || entry.state === "NONE")) return false;
    if (filter === "BOTTOMS") return entry.dominant === "bottom";
    if (filter === "TOPS") return entry.dominant === "top";
    if (filter === "CONFIRMED") return entry.state === "CONFIRMED";
    if (filter === "CONFIRMING") return entry.state === "CONFIRMING";
    if (filter === "CANDIDATES") return entry.state === "CANDIDATE";
    return true;
  }

  function compare(a, b) {
    return stateRank(b) - stateRank(a) || peakScore(b) - peakScore(a);
  }

  function renderSummary() {
    var usable = results.filter(function (entry) { return !entry.error; });
    var bottomLeads = usable.filter(function (entry) { return entry.dominant === "bottom"; }).length;
    var topLeads = usable.filter(function (entry) { return entry.dominant === "top"; }).length;
    var confirmed = usable.filter(function (entry) { return entry.state === "CONFIRMED"; }).length;
    var active = usable.filter(function (entry) { return entry.state && entry.state !== "NONE"; }).length;
    var stale = results.filter(function (entry) { return entry.freshness && entry.freshness.state !== "FRESH"; }).length;
    summary.innerHTML = (
      "<span>" + active + " active extremes</span>" +
      '<span class="ss-summary-bottom">&#8595; ' + bottomLeads + " bottom-led</span>" +
      '<span class="ss-summary-top">&#8593; ' + topLeads + " top-led</span>" +
      "<span>" + confirmed + " confirmed</span>" +
      (stale ? '<span class="ss-fresh ss-fresh--stale">' + stale + " not fresh</span>" : "") +
      '<span class="ss-summary-tf">' + escapeHtml(intervalSelect.value) + "</span>"
    );
  }

  function render() {
    // Pinned rows are lifted out before the sort, so the ranking itself is
    // untouched and the first ranked row is #1. BTC stays visible even when
    // it has no extreme, because "nothing stretched on BTC" is context too.
    // Only the search narrows the pinned row: "nothing stretched on BTC" is
    // still the market context every other row is read against, so the Hide
    // NONE toggle and the state filters never remove it.
    var query = (searchInput.value || "").trim().toUpperCase();
    var pinned = PINNED_SYMBOLS
      .map(function (symbol) {
        if (query && symbol.indexOf(query) === -1) return null;
        return results.filter(function (entry) { return entry.symbol === symbol; })[0];
      })
      .filter(Boolean);
    var ranked = results
      .filter(function (entry) { return !isPinned(entry.symbol) && matchesFilters(entry); })
      .sort(compare);

    var rows = pinned.map(function (entry) { return renderRow(entry, null); })
      .concat(ranked.map(function (entry, index) { return renderRow(entry, index + 1); }));

    tbody.innerHTML = rows.length
      ? rows.join("")
      : '<tr><td colspan="12" class="ss-empty-row">Nothing matches these filters.</td></tr>';
    renderSummary();
  }

  function load(force) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Scanning…";
    var params = new URLSearchParams({ interval: intervalSelect.value });
    if (force) params.set("force", "true");
    fetch("/api/local-extremes?" + params.toString())
      .then(function (res) { return res.json(); })
      .then(function (data) {
        notice.style.display = "none";
        results = data.results || [];
        render();
        updated.mark();
      })
      .catch(function (err) {
        notice.style.display = "block";
        notice.innerHTML = "&#9888;&#65039; Failed to load local extremes: " + escapeHtml(err.message);
      })
      .finally(function () {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Rescan";
      });
  }

  refreshBtn.addEventListener("click", function () { load(true); });
  intervalSelect.addEventListener("change", function () { intervalMemory.remember(); load(false); });
  searchInput.addEventListener("input", render);
  hideNoneToggle.addEventListener("change", render);
  filters.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-filter]");
    if (!btn) return;
    filter = btn.getAttribute("data-filter");
    Array.prototype.forEach.call(filters.querySelectorAll("[data-filter]"), function (each) {
      var active = each.getAttribute("data-filter") === filter;
      each.classList.toggle("is-active", active);
      each.setAttribute("aria-pressed", active ? "true" : "false");
    });
    render();
  });
  watchlist.bind(tbody);

  intervalMemory.restore();
  watchlist.load().then(function () { load(false); });
})();
