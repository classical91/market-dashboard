(function () {
  "use strict";

  const REFRESH_MS = 90_000;
  const STALE_MS = 10 * 60_000;

  const els = {};
  let lastPayload = null;
  let loading = false;

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    Object.assign(els, {
      grid: $("cryptoWidgetsGrid"),
      status: $("cryptoWidgetsStatus"),
      meta: $("cryptoWidgetsMeta"),
      alert: $("cryptoWidgetsAlert"),
      refresh: $("cryptoWidgetsRefresh"),
    });

    if (!els.grid || !els.status || !els.meta || !els.alert || !els.refresh) return;

    els.refresh.addEventListener("click", () => loadWidgets({ force: true }));
    renderLoading();
    loadWidgets();
    setInterval(loadWidgets, REFRESH_MS);
  }

  async function loadWidgets() {
    if (loading) return;
    loading = true;
    els.refresh.disabled = true;

    try {
      const res = await fetch("/api/overview?range=1D", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Overview API ${res.status}`);
      lastPayload = await res.json();
      renderWidgets(lastPayload);
    } catch (error) {
      renderError(error);
    } finally {
      loading = false;
      els.refresh.disabled = false;
    }
  }

  function renderLoading() {
    setStatus("loading", "Loading");
    els.meta.textContent = "Fetching read-only public market data...";
    els.alert.hidden = true;
    els.grid.innerHTML = Array.from({ length: 4 })
      .map(() => `<article class="crypto-widget-card is-loading">
        <span class="crypto-skeleton crypto-skeleton--title"></span>
        <span class="crypto-skeleton crypto-skeleton--value"></span>
        <span class="crypto-skeleton crypto-skeleton--note"></span>
      </article>`)
      .join("");
  }

  function renderWidgets(data) {
    const scope = data.scopes?.crypto || {};
    const assets = Array.isArray(scope.ticker) ? scope.ticker : [];
    const allocation = scope.allocation || data.allocation || {};
    const status = feedStatus(data, allocation);
    const btc = findAsset(assets, "BTC");
    const eth = findAsset(assets, "ETH");
    const regime = scope.marketStatus || data.marketStatus || {};

    setStatus(status.tone, status.label);
    els.meta.textContent = `${status.detail} Last update ${formatTime(data.updatedAt)}.`;
    renderAlert(status, data);

    els.grid.innerHTML = [
      renderSpotCard("BTC", "Bitcoin", btc),
      renderSpotCard("ETH", "Ethereum", eth),
      renderSnapshotCard(allocation),
      renderRegimeCard(regime, allocation),
    ].join("");
  }

  function renderSpotCard(symbol, name, asset) {
    const change = Number(asset?.changePercent);
    return `<article class="crypto-widget-card">
      <div class="crypto-widget-card__top">
        <span class="crypto-widget-card__label">${escapeHtml(symbol)} Spot</span>
        <span class="${changeClass(change)}">${formatPercent(change)}</span>
      </div>
      <div class="crypto-widget-card__value">${escapeHtml(formatMoney(asset?.price))}</div>
      <div class="crypto-widget-card__note">${escapeHtml(name)} 24h volume ${escapeHtml(asset?.volume || "-")}</div>
    </article>`;
  }

  function renderSnapshotCard(allocation) {
    const btcDom = dominance(allocation, "BTC");
    const ethDom = dominance(allocation, "ETH");
    return `<article class="crypto-widget-card crypto-widget-card--wide">
      <div class="crypto-widget-card__top">
        <span class="crypto-widget-card__label">Market Snapshot</span>
        <span class="crypto-change">${escapeHtml(allocation.source || "feed")}</span>
      </div>
      <div class="crypto-metric-stack">
        <div class="crypto-metric-row"><span>Total market cap</span><strong>${escapeHtml(formatCompactUsd(allocation.marketCapUsd))}</strong></div>
        <div class="crypto-metric-row"><span>24h volume</span><strong>${escapeHtml(formatCompactUsd(allocation.volume24hUsd))}</strong></div>
        <div class="crypto-metric-row"><span>BTC dominance</span><strong>${escapeHtml(formatPercentValue(btcDom))}</strong></div>
        <div class="crypto-metric-row"><span>ETH dominance</span><strong>${escapeHtml(formatPercentValue(ethDom))}</strong></div>
      </div>
    </article>`;
  }

  function renderRegimeCard(regime, allocation) {
    const score = clamp(Number(regime.riskScore), 0, 100, 50);
    const label = regime.label || "Unknown";
    const summary = regime.summary || "No regime read available yet.";
    return `<article class="crypto-widget-card crypto-widget-card--wide">
      <div class="crypto-widget-card__top">
        <span class="crypto-widget-card__label">Market Regime</span>
        <span class="crypto-change">${escapeHtml(regime.volatilityLabel || "Volatility n/a")}</span>
      </div>
      <div class="crypto-widget-card__value">${escapeHtml(label)} ${score}/100</div>
      <div class="crypto-regime-meter" aria-hidden="true" style="--score:${score}%"><span></span></div>
      <div class="crypto-widget-card__note">${escapeHtml(summary)} ${allocation.stale ? "Delayed global feed." : ""}</div>
    </article>`;
  }

  function renderAlert(status, data) {
    const warnings = data.dataQuality?.warnings || [];
    const shown = warnings.filter((warning) => /crypto|market pulse|allocation/i.test(warning)).slice(0, 2);
    if (status.tone === "live" && !shown.length) {
      els.alert.hidden = true;
      els.alert.textContent = "";
      return;
    }
    els.alert.hidden = false;
    els.alert.textContent = shown.length
      ? shown.join(" ")
      : "Feed is degraded. Showing available cached or fallback read-only data.";
  }

  function renderError(error) {
    if (lastPayload) {
      renderWidgets(lastPayload);
      setStatus("delayed", "Delayed");
      els.alert.hidden = false;
      els.alert.textContent = `Refresh failed: ${error.message}. Showing the last loaded snapshot.`;
      return;
    }

    setStatus("error", "Error");
    els.meta.textContent = "Crypto widgets could not load. Use the external research links below while the feed recovers.";
    els.alert.hidden = false;
    els.alert.textContent = error.message;
    els.grid.innerHTML = `<article class="crypto-widget-card crypto-widget-card--wide">
      <span class="crypto-widget-card__label">Feed Error</span>
      <div class="crypto-widget-card__value">Unavailable</div>
      <div class="crypto-widget-card__note">No trade execution or write credentials are involved.</div>
    </article>`;
  }

  function feedStatus(data, allocation) {
    const updatedMs = Date.parse(data.updatedAt || "");
    const staleByAge = Number.isFinite(updatedMs) && Date.now() - updatedMs > STALE_MS;
    const modules = data.dataQuality?.modules || {};
    if (allocation.stale || modules.crypto === "delayed" || staleByAge) {
      return { tone: "delayed", label: "Delayed", detail: "Showing last available crypto data." };
    }
    if (data.dataQuality?.live) {
      return { tone: "live", label: data.dataQuality.partial ? "Partial Live" : "Live", detail: "CoinGecko-backed feed is live." };
    }
    return { tone: "fallback", label: "Fallback", detail: "Using fallback crypto data." };
  }

  function setStatus(tone, label) {
    els.status.className = `crypto-feed-pill is-${tone}`;
    els.status.textContent = label;
  }

  function findAsset(assets, symbol) {
    return assets.find((asset) => String(asset.symbol || "").toUpperCase() === symbol) || null;
  }

  function dominance(allocation, symbol) {
    const segments = Array.isArray(allocation.segments) ? allocation.segments : [];
    return segments.find((entry) => String(entry.label || "").toUpperCase() === symbol)?.percent;
  }

  function changeClass(value) {
    const n = Number(value);
    return `crypto-change ${n > 0 ? "is-up" : n < 0 ? "is-down" : ""}`;
  }

  function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "-";
    const options = n >= 1000 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return `$${n.toLocaleString(undefined, options)}`;
  }

  function formatCompactUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "-";
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    return formatMoney(n);
  }

  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  }

  function formatPercentValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${n.toFixed(2)}%`;
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "unknown";
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function clamp(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
