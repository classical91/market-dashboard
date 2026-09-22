(function () {
  "use strict";

  // The Market Heatmap moved here from Overview. It reads the same
  // /api/overview payload, so it stays in step with the Overview page.
  const REFRESH_INTERVAL_MS = 90_000;

  const state = { loading: false };
  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function ui() {
    return window.MarketUI || {
      emptyState: (title) => `<div class="empty-state">${escapeHtml(title)}</div>`,
    };
  }

  function init() {
    Object.assign(els, {
      banner: $("statusBanner"),
      sourceBadge: $("sourceBadge"),
      heatmap: $("heatmap"),
    });

    els.heatmap.innerHTML = ui().emptyState("Loading heatmap", "Preparing the asset performance scan.");
    loadHeatmap();
    setInterval(loadHeatmap, REFRESH_INTERVAL_MS);
  }

  async function loadHeatmap() {
    if (state.loading) return;
    state.loading = true;
    try {
      const response = await fetch("/api/overview?range=1D", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const data = await response.json();
      renderSourceBadge(data);
      renderHeatmap(data);
      els.banner.classList.remove("show", "warning", "error");
      els.banner.innerHTML = "";
    } catch (error) {
      els.banner.className = "banner show error";
      els.banner.innerHTML = `<strong>Heatmap data failed:</strong> ${escapeHtml(error.message)}. The TradingView heatmaps below are unaffected.`;
      els.sourceBadge.className = "chip error";
      els.sourceBadge.textContent = "● Error";
      if (!els.heatmap.querySelector(".heat-tile")) {
        els.heatmap.innerHTML = ui().emptyState("Heatmap unavailable", "Asset performance tiles will appear once the feed recovers.");
      }
    } finally {
      state.loading = false;
    }
  }

  function renderSourceBadge(data) {
    // Same wording as the Overview chip.
    const dq = data.dataQuality || {};
    els.sourceBadge.className = dq.live && !dq.partial ? "chip live" : "chip fallback";
    els.sourceBadge.textContent = dq.live ? (dq.partial ? "● Partial" : "● Live") : "● Fallback";
    els.sourceBadge.title = (dq.sources || []).join(", ") || "no live sources";
  }

  function renderHeatmap(data) {
    const tiles = data.heatmap || [];
    if (!tiles.length) {
      els.heatmap.innerHTML = ui().emptyState("No heatmap data", "Asset performance tiles will appear after data loads.");
      return;
    }
    els.heatmap.innerHTML = tiles
      .map((d) => {
        const change = Number(d.value) || 0;
        return `<div class="heat-tile" style="background:${heatColor(change)}">
          <strong>${escapeHtml(d.label)}</strong>
          <span>${change > 0 ? "+" : ""}${change.toFixed(2)}%</span>
          <small>${escapeHtml(d.category || "")}</small>
        </div>`;
      })
      .join("");
  }

  function heatColor(v) {
    const intensity = Math.min(Math.abs(v) / 4, 1);
    return v >= 0
      ? `rgba(0,227,150,${0.18 + intensity * 0.58})`
      : `rgba(255,77,109,${0.18 + intensity * 0.58})`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
