(function () {
  "use strict";
  var esc = window.ScreenerUI.escapeHtml;
  var model = window.OverviewV2Model;
  var grid = document.getElementById("ov2-grid");
  var status = document.getElementById("ov2-status");
  var refresh = document.getElementById("ov2-refresh");
  var interval = document.getElementById("ov2-interval");
  var generation = 0;
  var cards = [
    { id: "directional", title: "Directional Bias", question: "Which way is the market leaning?", path: "directional-bias", period: function () { return interval.value + " · 4 checks"; }, query: function () { return "interval=" + interval.value + "&minChecks=4"; } },
    { id: "extremes", title: "Local Extremes", question: "Where is price stretched?", path: "local-extremes", period: function () { return interval.value; }, query: function () { return "interval=" + interval.value + "&minChecks=4"; } },
    { id: "patterns", title: "Pattern Scanner", question: "What structure is forming?", path: "pattern-scanner", period: function () { return "1h / 4h / 1D"; } },
    { id: "cryptoOi", title: "Crypto Open Interest", question: "Is participation expanding?", path: "open-interest", period: function () { return "24h OI"; }, query: function () { return "confluence=4h"; } },
    { id: "crossOi", title: "Cross-Market Open Interest", question: "How are futures markets positioned?", path: "cross-market-oi", period: function () { return "Weekly · 1W Δ"; }, query: function () { return "timeframe=W&lookback=1w"; } },
    { id: "rsi", title: "RSI Matrix", question: "Where is momentum strongest?", path: "rsi-matrix", period: function () { return "All enabled TFs"; } },
  ];
  function shell(card, i) {
    return '<article class="ov2-card" id="ov2-' + card.id + '" aria-labelledby="ov2-title-' + card.id + '">' +
      '<header class="ov2-card-head"><div class="ov2-card-title"><span class="ov2-number">0' + (i + 1) + '</span><div><h3 id="ov2-title-' + card.id + '">' + esc(card.title) + '</h3><p>' + esc(card.question) + '</p></div></div><span class="ov2-period">' + esc(card.period()) + '</span></header>' +
      '<div class="ov2-body"></div><div class="ov2-card-foot"><span class="ov2-stamp">Awaiting response</span><a href="/' + card.path + '.html">Open screener ↗</a></div></article>';
  }
  function render(summary) {
    var h = summary.health || {};
    return '<div class="ov2-summary"><strong class="ov2-lead ov2-' + esc(summary.tone) + '">' + esc(summary.lead) + '</strong><span>' + esc(summary.subtitle) + '</span></div>' +
      (summary.total ? '<div class="ov2-metrics">' + summary.metrics.map(function (m) { return '<div class="ov2-metric"><strong class="ov2-' + esc(m.tone) + '">' + esc(m.value) + '</strong><span>' + esc(m.label) + '</span></div>'; }).join("") + '</div>' : '<p class="ov2-note">No usable readings returned. Open the screener for source details.</p>') +
      '<div class="ov2-readings">' + summary.readings.map(function (r) { return '<div class="ov2-reading"><strong>' + esc(r.label) + '</strong><span class="ov2-' + esc(r.tone) + '">' + esc(r.value) + '</span></div>'; }).join("") + '</div>' +
      (summary.total && !summary.readings.length ? '<p class="ov2-note">' + esc(summary.empty || "No highlighted readings.") + '</p>' : "") +
      '<div class="ov2-health">' + (h.notFresh ? '<span class="ov2-warn">' + h.notFresh + ' ' + esc(h.unit || "readings") + ' not fresh / age unknown</span>' : "") +
      (h.unavailable ? '<span class="ov2-warn">' + h.unavailable + ' ' + esc(h.unit || "readings") + ' unavailable</span>' : "") + '</div><p class="ov2-note">' + esc(summary.note) + '</p>';
  }
  async function loadCard(card, force, pass) {
    var element = document.getElementById("ov2-" + card.id);
    var body = element.querySelector(".ov2-body");
    element.setAttribute("aria-busy", "true");
    element.querySelector(".ov2-period").textContent = card.period();
    element.querySelector(".ov2-stamp").textContent = "Loading…";
    body.innerHTML = '<div class="ov2-loading">Loading indicators…<div class="ov2-skeleton"></div><div class="ov2-skeleton"></div><div class="ov2-skeleton"></div></div>';
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 90000);
    try {
      var query = (card.query ? card.query() + "&" : "") + (force ? "force=1" : "");
      var response = await fetch("/api/" + card.path + (query ? "?" + query : ""), { signal: controller.signal, credentials: "same-origin" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      if (pass !== generation) return false;
      body.innerHTML = render(model[card.id](data));
      element.querySelector(".ov2-stamp").textContent = "Received " + new Date().toLocaleTimeString();
      return true;
    } catch (err) {
      if (pass !== generation) return false;
      body.innerHTML = '<div class="ov2-empty"><strong class="ov2-warn">Screener unavailable</strong><p>' + esc(err.name === "AbortError" ? "The request timed out." : err.message) + '</p><button class="ov2-button ov2-retry" type="button" data-retry="' + card.id + '">Retry this screener</button></div>';
      element.querySelector(".ov2-stamp").textContent = "Request failed";
      return false;
    } finally {
      clearTimeout(timeout);
      if (pass === generation) element.setAttribute("aria-busy", "false");
    }
  }
  async function loadAll(force) {
    var pass = ++generation, completed = 0, loaded = 0;
    refresh.disabled = true;
    interval.disabled = true;
    status.textContent = "Loading 6 screeners…";
    await Promise.all(cards.map(async function (card) {
      var ok = await loadCard(card, force, pass);
      if (pass !== generation) return;
      completed++;
      if (ok) loaded++;
      status.textContent = completed < cards.length ? completed + " / 6 responses received" : loaded + " / 6 responses received · check card coverage";
    }));
    if (pass === generation) { refresh.disabled = false; interval.disabled = false; }
  }
  grid.innerHTML = cards.map(shell).join("");
  refresh.addEventListener("click", function () { loadAll(true); });
  interval.addEventListener("change", function () { loadAll(false); });
  grid.addEventListener("click", async function (event) {
    var button = event.target.closest("[data-retry]");
    if (!button) return;
    var card = cards.find(function (item) { return item.id === button.dataset.retry; });
    if (card) {
      var ok = await loadCard(card, false, generation);
      status.textContent = card.title + (ok ? " response received · check card coverage" : " request failed");
    }
  });
  loadAll(false);
})();
