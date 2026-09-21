/**
 * Directional Bias screener.
 *
 * One question only: which way are trend and momentum leaning, and how much
 * of the evidence agrees? Every value on screen arrives from
 * /api/directional-bias, which is a projection of the shared screener scan —
 * this file computes no indicator and re-scores nothing.
 *
 * The vocabulary is BULLISH / BEARISH / NEUTRAL throughout. LONG and SHORT
 * stay on the wire and on the pages that publish an actual setup with an
 * entry, a stop and a target; a bias is the environment, not an instruction.
 */
(function () {
  "use strict";

  var S = window.ScreenerUI;
  var escapeHtml = S.escapeHtml;

  var tbody = document.getElementById("db-tbody");
  var summary = document.getElementById("db-summary");
  var notice = document.getElementById("db-notice");
  var refreshBtn = document.getElementById("db-refresh-btn");
  var intervalSelect = document.getElementById("db-interval");
  var minChecksSelect = document.getElementById("db-min-checks");
  var searchInput = document.getElementById("db-search");
  var biasFilters = document.getElementById("db-bias-filters");
  var strengthFilters = document.getElementById("db-strength-filters");
  var updated = S.createUpdatedStamp(document.getElementById("db-updated"), "ss-updated");
  var intervalMemory = S.rememberSelect(intervalSelect, "directionalBiasInterval");

  var results = [];
  var context = null;
  var biasFilter = "ALL";
  var strengthFilter = "ALL";

  var watchlist = S.createWatchlist(
    function () { return intervalSelect.value; },
    function () { render(); },
  );

  // BTC sets the weather for everything else on the board, so it is read as
  // context rather than as one more ranked candidate: pinned to the top and
  // never consuming a rank. Ranks below it start at #1, so the first altcoin
  // reads as the first candidate.
  var PINNED_SYMBOLS = ["BTCUSDT"];

  function isPinned(symbol) {
    return PINNED_SYMBOLS.indexOf(symbol) !== -1;
  }

  function biasClass(bias) {
    if (bias === "BULLISH") return "db-bias db-bias--bullish";
    if (bias === "BEARISH") return "db-bias db-bias--bearish";
    return "db-bias db-bias--neutral";
  }

  function scoreClass(score) {
    if (score >= 80) return "ss-score--high";
    if (score >= 65) return "ss-score--mid";
    if (score >= 50) return "ss-score--neutral";
    return "ss-score--low";
  }

  function rsiClass(rsi) {
    if (rsi == null) return "ss-rsi--mid";
    if (rsi > 65) return "ss-rsi--high";
    if (rsi < 35) return "ss-rsi--low";
    return "ss-rsi--mid";
  }

  function adxClass(adx) {
    return adx != null && adx > 25 ? "ss-adx--trending" : "ss-adx--flat";
  }

  // A component reads bullish, bearish, or neither. The tint follows the
  // component's own reading and never the row's overall bias, so a bearish
  // MACD inside a bullish row stays visibly bearish.
  var COMPONENT_TONE = {
    BULLISH: "bull", BEARISH: "bear",
    ABOVE: "bull", BELOW: "bear",
    CONFIRMED: "bull", LIGHT: "flat",
  };

  function componentCell(label, value) {
    if (value == null) return '<td data-label="' + escapeHtml(label) + '"><span class="db-part db-part--none">—</span></td>';
    var tone = COMPONENT_TONE[value] || "flat";
    return '<td data-label="' + escapeHtml(label) + '"><span class="db-part db-part--' + tone + '">' +
      escapeHtml(value) + "</span></td>";
  }

  function trendRegimeCell(regime) {
    var text = regime ? regime.replace("_", " ") : "—";
    var tone = regime === "TREND_UP" ? "bull" : regime === "TREND_DOWN" ? "bear" : "flat";
    return '<td data-label="Trend regime"><span class="db-regime db-regime--' + tone + '">' + escapeHtml(text) + "</span></td>";
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
        '<td colspan="11">' + escapeHtml(entry.error) + "</td>" +
        '<td data-label="Freshness">' + S.freshnessBadge(entry.freshness) + "</td></tr>";
    }
    var pinned = rank == null;
    return (
      '<tr class="db-row db-row--' + escapeHtml(String(entry.bias || "neutral").toLowerCase()) +
        (pinned ? " db-row--pinned" : "") + '">' +
        tokenCell(entry.symbol, rank) +
        '<td data-label="Price">' + S.fmtPrice(entry.price) + "</td>" +
        '<td data-label="Bias"><span class="' + biasClass(entry.bias) +
          '" title="Directional bias — context, not an entry">' + escapeHtml(entry.bias) + "</span></td>" +
        '<td data-label="Score"><span class="ss-badge ' + scoreClass(entry.score) + '">' +
          (entry.score == null ? "—" : entry.score + "%") + "</span></td>" +
        trendRegimeCell(entry.trendRegime) +
        '<td data-label="RSI"><span class="ss-badge ' + rsiClass(entry.rsi) + '">' + S.fmtNumber(entry.rsi) + "</span></td>" +
        '<td data-label="ADX"><span class="ss-badge ' + adxClass(entry.adx) + '">' + S.fmtNumber(entry.adx) + "</span></td>" +
        componentCell("EMA", entry.emaStructure) +
        componentCell("VWAP", entry.vwap) +
        componentCell("MACD", entry.macd) +
        componentCell("Volume", entry.volume) +
        '<td data-label="Timeframe"><span class="ss-summary-tf">' + escapeHtml(entry.interval) + "</span></td>" +
        '<td data-label="Freshness">' + S.freshnessBadge(entry.freshness) + "</td>" +
      "</tr>"
    );
  }

  // USDT.D cannot be scored: it is a CRYPTOCAP index with no candles and no
  // volume, so the bias engine has nothing to run on. The row reports what is
  // actually sourceable — the current level, and a direction once the server
  // has accumulated enough of its own snapshots — and leaves the scored
  // columns visibly empty rather than filling them with zeros.
  function renderDominanceRow(dominance) {
    if (!dominance || dominance.percent == null) return "";
    var direction = dominance.direction;
    var change = (dominance.changes && (dominance.changes.h24 || dominance.changes.h4)) || null;
    var window = dominance.changes && dominance.changes.h24 ? "24h" : "4h";
    var readout = direction
      ? '<span class="ss-dom-direction ss-dom-direction--' + direction.toLowerCase() + '">' + escapeHtml(direction) +
          (change ? ' <span class="ss-dom-delta">' + (change.delta > 0 ? "+" : "") + change.delta.toFixed(2) + "pp/" + window + "</span>" : "") +
        "</span>"
      : '<span class="ss-dom-direction ss-dom-direction--pending" title="Direction needs snapshots spanning at least 4h; the server is collecting them">BUILDING HISTORY</span>';
    var unscored = '<span class="ss-dom-na" title="Not scored — USDT.D has no OHLCV, so the candle-based engine cannot run on it">&mdash;</span>';
    var note = dominance.live === false
      ? "Provider offline · last known level"
      : "Stablecoin share of total market cap · " + (dominance.source || "unknown");
    // Every scored column stays its own cell, empty. A colspan across four of
    // them would let this one row widen the columns the other 25 rows are
    // read in.
    return (
      '<tr class="db-row db-row--pinned db-row--dominance">' +
        '<td><span class="ss-token-head">' + rowMarker(null) +
          '<span class="ss-ticker-cell"><span class="ss-ticker-label">USDT.D</span>' +
          '<a class="ss-chart-link" href="https://www.tradingview.com/chart/?symbol=CRYPTOCAP%3AUSDT.D" target="_blank" rel="noopener" ' +
          'title="Open USDT.D on TradingView" aria-label="Open USDT.D on TradingView">' +
          '<span aria-hidden="true">&#128200;</span><span class="ss-chart-link-text">Chart</span></a></span></span>' +
          '<span class="db-dom-note">' + escapeHtml(note) + "</span></td>" +
        '<td data-label="Level">' + dominance.percent.toFixed(2) + "%</td>" +
        '<td data-label="Direction">' + readout + "</td>" +
        '<td data-label="Score">' + unscored + "</td>" +
        '<td data-label="Trend regime"><span class="db-regime db-regime--flat" title="Not scored — no candle data for a CRYPTOCAP index">NOT SCORED</span></td>' +
        '<td data-label="RSI">' + unscored + "</td>" +
        '<td data-label="ADX">' + unscored + "</td>" +
        '<td data-label="EMA">' + unscored + "</td>" +
        '<td data-label="VWAP">' + unscored + "</td>" +
        '<td data-label="MACD">' + unscored + "</td>" +
        '<td data-label="Volume">' + unscored + "</td>" +
        '<td data-label="Timeframe"><span class="ss-summary-tf">' + escapeHtml(intervalSelect.value) + "</span></td>" +
        '<td data-label="Freshness"><span class="ss-fresh ss-fresh--unknown" title="Not scored — no candle data for a CRYPTOCAP index">NOT SCORED</span></td>' +
      "</tr>"
    );
  }

  function matchesFilters(entry) {
    if (biasFilter !== "ALL" && (entry.bias || "NEUTRAL") !== biasFilter) return false;
    if (strengthFilter === "TRENDING" && entry.trendRegime !== "TREND_UP" && entry.trendRegime !== "TREND_DOWN") return false;
    if (strengthFilter === "STRONG_ADX" && !(entry.adx != null && entry.adx >= 25)) return false;
    if (strengthFilter === "WEAK_TREND" && !(entry.adx != null && entry.adx < 20)) return false;
    var query = (searchInput.value || "").trim().toUpperCase();
    if (query && String(entry.symbol || "").indexOf(query) === -1) return false;
    return true;
  }

  /**
   * Ranking is by confidence, never by desirability: a BEARISH 83 outranks a
   * BULLISH 67 because more of the evidence agrees with it, not because down
   * is better than up. Rows with no directional read sort last, since a
   * NEUTRAL score measures nothing to be confident about.
   */
  function compare(a, b) {
    var directionalA = a.bias && a.bias !== "NEUTRAL" ? 1 : 0;
    var directionalB = b.bias && b.bias !== "NEUTRAL" ? 1 : 0;
    if (directionalA !== directionalB) return directionalB - directionalA;
    return (b.score || 0) - (a.score || 0);
  }

  function renderSummary(usable) {
    var bullish = usable.filter(function (entry) { return entry.bias === "BULLISH"; }).length;
    var bearish = usable.filter(function (entry) { return entry.bias === "BEARISH"; }).length;
    var neutral = usable.filter(function (entry) { return entry.bias === "NEUTRAL"; }).length;
    var stale = results.filter(function (entry) { return entry.freshness && entry.freshness.state !== "FRESH"; }).length;
    var lean = bullish > bearish ? "RISK ON" : bearish > bullish ? "RISK OFF" : "BALANCED";
    var leanClass = bullish > bearish ? "ss-summary-bias--on" : bearish > bullish ? "ss-summary-bias--off" : "ss-summary-bias--neutral";
    summary.innerHTML = (
      "<span>" + (bullish + bearish) + " with a directional bias</span>" +
      '<span class="ss-summary-bottom">&#9650; ' + bullish + " bullish</span>" +
      '<span class="ss-summary-top">&#9660; ' + bearish + " bearish</span>" +
      "<span>" + neutral + " neutral</span>" +
      '<span class="' + leanClass + '">' + lean + "</span>" +
      (stale ? '<span class="ss-fresh ss-fresh--stale">' + stale + " not fresh</span>" : "") +
      '<span class="ss-summary-tf">' + escapeHtml(intervalSelect.value) + "</span>"
    );
  }

  function render() {
    // Pinned rows are lifted out before the sort, so the ranking itself is
    // untouched and the first ranked row is #1.
    var pinned = PINNED_SYMBOLS
      .map(function (symbol) {
        return results.filter(function (entry) { return entry.symbol === symbol && matchesFilters(entry); })[0];
      })
      .filter(Boolean);
    var ranked = results
      .filter(function (entry) { return !isPinned(entry.symbol) && matchesFilters(entry); })
      .sort(compare);

    var rows = pinned.map(function (entry) { return renderRow(entry, null); })
      .concat([renderDominanceRow(context && context.usdtDominance)])
      .filter(Boolean)
      .concat(ranked.map(function (entry, index) { return renderRow(entry, index + 1); }));

    tbody.innerHTML = rows.length
      ? rows.join("")
      : '<tr><td colspan="13" class="ss-empty-row">Nothing matches these filters.</td></tr>';
    renderSummary(results.filter(function (entry) { return !entry.error; }));
  }

  function selectFilter(group, value) {
    Array.prototype.forEach.call(group.querySelectorAll("[data-filter]"), function (btn) {
      var active = btn.getAttribute("data-filter") === value;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function load(force) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Scanning…";
    var params = new URLSearchParams({ interval: intervalSelect.value, minChecks: minChecksSelect.value });
    if (force) params.set("force", "true");
    fetch("/api/directional-bias?" + params.toString())
      .then(function (res) { return res.json(); })
      .then(function (data) {
        notice.style.display = "none";
        results = data.results || [];
        context = data.context || null;
        render();
        updated.mark();
      })
      .catch(function (err) {
        notice.style.display = "block";
        notice.innerHTML = "&#9888;&#65039; Failed to load directional bias: " + escapeHtml(err.message);
      })
      .finally(function () {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Rescan";
      });
  }

  refreshBtn.addEventListener("click", function () { load(true); });
  intervalSelect.addEventListener("change", function () { intervalMemory.remember(); load(false); });
  minChecksSelect.addEventListener("change", function () { load(false); });
  searchInput.addEventListener("input", render);
  biasFilters.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-filter]");
    if (!btn) return;
    biasFilter = btn.getAttribute("data-filter");
    selectFilter(biasFilters, biasFilter);
    render();
  });
  strengthFilters.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-filter]");
    if (!btn) return;
    strengthFilter = btn.getAttribute("data-filter");
    selectFilter(strengthFilters, strengthFilter);
    render();
  });
  watchlist.bind(tbody);

  // The watchlist is read first so the stars are already correct on the first
  // paint rather than filling in a moment later.
  intervalMemory.restore();
  watchlist.load().then(function () { load(false); });
})();
