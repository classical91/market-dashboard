(function () {
  "use strict";

  const REFRESH_INTERVAL_MS = 90_000;
  const DEFAULT_RANGE = "1W";
  const RANGES = ["1D", "1W", "1M", "3M"];

  const state = {
    data: null,
    range: DEFAULT_RANGE,
    search: "",
    loading: false,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    Object.assign(els, {
      source: $("terminalSource"),
      clock: $("terminalClock"),
      refresh: $("terminalRefresh"),
      search: $("terminalSearch"),
      banner: $("terminalBanner"),
      tape: $("terminalTape"),
      assetList: $("assetList"),
      assetCount: $("assetCount"),
      regimeLabel: $("regimeLabel"),
      regimeScore: $("regimeScore"),
      regimeSummary: $("regimeSummary"),
      regimeMiniCards: $("regimeMiniCards"),
      factorCount: $("factorCount"),
      confluenceRows: $("confluenceRows"),
      terminalThesis: $("terminalThesis"),
      indicatorList: $("indicatorList"),
      cryptoPulse: $("cryptoPulse"),
      cryptoLiveTag: $("cryptoLiveTag"),
      terminalNews: $("terminalNews"),
    });

    document.querySelectorAll(".terminal-range-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const nextRange = button.dataset.range;
        if (!RANGES.includes(nextRange)) return;
        state.range = nextRange;
        document.querySelectorAll(".terminal-range-btn").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        loadOverview();
      });
    });

    els.search.addEventListener("input", (event) => {
      state.search = event.target.value.trim().toLowerCase();
      renderAssetList();
    });

    els.refresh.addEventListener("click", loadOverview);

    renderLoading();
    updateClock();
    loadOverview();
    setInterval(updateClock, 1000);
    setInterval(loadOverview, REFRESH_INTERVAL_MS);
  }

  async function loadOverview() {
    if (state.loading) return;
    state.loading = true;
    els.refresh.disabled = true;

    try {
      const response = await fetch(`/api/overview?range=${encodeURIComponent(state.range)}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`API ${response.status}`);

      state.data = await response.json();
      renderAll();
    } catch (error) {
      els.banner.className = "terminal-banner show error";
      els.banner.innerHTML = `<strong>Terminal feed failed:</strong> ${escapeHtml(error.message)}. The page will recover on the next refresh.`;
      els.source.className = "terminal-pill terminal-error-dot";
      els.source.textContent = "Error";
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
    }
  }

  function renderAll() {
    const data = state.data;
    if (!data) return;

    renderSource(data);
    renderBanner(data);
    renderTape(data);
    renderAssetList();

    const confluence = buildConfluence(data);
    renderRegime(confluence, data);
    renderConfluenceRows(confluence);
    renderThesis(confluence, data);
    renderIndicators(data);
    renderCryptoPulse(data);
    renderNews(data);
  }

  function renderLoading() {
    els.source.textContent = "Loading";
    els.tape.innerHTML = `<span class="terminal-tape-item">Loading market tape…</span>`;
    els.assetList.innerHTML = loadingRows(8);
    els.confluenceRows.innerHTML = loadingTableRows(6);
    els.indicatorList.innerHTML = loadingRows(5);
    els.cryptoPulse.innerHTML = loadingCards(4);
    els.terminalNews.innerHTML = loadingRows(3);
  }

  function renderSource(data) {
    const dq = data.dataQuality || {};
    if (dq.live && !dq.partial) {
      els.source.className = "terminal-pill live-dot";
      els.source.textContent = "Server Live";
    } else if (dq.live) {
      els.source.className = "terminal-pill partial-dot";
      els.source.textContent = "Partial Live";
    } else {
      els.source.className = "terminal-pill fallback-dot";
      els.source.textContent = "Fallback Mode";
    }
    els.source.title = (dq.sources || []).join(", ") || "No live data providers detected";
  }

  function renderBanner(data) {
    const warnings = data.dataQuality?.warnings || [];
    if (!warnings.length) {
      els.banner.className = "terminal-banner";
      els.banner.innerHTML = "";
      return;
    }

    const trimmed = warnings.slice(0, 4);
    els.banner.className = "terminal-banner show";
    els.banner.innerHTML = `<strong>Data quality:</strong> ${trimmed.map(escapeHtml).join(" · ")}${warnings.length > trimmed.length ? " · …" : ""}`;
  }

  function renderTape(data) {
    const items = getAssets(data).slice(0, 14);
    if (!items.length) {
      els.tape.innerHTML = `<span class="terminal-tape-item">No tape data available.</span>`;
      return;
    }

    els.tape.innerHTML = [...items, ...items]
      .map((asset) => {
        const change = Number(asset.changePercent);
        const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
        return `<span class="terminal-tape-item"><strong>${escapeHtml(asset.symbol)}</strong> ${formatLast(asset)} <em class="${cls}">${formatPercent(change)}</em></span>`;
      })
      .join("");
  }

  function renderAssetList() {
    const data = state.data;
    if (!data) return;

    const query = state.search;
    const rows = getAssets(data).filter((asset) => {
      if (!query) return true;
      return [asset.symbol, asset.name, asset.type].some((part) => String(part || "").toLowerCase().includes(query));
    });

    els.assetCount.textContent = `${rows.length} assets`;

    if (!rows.length) {
      els.assetList.innerHTML = `<div class="terminal-empty">No matching assets.</div>`;
      return;
    }

    els.assetList.innerHTML = rows
      .slice(0, 18)
      .map((asset) => {
        const change = Number(asset.changePercent);
        const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
        return `<button class="terminal-asset-row" type="button" title="${escapeAttr(asset.name || asset.symbol)}">
          <span>
            <strong>${escapeHtml(asset.symbol)}</strong>
            <small>${escapeHtml(asset.name || asset.type || "Market")}</small>
          </span>
          <span class="terminal-last">${formatLast(asset)}</span>
          <em class="${cls}">${formatPercent(change)}</em>
        </button>`;
      })
      .join("");
  }

  function renderRegime(confluence, data) {
    els.regimeLabel.textContent = confluence.label;
    els.regimeLabel.className = confluence.className;
    els.regimeScore.textContent = confluence.score;
    els.regimeSummary.textContent = confluence.summary;

    const miniCards = [
      { label: "Confidence", value: `${confluence.confidence}%`, note: `${state.range} read` },
      { label: "BTC Pulse", value: assetChange(data, "BTC"), note: "24h crypto" },
      { label: "Dollar", value: assetChange(data, "DXY"), note: "DXY pressure" },
      { label: "Volatility", value: assetValue(data, "VIX"), note: "VIX level" },
    ];

    els.regimeMiniCards.innerHTML = miniCards
      .map((card) => `<div class="terminal-micro-card">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.value)}</strong>
        <small>${escapeHtml(card.note)}</small>
      </div>`)
      .join("");
  }

  function renderConfluenceRows(confluence) {
    els.factorCount.textContent = `${confluence.factors.length} factors`;
    els.confluenceRows.innerHTML = confluence.factors
      .map((factor) => `<tr>
        <td><strong>${escapeHtml(factor.label)}</strong><small>${escapeHtml(factor.subLabel)}</small></td>
        <td>${escapeHtml(factor.reading)}<small>${escapeHtml(factor.note)}</small></td>
        <td><span class="terminal-bias ${factor.bias.toLowerCase()}">${escapeHtml(factor.bias)}</span></td>
        <td><strong>${factor.points}</strong><small>/5</small></td>
      </tr>`)
      .join("");
  }

  function renderThesis(confluence, data) {
    const leading = confluence.factors
      .filter((factor) => factor.points >= 4)
      .map((factor) => factor.label)
      .slice(0, 3);
    const drag = confluence.factors
      .filter((factor) => factor.points <= 2)
      .map((factor) => factor.label)
      .slice(0, 2);

    const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "now";
    els.terminalThesis.innerHTML = `
      <p><strong>${escapeHtml(confluence.label)}</strong> at ${escapeHtml(String(confluence.score))}/30. Supportive inputs: ${escapeHtml(leading.join(", ") || "none yet")}.</p>
      <p>${drag.length ? `Main drag: ${escapeHtml(drag.join(", "))}.` : "No major drag factor is flashing red."} Last refresh ${escapeHtml(updated)}.</p>
      <p class="terminal-small-note">Use this as a fast dashboard read, not a standalone trade signal. Confirm structure on TradingView before acting.</p>`;
  }

  function renderIndicators(data) {
    const calendar = Array.isArray(data.calendar) ? data.calendar : [];
    const events = calendar.slice(0, 5);
    const macroRows = [
      { label: "Dollar Index", value: assetValue(data, "DXY"), detail: assetChange(data, "DXY") },
      { label: "Volatility Index", value: assetValue(data, "VIX"), detail: assetChange(data, "VIX") },
      { label: "Gold", value: assetValue(data, "XAU"), detail: assetChange(data, "XAU") },
      { label: "Crude Oil", value: assetValue(data, "WTI"), detail: assetChange(data, "WTI") },
    ];

    const macroHtml = macroRows
      .map((row) => `<div class="terminal-indicator-row">
        <span><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.detail)}</small></span>
        <em>${escapeHtml(row.value)}</em>
      </div>`)
      .join("");

    const calendarHtml = events.length
      ? events.map((event) => `<div class="terminal-event-row">
          <span class="terminal-event-time">${escapeHtml(event.time || "--")}</span>
          <span>${escapeHtml(event.title || "Market event")}</span>
          <em class="impact-${escapeHtml(String(event.impact || "low").toLowerCase())}">${escapeHtml(event.impact || "Low")}</em>
        </div>`).join("")
      : `<div class="terminal-empty">No macro calendar events configured.</div>`;

    els.indicatorList.innerHTML = macroHtml + `<div class="terminal-divider"></div>` + calendarHtml;
  }

  function renderCryptoPulse(data) {
    const allocation = data.allocation?.segments || [];
    const btcDom = allocation.find((entry) => String(entry.label).toUpperCase() === "BTC")?.percent;
    const ethDom = allocation.find((entry) => String(entry.label).toUpperCase() === "ETH")?.percent;
    const cards = [
      { label: "BTC", value: assetValue(data, "BTC"), note: assetChange(data, "BTC") },
      { label: "ETH", value: assetValue(data, "ETH"), note: assetChange(data, "ETH") },
      { label: "BTC Dom", value: btcDom != null ? `${Number(btcDom).toFixed(2)}%` : "—", note: "market share" },
      { label: "ETH Dom", value: ethDom != null ? `${Number(ethDom).toFixed(2)}%` : "—", note: "market share" },
    ];

    els.cryptoLiveTag.textContent = data.dataQuality?.live ? "Live" : "Fallback";
    els.cryptoPulse.innerHTML = cards
      .map((card) => `<div class="terminal-crypto-card">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.value)}</strong>
        <small>${escapeHtml(card.note)}</small>
      </div>`)
      .join("");
  }

  function renderNews(data) {
    const news = Array.isArray(data.news) ? data.news.slice(0, 4) : [];
    if (!news.length) {
      els.terminalNews.innerHTML = `<div class="terminal-empty">No news feed configured.</div>`;
      return;
    }

    els.terminalNews.innerHTML = news
      .map((item) => {
        const meta = [item.source, item.publishedAt ? timeAgo(item.publishedAt) : "fallback"].filter(Boolean).join(" · ");
        const inner = `<strong>${escapeHtml(item.title || "Market headline")}</strong><small>${escapeHtml(meta)}</small>`;
        return item.url
          ? `<a class="terminal-news-item" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${inner}</a>`
          : `<div class="terminal-news-item">${inner}</div>`;
      })
      .join("");
  }

  function buildConfluence(data) {
    const dxy = getAsset(data, "DXY");
    const vix = getAsset(data, "VIX");
    const gold = getAsset(data, "XAU");
    const oil = getAsset(data, "WTI");
    const spy = getAsset(data, "SPY");
    const qqq = getAsset(data, "QQQ");
    const btc = getAsset(data, "BTC");
    const eth = getAsset(data, "ETH");

    const dxyChange = changeNum(dxy);
    const vixChange = changeNum(vix);
    const vixLevel = Number(vix?.price);
    const equityAvg = avg([changeNum(spy), changeNum(qqq)]);
    const cryptoAvg = avg([changeNum(btc), changeNum(eth)]);
    const goldChange = changeNum(gold);
    const oilChange = changeNum(oil);
    const highImpactEvents = (data.calendar || []).filter((event) => /^high/i.test(event.impact || "")).length;

    const factors = [
      buildFactor({
        label: "Dollar (DXY)",
        subLabel: "USD pressure",
        reading: dxy ? `${formatLast(dxy)} (${formatPercent(dxyChange)})` : "No DXY row",
        note: dxyChange <= 0 ? "Dollar softening supports risk." : "Dollar strength can pressure crypto/equities.",
        rawScore: dxyChange <= -0.4 ? 5 : dxyChange <= 0 ? 4 : dxyChange < 0.5 ? 2 : 1,
      }),
      buildFactor({
        label: "Volatility (VIX)",
        subLabel: "market stress",
        reading: vix ? `${formatLast(vix)} (${formatPercent(vixChange)})` : "No VIX row",
        note: vixLevel && vixLevel < 20 && vixChange <= 0 ? "Calm volatility backdrop." : "Volatility is not fully relaxed.",
        rawScore: vixLevel && vixLevel < 18 && vixChange <= 0 ? 5 : vixLevel && vixLevel < 22 ? 4 : vixLevel && vixLevel < 28 ? 2 : 1,
      }),
      buildFactor({
        label: "Equity Breadth",
        subLabel: "SPY + QQQ tape",
        reading: `Avg ${formatPercent(equityAvg)}`,
        note: equityAvg >= 0 ? "Equities are confirming risk appetite." : "Equities are dragging the read.",
        rawScore: equityAvg >= 0.7 ? 5 : equityAvg >= 0 ? 4 : equityAvg > -0.7 ? 2 : 1,
      }),
      buildFactor({
        label: "Crypto Impulse",
        subLabel: "BTC + ETH",
        reading: `Avg ${formatPercent(cryptoAvg)}`,
        note: cryptoAvg >= 0 ? "Major crypto is bid." : "Major crypto momentum is negative.",
        rawScore: cryptoAvg >= 3 ? 5 : cryptoAvg >= 0 ? 4 : cryptoAvg > -3 ? 2 : 1,
      }),
      buildFactor({
        label: "Commodities",
        subLabel: "gold / oil balance",
        reading: `Au ${formatPercent(goldChange)} · Oil ${formatPercent(oilChange)}`,
        note: oilChange <= 0 ? "Oil pressure is easing inflation impulse." : "Oil bid can complicate the macro tape.",
        rawScore: oilChange <= -0.8 && goldChange <= 0.8 ? 5 : oilChange <= 0.5 ? 4 : oilChange < 1.5 ? 2 : 1,
      }),
      buildFactor({
        label: "Calendar Risk",
        subLabel: "scheduled catalysts",
        reading: `${highImpactEvents} high-impact event${highImpactEvents === 1 ? "" : "s"}`,
        note: highImpactEvents ? "Event risk can override clean signals." : "No major scheduled catalyst in the feed.",
        rawScore: highImpactEvents === 0 ? 5 : highImpactEvents <= 1 ? 4 : highImpactEvents <= 3 ? 2 : 1,
      }),
    ];

    const score = factors.reduce((sum, factor) => sum + factor.points, 0);
    const confidence = Math.round((score / 30) * 100);
    const label = score >= 21 ? "RISK-ON" : score <= 12 ? "RISK-OFF" : "MIXED / NEUTRAL";
    const className = score >= 21 ? "risk-on" : score <= 12 ? "risk-off" : "risk-mixed";
    const supportive = factors.filter((factor) => factor.points >= 4).length;
    const bearish = factors.filter((factor) => factor.points <= 2).length;

    return {
      factors,
      score,
      confidence,
      label,
      className,
      summary: `${supportive} supportive factor${supportive === 1 ? "" : "s"}, ${bearish} drag factor${bearish === 1 ? "" : "s"}. Built from dollar, volatility, equities, crypto impulse, commodities, and catalyst risk.`,
    };
  }

  function buildFactor({ label, subLabel, reading, note, rawScore }) {
    const points = Math.max(1, Math.min(5, Number(rawScore) || 3));
    const bias = points >= 4 ? "Bullish" : points <= 2 ? "Bearish" : "Neutral";
    return { label, subLabel, reading, note, points, bias };
  }

  function getAssets(data) {
    return (Array.isArray(data.watchlist) && data.watchlist.length ? data.watchlist : data.ticker || []).map((asset) => ({
      ...asset,
      symbol: String(asset.symbol || "").toUpperCase(),
    }));
  }

  function getAsset(data, symbol) {
    const target = String(symbol).toUpperCase();
    return getAssets(data).find((asset) => String(asset.symbol || "").toUpperCase() === target);
  }

  function changeNum(asset) {
    const value = Number(asset?.changePercent);
    return Number.isFinite(value) ? value : 0;
  }

  function avg(values) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length) return 0;
    return clean.reduce((sum, value) => sum + value, 0) / clean.length;
  }

  function assetValue(data, symbol) {
    const asset = getAsset(data, symbol);
    return asset ? formatLast(asset) : "—";
  }

  function assetChange(data, symbol) {
    const asset = getAsset(data, symbol);
    return asset ? formatPercent(changeNum(asset)) : "—";
  }

  function formatLast(asset) {
    const n = Number(asset?.price);
    if (!Number.isFinite(n)) return "—";
    const symbol = String(asset.symbol || "").toUpperCase();
    const moneySymbols = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SPY", "QQQ", "NVDA", "TSLA", "XAU", "WTI"]);
    const options = n >= 1000 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    const formatted = n.toLocaleString(undefined, options);
    return moneySymbols.has(symbol) ? `$${formatted}` : formatted;
  }

  function formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
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

  function updateClock() {
    els.clock.textContent = `UTC ${new Date().toISOString().slice(11, 19)}`;
  }

  function loadingRows(count) {
    return Array.from({ length: count })
      .map(() => `<div class="terminal-loading-row"><span></span><em></em></div>`)
      .join("");
  }

  function loadingTableRows(count) {
    return Array.from({ length: count })
      .map(() => `<tr><td colspan="4"><div class="terminal-loading-row"><span></span><em></em></div></td></tr>`)
      .join("");
  }

  function loadingCards(count) {
    return Array.from({ length: count })
      .map(() => `<div class="terminal-crypto-card loading"><span></span><strong></strong><small></small></div>`)
      .join("");
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

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
