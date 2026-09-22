// On-Chain Intelligence card on Overview. Reads only our own
// /api/onchain/intelligence endpoint; the server talks to DefiLlama.
// Runs independently of overview.js so a failure here never touches the rest
// of the page.
(function () {
  "use strict";

  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const ARROWS = { up: "↑", down: "↓", flat: "→" };
  const STATUS_TITLES = {
    LIVE: "Fetched from DefiLlama on the latest refresh",
    CACHED: "DefiLlama refresh failed — showing a recent cached copy",
    STALE: "DefiLlama refresh failed — showing an older cached copy",
    UNAVAILABLE: "No on-chain data available yet",
  };

  let last = null;
  let loading = false;

  function $(id) {
    return document.getElementById(id);
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch("/api/onchain/intelligence", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`API ${res.status}`);
      last = await res.json();
      render(last);
    } catch (error) {
      // Keep whatever was already on screen; only fall to UNAVAILABLE when
      // there was never anything to show.
      if (last) {
        setStatus("STALE", `Could not refresh: ${error.message}`);
      } else {
        setStatus("UNAVAILABLE", error.message);
        $("ociBody").innerHTML = `<div class="empty-state">On-chain data unavailable right now. The rest of Overview is unaffected.</div>`;
      }
    } finally {
      loading = false;
    }
  }

  function setStatus(status, detail) {
    const el = $("ociStatus");
    el.className = `oci-status oci-status-${status.toLowerCase()}`;
    el.textContent = `● ${status}`;
    el.title = detail || STATUS_TITLES[status] || "";
  }

  function render(data) {
    const errors = Array.isArray(data.errors) ? data.errors : [];
    setStatus(data.status || "UNAVAILABLE", [STATUS_TITLES[data.status], ...errors].filter(Boolean).join(" • "));

    if (data.status === "UNAVAILABLE") {
      $("ociBody").innerHTML = `<div class="empty-state">On-chain data unavailable right now. The rest of Overview is unaffected.</div>`;
      return;
    }

    const m = data.metrics || {};
    const pulse = data.pulse || {};
    const liquidity = data.liquidity || {};

    $("ociBody").innerHTML = `
      <div class="oci-headline">
        <div class="oci-state ${stateClass(data.state)}">
          <span class="oci-state-label">${esc(pulse.label || "Insufficient data")}</span>
          <span class="oci-state-arrow" aria-hidden="true">${stateArrow(data.state)}</span>
        </div>
        <div class="oci-pulse-score" title="Sum of component scores, range −6 to +6">
          Pulse score <strong>${Number.isFinite(pulse.score) ? signed(pulse.score, 0) : "—"}</strong>
        </div>
        <div class="oci-regimes">
          <span>Liquidity <strong class="${regimeClass(liquidity.regime)}">${esc(liquidity.regime || "—")}</strong></span>
          <span>Activity <strong class="${activityClass(data.activity)}">${esc(data.activity || "—")}</strong></span>
        </div>
      </div>

      <div class="oci-grid">
        <section class="oci-panel" aria-label="DeFi activity">
          <h3 class="oci-panel-title">DeFi Activity</h3>
          <div class="oci-table" role="table">
            <div class="oci-row oci-row-head" role="row">
              <span role="columnheader">Metric</span><span role="columnheader">Value</span>
              <span role="columnheader">24H</span><span role="columnheader">7D</span><span role="columnheader" aria-label="Trend"></span>
            </div>
            ${metricRow("Stablecoin Supply", m.stablecoins?.current, m.stablecoins?.change1d, m.stablecoins?.change7d, m.stablecoins?.trend)}
            ${metricRow("DeFi TVL", m.tvl?.current, m.tvl?.change1d, m.tvl?.change7d, m.tvl?.trend)}
            ${metricRow("DEX Volume 24H", m.dex?.volume24h, m.dex?.change1d, null, null)}
            ${metricRow("DEX Volume 7D", m.dex?.volume7d, null, m.dex?.change7d, m.dex?.trend)}
          </div>
          <div class="oci-subline">
            <span>Stablecoins 30D ${pctHtml(liquidity.change30d)}</span>
            <span>USDT share <strong>${Number.isFinite(m.stablecoins?.usdtShare) ? `${m.stablecoins.usdtShare.toFixed(1)}%` : "—"}</strong></span>
          </div>
        </section>

        <section class="oci-panel" aria-label="Chain activity">
          <h3 class="oci-panel-title">Chain Activity</h3>
          <div class="oci-table" role="table">
            <div class="oci-row oci-row-head" role="row">
              <span role="columnheader">Chain</span><span role="columnheader">TVL</span>
              <span role="columnheader">7D</span><span role="columnheader">DEX 24H</span><span role="columnheader" aria-label="Trend"></span>
            </div>
            ${(data.chains || []).map(chainRow).join("") || `<div class="empty-state">No chain data.</div>`}
          </div>
        </section>
      </div>

      <details class="oci-details">
        <summary>View details →</summary>
        ${detailsHtml(data)}
      </details>

      <div class="oci-footer">
        <span>Data: <a href="${esc(data.attribution?.url || "https://defillama.com")}" target="_blank" rel="noopener">${esc(data.attribution?.name || "DefiLlama")}</a> · free public API</span>
        <span title="${esc(data.dataAsOf || data.updatedAt || "")}">Data as of ${esc(timeAgo(data.dataAsOf || data.updatedAt))}</span>
      </div>`;
  }

  function metricRow(label, value, change1d, change7d, trend) {
    return `<div class="oci-row" role="row">
      <span role="cell">${esc(label)}</span>
      <strong role="cell">${usd(value)}</strong>
      <span role="cell">${pctHtml(change1d)}</span>
      <span role="cell">${pctHtml(change7d)}</span>
      <span role="cell" class="oci-arrow ${trendClass(trend)}" aria-label="${esc(trend || "no trend")}">${ARROWS[trend] || "—"}</span>
    </div>`;
  }

  function chainRow(row) {
    const carried = row.tvlCarried ? ` <span class="oci-carried" title="TVL refresh failed; showing previous value">*</span>` : "";
    return `<div class="oci-row" role="row">
      <span role="cell" title="${esc(row.name)}"><strong>${esc(row.id)}</strong></span>
      <strong role="cell">${usd(row.tvl)}${carried}</strong>
      <span role="cell">${pctHtml(row.tvlChange7d)}</span>
      <span role="cell">${usd(row.dexVolume24h)}</span>
      <span role="cell" class="oci-arrow ${trendClass(row.trend)}" aria-label="${esc(row.trend || "no trend")}">${ARROWS[row.trend] || "—"}</span>
    </div>`;
  }

  function detailsHtml(data) {
    const rules = data.rules || {};
    const components = data.pulse?.components || [];
    const sections = data.sections || {};
    const bands = (rules.pulse || [])
      .map((b) => `${esc(b.label)} ${b.min === null ? "below" : "≥ " + signed(b.min, 0)}`)
      .join(" · ");
    return `
      <div class="oci-detail-grid">
        <div>
          <h4>Pulse components</h4>
          ${components
            .map((c) => {
              const rule = rules.components?.[c.key] || {};
              return `<div class="oci-detail-row">
                <span>${esc(c.label)}</span>
                <span>${pctHtml(c.change)}</span>
                <span>score <strong>${c.score === null ? "—" : signed(c.score, 0)}</strong></span>
                <span class="oci-muted">±${rule.neutral}% = ±1, ±${rule.strong}% = ±2</span>
              </div>`;
            })
            .join("")}
          <p class="oci-muted">Bands: ${bands}. Needs at least ${esc(rules.minComponents ?? 2)} components.</p>
        </div>
        <div>
          <h4>Section status</h4>
          ${Object.entries(sections)
            .map(([name, status]) => `<div class="oci-detail-row"><span>${esc(sectionLabel(name))}</span><span class="oci-status-${esc(String(status).toLowerCase())}">${esc(status)}</span></div>`)
            .join("")}
          ${(data.errors || []).length ? `<p class="oci-muted">Last refresh issues: ${data.errors.map(esc).join("; ")}</p>` : ""}
          <p class="oci-muted">Liquidity regime uses stablecoin supply ${esc(data.liquidity?.basis || "7d")} change. Missing values show “—”, never zero.</p>
        </div>
      </div>`;
  }

  function sectionLabel(name) {
    return { tvl: "DeFi TVL", stablecoins: "Stablecoins", dex: "DEX volume", chains: "Chains" }[name] || name;
  }

  function usd(value) {
    const n = Number(value);
    if (value === null || value === undefined || !Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(abs >= 1e11 ? 0 : 1)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  }

  function pctHtml(value) {
    const n = Number(value);
    if (value === null || value === undefined || !Number.isFinite(n)) return `<span class="oci-muted">—</span>`;
    const cls = n > 0 ? "up" : n < 0 ? "down" : "flat";
    return `<span class="${cls}">${signed(n, 2)}%</span>`;
  }

  function signed(n, digits) {
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;
  }

  function stateClass(state) {
    return state === "EXPANDING" ? "oci-up" : state === "CONTRACTING" ? "oci-down" : "oci-neutral";
  }
  function stateArrow(state) {
    return state === "EXPANDING" ? "↑" : state === "CONTRACTING" ? "↓" : state === "NEUTRAL" ? "→" : "";
  }
  function regimeClass(regime) {
    return regime === "EXPANDING" ? "up" : regime === "CONTRACTING" ? "down" : "flat";
  }
  function activityClass(activity) {
    return activity === "RISING" ? "up" : activity === "FADING" ? "down" : "flat";
  }
  function trendClass(trend) {
    return trend === "up" ? "up" : trend === "down" ? "down" : trend === "flat" ? "flat" : "oci-muted";
  }

  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function init() {
    if (!$("ociBody")) return;
    load();
    setInterval(load, REFRESH_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
