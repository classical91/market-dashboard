(function () {
  "use strict";

  const REFRESH_INTERVAL_MS = 90_000;

  const state = {
    range: "1D",
    overview: null,
    loading: false,
    error: null,
  };

  // Standard session hours in UTC (not adjusted for daylight saving).
  const TRADING_SESSIONS = [
    { name: "Sydney", open: 22, close: 7 },
    { name: "Tokyo", open: 0, close: 9 },
    { name: "London", open: 8, close: 17 },
    { name: "New York", open: 13, close: 22 },
  ];

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function ui() {
    return window.MarketUI || {
      emptyState: (title) => `<div class="empty-state">${escapeHtml(title)}</div>`,
      errorState: (title, detail) => `<div class="empty-state">${escapeHtml(title)} ${escapeHtml(detail || "")}</div>`,
      skeletonCard: () => '<article class="card kpi"><div class="empty-state">Loading...</div></article>',
    };
  }

  function init() {
    Object.assign(els, {
      banner: $("statusBanner"),
      sourceBadge: $("sourceBadge"),
      lastUpdated: $("lastUpdated"),
      clock: $("clock"),
      refresh: $("refreshBtn"),
      session: $("sessionIndicator"),
      ticker: $("tickerTrack"),
      kpiGrid: $("kpiGrid"),
      pulseStatus: $("pulseStatus"),
      pulseVolatility: $("pulseVolatility"),
      pulseChange: $("pulseChange"),
      heatmap: $("heatmap"),
      watchlistBody: $("watchlistBody"),
      riskBox: $("riskBox"),
      alerts: $("alertsFeed"),
      calendar: $("calendarList"),
      news: $("newsFeed"),
      chart: $("marketChart"),
    });

    document.querySelectorAll(".tf").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tf").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.range = btn.dataset.range;
        loadOverview();
      }),
    );

    els.refresh.addEventListener("click", () => loadOverview());

    renderDashboardLoading();
    loadOverview();
    setInterval(loadOverview, REFRESH_INTERVAL_MS);
    setInterval(updateClock, 1000);
    setInterval(updateSession, 60_000);
    updateClock();
    updateSession();
  }

  async function loadOverview() {
    if (state.loading) return;
    state.loading = true;
    els.refresh.disabled = true;
    try {
      const response = await fetch(`/api/overview?range=${encodeURIComponent(state.range)}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`API ${response.status}`);
      }
      const payload = await response.json();
      state.overview = payload;
      state.error = null;
      renderAll();
    } catch (error) {
      state.error = error;
      renderError(error.message);
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
    }
  }

  function renderAll() {
    const data = state.overview;
    if (!data) return;
    renderBanner(data);
    renderSourceBadge(data);
    renderLastUpdated(data);
    renderTicker(data);
    renderKpis(data);
    renderPulse(data);
    renderHeatmap(data);
    renderWatchlist();
    renderRiskBox(data);
    renderAlerts(data);
    renderCalendar(data);
    renderNews(data);
    drawChart(data);
  }

  function renderBanner(data) {
    const dq = data.dataQuality || {};
    const warnings = Array.isArray(dq.warnings) ? dq.warnings : [];
    if (!warnings.length && dq.live) {
      els.banner.classList.remove("show", "warning", "error");
      els.banner.innerHTML = "";
      return;
    }
    const cls = dq.live ? "warning" : "error";
    els.banner.className = `banner show ${cls}`;
    const headline = dq.live
      ? "Some sections are using fallback data — figures tagged “Fallback” are not live."
      : "⚠ Sample fallback data — these are NOT live market prices. Do not trade on them.";
    els.banner.innerHTML = `<strong>${headline}</strong>${
      warnings.length ? `<ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""
    }`;
  }

  function renderSourceBadge(data) {
    const dq = data.dataQuality || {};
    if (dq.live && !dq.partial) {
      els.sourceBadge.className = "chip live";
      els.sourceBadge.textContent = "● Live";
    } else if (dq.live) {
      els.sourceBadge.className = "chip fallback";
      els.sourceBadge.textContent = "● Partial";
    } else {
      els.sourceBadge.className = "chip fallback";
      els.sourceBadge.textContent = "● Fallback";
    }
    els.sourceBadge.title = (dq.sources || []).join(", ") || "no live sources";
  }

  function renderLastUpdated(data) {
    if (!data.updatedAt) {
      els.lastUpdated.textContent = "";
      return;
    }
    const updated = new Date(data.updatedAt);
    els.lastUpdated.textContent = `Updated ${updated.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;
  }

  function renderTicker(data) {
    const items = data.ticker || [];
    if (!items.length) {
      els.ticker.innerHTML = `<div class="ticker-item">No ticker data available.</div>`;
      return;
    }
    const doubled = [...items, ...items];
    els.ticker.innerHTML = doubled
      .map(
        (s) =>
          `<div class="ticker-item"><strong>${escapeHtml(s.symbol)}</strong><span>${money(s.price)}</span>${pct(s.changePercent)}</div>`,
      )
      .join("");
  }

  function renderKpis(data) {
    const kpis = data.kpis || [];
    if (!kpis.length) {
      els.kpiGrid.innerHTML = `<div class="card kpi">${ui().emptyState("No KPI data", "The overview API returned no key metrics.")}</div>`;
      return;
    }
    els.kpiGrid.innerHTML = kpis
      .map((k) => {
        const change = Number(k.changePercent);
        const cls = Number.isFinite(change) && change !== 0 ? (change > 0 ? "up" : "down") : "flat";
        const changeText = Number.isFinite(change) && change !== 0 ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%` : "—";
        return `<article class="card kpi">
          <div class="kpi-top"><span>${escapeHtml(k.label)}</span><span class="${cls}">${changeText}</span></div>
          <div class="kpi-value">${escapeHtml(String(k.value))}</div>
          <div class="kpi-bottom"><span>${escapeHtml(k.note || "")}</span><span>${data.dataQuality?.live ? "Live" : "Sample · not live"}</span></div>
        </article>`;
      })
      .join("");
  }

  function renderPulse(data) {
    const status = data.marketStatus || {};
    els.pulseStatus.textContent = status.label || "—";
    els.pulseStatus.className = status.label === "Risk-On" ? "up" : status.label === "Risk-Off" ? "down" : "flat";
    els.pulseVolatility.textContent = status.volatilityLabel || "—";
    els.pulseVolatility.className = status.volatilityLabel === "High" ? "down" : "flat";
    const change = Number(data.marketPulse?.changePercent || 0);
    els.pulseChange.textContent = `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
    els.pulseChange.className = change > 0 ? "up" : change < 0 ? "down" : "flat";
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

  function renderWatchlist() {
    const data = state.overview;
    if (!data) return;
    const rows = data.watchlist || [];
    if (!rows.length) {
      els.watchlistBody.innerHTML = `<tr><td colspan="4">${ui().emptyState("No watchlist data", "Symbols will appear once the feed loads.")}</td></tr>`;
      return;
    }
    els.watchlistBody.innerHTML = rows
      .map(
        (s) => `
        <tr>
          <td><span class="symbol-pill"><span class="asset-dot ${escapeHtml(s.type || "")}"></span>
            <span><strong>${escapeHtml(s.symbol)}</strong><br>${escapeHtml(s.name || "")}</span></span></td>
          <td>${money(s.price)}</td>
          <td>${pct(s.changePercent)}</td>
          <td>${escapeHtml(String(s.volume || "-"))}</td>
        </tr>`,
      )
      .join("");
  }

  function renderRiskBox(data) {
    const factors = data.riskFactors || [];
    const score = data.marketStatus?.riskScore ?? 50;
    els.riskBox.innerHTML = `
      <div class="gauge" role="img" aria-label="Risk score ${score}">
        <div class="gauge-value">${score}<small>Risk Score</small></div>
      </div>
      <div class="risk-list">
        ${factors
          .map(
            (f) => `
          <div>
            <div class="risk-item"><span>${escapeHtml(f.label)}</span><strong>${Math.round(f.value)}%</strong></div>
            <div class="progress"><span style="width:${Math.max(0, Math.min(100, f.value))}%"></span></div>
          </div>`,
          )
          .join("")}
      </div>`;
  }

  function renderAlerts(data) {
    const alerts = data.alerts || [];
    if (!alerts.length) {
      els.alerts.innerHTML = ui().emptyState("No active alerts", "Live alert conditions are quiet right now.");
      return;
    }
    els.alerts.innerHTML = alerts
      .map(
        (a) => `
        <div class="feed-item severity-${escapeHtml(a.severity || "low")}">
          <h4>${escapeHtml(a.title)}</h4>
          <div class="feed-meta">
            <span>${escapeHtml(a.category || "")}</span>
            <span class="${a.status === "Triggered" ? "up" : a.status === "Watching" ? "flat" : ""}">${escapeHtml(a.status || "")}</span>
          </div>
        </div>`,
      )
      .join("");
  }

  function renderCalendar(data) {
    const events = data.calendar || [];
    if (!events.length) {
      els.calendar.innerHTML = ui().emptyState("No scheduled events", "Macro events will appear here when configured.");
      return;
    }
    els.calendar.innerHTML = events
      .map((e) => {
        const impactCls = e.impact?.toLowerCase().startsWith("h")
          ? "high"
          : e.impact?.toLowerCase().startsWith("m")
            ? "med"
            : "low";
        return `<div class="event">
          <div class="event-time">${escapeHtml(e.time || "")}</div>
          <div>${escapeHtml(e.title || "")}</div>
          <div class="impact ${impactCls}">${escapeHtml(e.impact || "")}</div>
        </div>`;
      })
      .join("");
  }

  function renderNews(data) {
    const news = data.news || [];
    if (!news.length) {
      els.news.innerHTML = ui().emptyState("No news available", "Connect MARKET_NEWS_URL for live headlines.");
      return;
    }
    els.news.innerHTML = news
      .map((n) => {
        const time = n.publishedAt ? timeAgo(n.publishedAt) : "";
        const inner = `
          <h4>${escapeHtml(n.title || "")}</h4>
          <div class="feed-meta"><span>${escapeHtml(n.source || "")}</span><span>${escapeHtml(time)}</span></div>`;
        return n.url
          ? `<a class="feed-item" href="${escapeAttr(n.url)}" target="_blank" rel="noopener">${inner}</a>`
          : `<div class="feed-item">${inner}</div>`;
      })
      .join("");
  }

  function drawChart(data) {
    const points = data.marketPulse?.points || [];
    const canvas = els.chart;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const pad = 34;
    ctx.clearRect(0, 0, W, H);

    if (!points.length) {
      ctx.fillStyle = "rgba(237,243,255,0.5)";
      ctx.font = "14px system-ui";
      ctx.fillText("No chart data available.", pad, H / 2);
      return;
    }

    const values = points.map((p) => p.value);
    const min = Math.min(...values) - 0.5;
    const max = Math.max(...values) + 0.5;
    const pts = values.map((v, i) => ({
      x: pad + (i / Math.max(1, values.length - 1)) * (W - pad * 2),
      y: H - pad - ((v - min) / Math.max(0.0001, max - min)) * (H - pad * 2),
    }));

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = pad + i * ((H - pad * 2) / 4);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(W - pad, y);
      ctx.stroke();
    }

    const grad = ctx.createLinearGradient(0, pad, 0, H - pad);
    grad.addColorStop(0, "rgba(77,163,255,0.34)");
    grad.addColorStop(1, "rgba(77,163,255,0)");
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.lineTo(pts[pts.length - 1].x, H - pad);
    ctx.lineTo(pts[0].x, H - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = "#4da3ff";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    ctx.fillStyle = "rgba(237,243,255,0.72)";
    ctx.font = "13px system-ui";
    ctx.fillText(`${data.range || state.range} BTC Composite`, pad, 24);

    const change = data.marketPulse?.changePercent || 0;
    ctx.fillStyle = change >= 0 ? "#00e396" : "#ff4d6d";
    ctx.font = "bold 26px system-ui";
    ctx.fillText(`${change >= 0 ? "+" : ""}${Number(change).toFixed(2)}%`, W - 150, 32);
  }

  function renderDashboardLoading() {
    els.kpiGrid.innerHTML = Array.from({ length: 4 })
      .map(() => ui().skeletonCard(3))
      .join("");
    els.ticker.innerHTML = `<div class="ticker-item"><span class="skeleton">Loading market data...</span></div>`;
    els.watchlistBody.innerHTML = `<tr><td colspan="4">${ui().emptyState("Loading watchlist", "Fetching current market rows.")}</td></tr>`;
    els.heatmap.innerHTML = ui().emptyState("Loading heatmap", "Preparing the asset performance scan.");
    els.alerts.innerHTML = ui().emptyState("Loading alerts", "Checking live conditions.");
    els.calendar.innerHTML = ui().emptyState("Loading calendar", "Preparing upcoming market events.");
    els.news.innerHTML = ui().emptyState("Loading news", "Fetching market headlines.");
  }

  function renderSkeletons() {
    els.kpiGrid.innerHTML = Array.from({ length: 4 })
      .map(
        () => `
        <article class="card kpi">
          <div class="kpi-top"><span class="skeleton">loading</span></div>
          <div class="kpi-value skeleton">$0,000</div>
          <div class="kpi-bottom"><span class="skeleton">loading</span></div>
        </article>`,
      )
      .join("");
    els.ticker.innerHTML = `<div class="ticker-item"><span class="skeleton">Loading market data…</span></div>`;
    els.watchlistBody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Loading…</div></td></tr>`;
    els.heatmap.innerHTML = `<div class="empty-state">Loading heatmap…</div>`;
    els.alerts.innerHTML = `<div class="empty-state">Loading alerts…</div>`;
    els.calendar.innerHTML = `<div class="empty-state">Loading calendar…</div>`;
    els.news.innerHTML = `<div class="empty-state">Loading news…</div>`;
  }

  function renderError(message) {
    els.banner.className = "banner show error";
    els.banner.innerHTML = `<strong>Overview API failed:</strong> ${escapeHtml(message)}. Showing last cached data if available.`;
    els.sourceBadge.className = "chip error";
    els.sourceBadge.textContent = "● Error";
  }

  function updateClock() {
    els.clock.textContent = new Date().toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function inSessionWindow(hour, open, close) {
    // Sessions that wrap past midnight (e.g. Sydney 22:00-07:00) need the
    // OR form; same-day sessions need the AND form.
    return open < close ? hour >= open && hour < close : hour >= open || hour < close;
  }

  function isWeekendClose(day, hour) {
    // The forex week runs Sunday 22:00 UTC (Sydney open) to Friday 22:00 UTC
    // (New York close).
    if (day === 6) return true;
    if (day === 0 && hour < 22) return true;
    if (day === 5 && hour >= 22) return true;
    return false;
  }

  function updateSession() {
    if (!els.session) return;
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60;

    if (isWeekendClose(day, hour)) {
      els.session.className = "chip fallback";
      els.session.textContent = "● Markets Closed — Weekend";
      return;
    }

    // Sydney, Tokyo, London, and New York together span all 24 hours, so
    // outside the weekend close at least one session is always open.
    const open = TRADING_SESSIONS.filter((s) => inSessionWindow(hour, s.open, s.close));
    els.session.className = "chip live";
    els.session.textContent = `● ${open.map((s) => s.name).join(" + ")} Session${open.length > 1 ? " (Overlap)" : ""}`;
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  }

  function pct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return `<span class="flat">—</span>`;
    const cls = n > 0 ? "up" : n < 0 ? "down" : "flat";
    const sign = n > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${n.toFixed(2)}%</span>`;
  }

  function heatColor(v) {
    const intensity = Math.min(Math.abs(v) / 4, 1);
    return v >= 0
      ? `rgba(0,227,150,${0.18 + intensity * 0.58})`
      : `rgba(255,77,109,${0.18 + intensity * 0.58})`;
  }

  function timeAgo(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const diff = Date.now() - then;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
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

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
