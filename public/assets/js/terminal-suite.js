(function () {
  "use strict";

  const REFRESH_INTERVAL_MS = 90_000;
  const DEFAULT_RANGE = "1W";
  const RANGES = ["1D", "1W", "1M", "3M"];

  // Presets re-weight the confluence factors and re-order the asset monitor
  // for a specific workflow. Weights multiply each factor's 1-5 points; the
  // total is normalized back to /30 so the regime scale stays comparable.
  const PRESETS = {
    default: {
      label: "Trader Default",
      weights: { dxy: 1.25, vix: 1.2, equities: 1.0, crypto: 1.3, commodities: 0.75, calendar: 1.1 },
      priority: [],
      typeOrder: null,
    },
    cryptoRisk: {
      label: "Crypto Risk",
      weights: { dxy: 1.25, vix: 1.1, equities: 0.8, crypto: 1.6, commodities: 0.5, calendar: 1.0 },
      priority: ["BTC", "ETH", "SOL", "DXY"],
      typeOrder: ["crypto", "macro", "equity"],
    },
    macroRisk: {
      label: "Macro Risk",
      weights: { dxy: 1.5, vix: 1.4, equities: 1.0, crypto: 0.7, commodities: 1.2, calendar: 1.4 },
      priority: ["DXY", "VIX", "XAU", "WTI"],
      typeOrder: ["macro", "equity", "crypto"],
    },
    equitiesRisk: {
      label: "Equities Risk",
      weights: { dxy: 1.2, vix: 1.5, equities: 1.6, crypto: 0.6, commodities: 0.8, calendar: 1.2 },
      priority: ["SPY", "QQQ", "NVDA", "TSLA", "VIX"],
      typeOrder: ["equity", "macro", "crypto"],
    },
    btcSetup: {
      label: "BTC Setup",
      weights: { dxy: 1.4, vix: 1.1, equities: 0.9, crypto: 1.7, commodities: 0.5, calendar: 1.1 },
      priority: ["BTC", "DXY", "VIX", "QQQ", "ETH"],
      typeOrder: null,
    },
    fedDay: {
      label: "Fed Day",
      weights: { dxy: 1.4, vix: 1.5, equities: 1.1, crypto: 0.9, commodities: 0.9, calendar: 1.7 },
      priority: ["DXY", "VIX", "SPY", "QQQ", "XAU", "BTC"],
      typeOrder: ["macro", "equity", "crypto"],
    },
    altRotation: {
      label: "Altcoin Rotation",
      weights: { dxy: 1.1, vix: 0.9, equities: 0.7, crypto: 1.7, commodities: 0.4, calendar: 0.9 },
      priority: ["SOL", "AVAX", "ADA", "DOGE", "XRP", "ETH", "BTC"],
      typeOrder: ["crypto", "equity", "macro"],
    },
  };

  const MODULE_CARDS = [
    { key: "crypto", label: "Crypto" },
    { key: "equities", label: "Equities" },
    { key: "macro", label: "Macro/FX" },
    { key: "news", label: "News" },
    { key: "calendar", label: "Calendar" },
    { key: "onchain", label: "On-Chain" },
  ];

  const MODULE_STATUS_META = {
    live: { label: "Live", tone: "good" },
    full: { label: "Full", tone: "good" },
    delayed: { label: "Delayed", tone: "warn" },
    limited: { label: "Etherscan", tone: "warn" },
    "defillama-only": { label: "DefiLlama", tone: "warn" },
    fallback: { label: "Fallback", tone: "bad" },
    paused: { label: "Paused", tone: "bad" },
    unavailable: { label: "Off", tone: "bad" },
  };

  // Map warning strings back to the module they describe, so the health cards
  // can carry the detail in tooltips and only unmatched warnings hit the banner.
  const MODULE_WARNING_PATTERNS = {
    crypto: /^(crypto prices|market pulse|crypto allocation)/i,
    equities: /^equities/i,
    macro: /^macro\/fx/i,
    news: /^news feed/i,
    calendar: /^macro calendar/i,
    onchain: /on-chain|covalent|defillama|etherscan|stablecoin netflow still live/i,
  };

  const TRADINGVIEW_SYMBOLS = {
    BTC: "BINANCE:BTCUSDT",
    ETH: "BINANCE:ETHUSDT",
    SOL: "BINANCE:SOLUSDT",
    BNB: "BINANCE:BNBUSDT",
    XRP: "BINANCE:XRPUSDT",
    ADA: "BINANCE:ADAUSDT",
    DOGE: "BINANCE:DOGEUSDT",
    AVAX: "BINANCE:AVAXUSDT",
    SPY: "AMEX:SPY",
    QQQ: "NASDAQ:QQQ",
    NVDA: "NASDAQ:NVDA",
    TSLA: "NASDAQ:TSLA",
    XAU: "TVC:GOLD",
    DXY: "TVC:DXY",
    WTI: "TVC:USOIL",
    VIX: "TVC:VIX",
  };

  const state = {
    data: null,
    range: DEFAULT_RANGE,
    search: "",
    preset: "default",
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
      presets: $("terminalPresets"),
      health: $("terminalHealth"),
      drawer: $("assetDrawer"),
      drawerBackdrop: $("drawerBackdrop"),
      drawerType: $("drawerType"),
      drawerSymbol: $("drawerSymbol"),
      drawerName: $("drawerName"),
      drawerBody: $("drawerBody"),
      drawerClose: $("drawerClose"),
    });

    renderPresetButtons();

    els.assetList.addEventListener("click", (event) => {
      const row = event.target.closest(".terminal-asset-row[data-symbol]");
      if (row) openDrawer(row.dataset.symbol);
    });
    els.drawerClose.addEventListener("click", closeDrawer);
    els.drawerBackdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawer();
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
    renderHealth(data);
    renderBanner(data);
    renderTape(data);
    renderAssetList();

    const confluence = buildConfluence(data, currentPreset());
    renderRegime(confluence, data);
    renderConfluenceRows(confluence);
    renderThesis(confluence, data);
    renderIndicators(data);
    renderCryptoPulse(data);
    renderNews(data);
    refreshDrawer();
  }

  function currentPreset() {
    return PRESETS[state.preset] || PRESETS.default;
  }

  function renderPresetButtons() {
    els.presets.innerHTML = Object.entries(PRESETS)
      .map(([key, preset]) => `<button class="terminal-preset-btn${key === state.preset ? " active" : ""}" type="button" data-preset="${escapeAttr(key)}">${escapeHtml(preset.label)}</button>`)
      .join("");
    els.presets.querySelectorAll(".terminal-preset-btn").forEach((button) => {
      button.addEventListener("click", () => {
        state.preset = button.dataset.preset in PRESETS ? button.dataset.preset : "default";
        els.presets.querySelectorAll(".terminal-preset-btn").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        renderAll();
      });
    });
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

  function renderHealth(data) {
    const modules = data.dataQuality?.modules;
    if (!modules) {
      els.health.innerHTML = "";
      return;
    }

    const warningsByModule = groupWarningsByModule(data.dataQuality?.warnings || []);
    els.health.innerHTML = MODULE_CARDS.map((card) => {
      const status = String(modules[card.key] || "unavailable");
      const meta = MODULE_STATUS_META[status] || { label: status, tone: "bad" };
      const detail = (warningsByModule.matched[card.key] || []).join(" ");
      return `<div class="terminal-health-card tone-${meta.tone}" title="${escapeAttr(detail || `${card.label}: ${meta.label}`)}">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(meta.label)}</strong>
      </div>`;
    }).join("");
  }

  function groupWarningsByModule(warnings) {
    const matched = {};
    const rest = [];
    for (const warning of warnings) {
      const key = Object.keys(MODULE_WARNING_PATTERNS).find((moduleKey) =>
        MODULE_WARNING_PATTERNS[moduleKey].test(warning),
      );
      if (key) {
        (matched[key] = matched[key] || []).push(warning);
      } else {
        rest.push(warning);
      }
    }
    return { matched, rest };
  }

  function renderBanner(data) {
    const warnings = data.dataQuality?.warnings || [];
    // Module-specific warnings live on the health cards; the banner only
    // carries whatever doesn't map to a module (and everything when the
    // payload predates dataQuality.modules).
    const shown = data.dataQuality?.modules ? groupWarningsByModule(warnings).rest : warnings;
    if (!shown.length) {
      els.banner.className = "terminal-banner";
      els.banner.innerHTML = "";
      return;
    }

    const trimmed = shown.slice(0, 4);
    els.banner.className = "terminal-banner show";
    els.banner.innerHTML = `<strong>Data quality:</strong> ${trimmed.map(escapeHtml).join(" · ")}${shown.length > trimmed.length ? " · …" : ""}`;
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
    const rows = sortAssetsForPreset(
      getAssets(data).filter((asset) => {
        if (!query) return true;
        return [asset.symbol, asset.name, asset.type].some((part) => String(part || "").toLowerCase().includes(query));
      }),
      currentPreset(),
    );

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
        return `<button class="terminal-asset-row" type="button" data-symbol="${escapeAttr(asset.symbol)}" title="${escapeAttr(asset.name || asset.symbol)}">
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

  function sortAssetsForPreset(rows, preset) {
    const priority = new Map((preset.priority || []).map((symbol, index) => [symbol, index]));
    const typeRank = new Map((preset.typeOrder || []).map((type, index) => [type, index]));
    return rows
      .map((asset, index) => ({ asset, index }))
      .sort((left, right) => {
        const lp = priority.has(left.asset.symbol) ? priority.get(left.asset.symbol) : Infinity;
        const rp = priority.has(right.asset.symbol) ? priority.get(right.asset.symbol) : Infinity;
        if (lp !== rp) return lp - rp;
        const lt = typeRank.has(left.asset.type) ? typeRank.get(left.asset.type) : Infinity;
        const rt = typeRank.has(right.asset.type) ? typeRank.get(right.asset.type) : Infinity;
        if (lt !== rt) return lt - rt;
        return left.index - right.index;
      })
      .map((entry) => entry.asset);
  }

  function renderRegime(confluence, data) {
    els.regimeLabel.textContent = confluence.label;
    els.regimeLabel.className = confluence.className;
    els.regimeScore.textContent = confluence.score;
    els.regimeSummary.textContent = confluence.summary;

    const vixRow = getAsset(data, "VIX");
    const miniCards = [
      { label: "Confidence", value: `${confluence.confidence}%`, note: `${state.range} · ${confluence.preset.label}` },
      { label: "BTC Pulse", value: assetChange(data, "BTC"), note: "24h crypto" },
      { label: "Dollar", value: assetChange(data, "DXY"), note: "DXY pressure" },
      {
        label: "Volatility",
        value: vixRow?.proxy ? assetChange(data, "VIX") : assetValue(data, "VIX"),
        note: vixRow?.proxy ? "VIX proxy 24h" : "VIX level",
      },
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
        <td><strong>${factor.points}</strong><small>/5 · ×${escapeHtml(String(factor.weight))}</small></td>
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
      <p><strong>${escapeHtml(confluence.label)}</strong> at ${escapeHtml(String(confluence.score))}/30 (${escapeHtml(confluence.preset.label)} weighting, ${escapeHtml(String(confluence.confidence))}% confidence). Supportive inputs: ${escapeHtml(leading.join(", ") || "none yet")}.</p>
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

  const drawerState = { symbol: null };

  function openDrawer(symbol) {
    drawerState.symbol = String(symbol || "").toUpperCase();
    renderDrawer();
    els.drawer.hidden = false;
    els.drawerBackdrop.hidden = false;
  }

  function closeDrawer() {
    drawerState.symbol = null;
    els.drawer.hidden = true;
    els.drawerBackdrop.hidden = true;
  }

  // Keep an open drawer in sync when the feed refreshes.
  function refreshDrawer() {
    if (drawerState.symbol && !els.drawer.hidden) renderDrawer();
  }

  function renderDrawer() {
    const data = state.data;
    const asset = data ? getAsset(data, drawerState.symbol) : null;
    if (!asset) {
      els.drawerBody.innerHTML = `<div class="terminal-empty">Asset no longer in the feed.</div>`;
      return;
    }

    const change = changeNum(asset);
    const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
    const type = asset.type || "asset";
    els.drawerType.textContent = type === "crypto" ? "Crypto Asset" : type === "equity" ? "Equity" : "Macro / FX";
    els.drawerSymbol.textContent = asset.symbol;
    els.drawerName.textContent = asset.name || "";

    const modules = data.dataQuality?.modules || {};
    const moduleKey = type === "crypto" ? "crypto" : type === "equity" ? "equities" : "macro";
    const status = String(modules[moduleKey] || (data.dataQuality?.live ? "live" : "fallback"));
    const statusMeta = MODULE_STATUS_META[status] || { label: status, tone: "bad" };

    const related = relatedMacroFactors(data, asset);
    const relatedHtml = related.length
      ? related
          .map((row) => `<div class="terminal-indicator-row">
              <span><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.note)}</small></span>
              <em class="${row.cls}">${escapeHtml(row.value)}</em>
            </div>`)
          .join("")
      : `<div class="terminal-empty">No related macro rows in the feed.</div>`;

    const tvSymbol = TRADINGVIEW_SYMBOLS[asset.symbol] || asset.symbol;
    const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;

    els.drawerBody.innerHTML = `
      <div class="terminal-drawer-stats">
        <div class="terminal-micro-card"><span>Last</span><strong>${escapeHtml(formatLast(asset))}</strong><small>${escapeHtml(asset.volume ? `vol ${asset.volume}` : "")}</small></div>
        <div class="terminal-micro-card"><span>24h Change</span><strong class="${cls}">${escapeHtml(formatPercent(change))}</strong><small>${escapeHtml(state.range)} view</small></div>
        <div class="terminal-micro-card"><span>Feed Status</span><strong>${escapeHtml(statusMeta.label)}</strong><small class="tone-${statusMeta.tone}">${escapeHtml(moduleKey)} module</small></div>
      </div>
      <div class="terminal-drawer-section">
        <div class="terminal-section-label">Mini Thesis</div>
        <p>${escapeHtml(buildAssetThesis(data, asset))}</p>
      </div>
      <div class="terminal-drawer-section">
        <div class="terminal-section-label">Related Macro</div>
        ${relatedHtml}
      </div>
      <div class="terminal-drawer-section terminal-drawer-links">
        <div class="terminal-section-label">Quick Actions</div>
        <a class="terminal-button" href="${escapeAttr(tvUrl)}" target="_blank" rel="noopener">TradingView ↗</a>
        <a class="terminal-button" href="/ai-analysis.html">AI Analysis</a>
        <a class="terminal-button" href="/pattern-scanner.html">Pattern Scanner</a>
      </div>`;
  }

  function relatedMacroFactors(data, asset) {
    const symbols =
      asset.type === "macro"
        ? ["DXY", "VIX", "XAU", "WTI"].filter((symbol) => symbol !== asset.symbol)
        : ["DXY", "VIX", asset.type === "crypto" ? "XAU" : "WTI"];
    return symbols
      .map((symbol) => {
        const row = getAsset(data, symbol);
        if (!row) return null;
        const change = changeNum(row);
        return {
          label: row.symbol,
          note: row.name || "macro factor",
          value: `${formatLast(row)} · ${formatPercent(change)}`,
          cls: change > 0 ? "up" : change < 0 ? "down" : "flat",
        };
      })
      .filter(Boolean);
  }

  function buildAssetThesis(data, asset) {
    const change = changeNum(asset);
    const direction = change >= 1 ? "bid" : change <= -1 ? "under pressure" : "range-bound";
    const dxyChange = changeNum(getAsset(data, "DXY"));
    const dollarNote =
      dxyChange > 0.2
        ? "a firm dollar is a headwind"
        : dxyChange < -0.2
          ? "a softer dollar is a tailwind"
          : "the dollar is neutral";
    const regime = buildConfluence(data, currentPreset());
    return `${asset.symbol} is ${direction} (${formatPercent(change)} over 24h) while the ${currentPreset().label} read is ${regime.label} at ${regime.score}/30 — ${dollarNote}. Confirm structure on TradingView before acting.`;
  }

  function buildConfluence(data, preset = PRESETS.default) {
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
    // When VIX comes from an ETF proxy (e.g. VIXY) the price is not the real
    // index level, so score direction only instead of absolute-level bands.
    const vixIsProxy = Boolean(vix?.proxy);
    const vixLevel = vixIsProxy ? 0 : Number(vix?.price);
    const equityAvg = avg([changeNum(spy), changeNum(qqq)]);
    const cryptoAvg = avg([changeNum(btc), changeNum(eth)]);
    const goldChange = changeNum(gold);
    const oilChange = changeNum(oil);
    const highImpactEvents = (data.calendar || []).filter((event) => /^high/i.test(event.impact || "")).length;
    const weights = preset.weights || PRESETS.default.weights;

    const factors = [
      buildFactor({
        key: "dxy",
        label: "Dollar (DXY)",
        subLabel: "USD pressure",
        reading: dxy ? `${formatLast(dxy)} (${formatPercent(dxyChange)})` : "No DXY row",
        note: dxyChange <= 0 ? "Dollar softening supports risk." : "Dollar strength can pressure crypto/equities.",
        rawScore: dxyChange <= -0.4 ? 5 : dxyChange <= 0 ? 4 : dxyChange < 0.5 ? 2 : 1,
        weight: weights.dxy,
      }),
      buildFactor({
        key: "vix",
        label: "Volatility (VIX)",
        subLabel: vixIsProxy ? "market stress (ETF proxy)" : "market stress",
        reading: vix ? `${formatLast(vix)} (${formatPercent(vixChange)})` : "No VIX row",
        note:
          (vixIsProxy ? vixChange <= 0 : vixLevel && vixLevel < 20 && vixChange <= 0)
            ? "Calm volatility backdrop."
            : "Volatility is not fully relaxed.",
        rawScore: vixIsProxy
          ? vixChange <= -2 ? 5 : vixChange <= 0 ? 4 : vixChange < 3 ? 2 : 1
          : vixLevel && vixLevel < 18 && vixChange <= 0 ? 5 : vixLevel && vixLevel < 22 ? 4 : vixLevel && vixLevel < 28 ? 2 : 1,
        weight: weights.vix,
      }),
      buildFactor({
        key: "equities",
        label: "Equity Breadth",
        subLabel: "SPY + QQQ tape",
        reading: `Avg ${formatPercent(equityAvg)}`,
        note: equityAvg >= 0 ? "Equities are confirming risk appetite." : "Equities are dragging the read.",
        rawScore: equityAvg >= 0.7 ? 5 : equityAvg >= 0 ? 4 : equityAvg > -0.7 ? 2 : 1,
        weight: weights.equities,
      }),
      buildFactor({
        key: "crypto",
        label: "Crypto Impulse",
        subLabel: "BTC + ETH",
        reading: `Avg ${formatPercent(cryptoAvg)}`,
        note: cryptoAvg >= 0 ? "Major crypto is bid." : "Major crypto momentum is negative.",
        rawScore: cryptoAvg >= 3 ? 5 : cryptoAvg >= 0 ? 4 : cryptoAvg > -3 ? 2 : 1,
        weight: weights.crypto,
      }),
      buildFactor({
        key: "commodities",
        label: "Commodities",
        subLabel: "gold / oil balance",
        reading: `Au ${formatPercent(goldChange)} · Oil ${formatPercent(oilChange)}`,
        note: oilChange <= 0 ? "Oil pressure is easing inflation impulse." : "Oil bid can complicate the macro tape.",
        rawScore: oilChange <= -0.8 && goldChange <= 0.8 ? 5 : oilChange <= 0.5 ? 4 : oilChange < 1.5 ? 2 : 1,
        weight: weights.commodities,
      }),
      buildFactor({
        key: "calendar",
        label: "Calendar Risk",
        subLabel: "scheduled catalysts",
        reading: `${highImpactEvents} high-impact event${highImpactEvents === 1 ? "" : "s"}`,
        note: highImpactEvents ? "Event risk can override clean signals." : "No major scheduled catalyst in the feed.",
        rawScore: highImpactEvents === 0 ? 5 : highImpactEvents <= 1 ? 4 : highImpactEvents <= 3 ? 2 : 1,
        weight: weights.calendar,
      }),
    ];

    // Weighted total, normalized back to the familiar /30 scale so the regime
    // thresholds stay comparable across presets.
    const weightedScore = factors.reduce((sum, factor) => sum + factor.points * factor.weight, 0);
    const weightedMax = factors.reduce((sum, factor) => sum + 5 * factor.weight, 0);
    const score = Math.round((weightedScore / weightedMax) * 30);

    // Confidence starts from the weighted read but is penalized when the data
    // underneath is degraded, so fallback macro/calendar can't fake conviction.
    const dq = data.dataQuality || {};
    const modules = dq.modules || {};
    const penalties = [];
    let confidence = Math.round((weightedScore / weightedMax) * 100);
    if (!dq.live || dq.partial) {
      confidence -= 15;
      penalties.push("degraded feed");
    }
    if (modules.macro && modules.macro !== "live") {
      confidence -= 10;
      penalties.push("macro fallback");
    }
    if (modules.calendar && modules.calendar !== "live") {
      confidence -= 5;
      penalties.push("calendar fallback");
    }
    confidence = Math.max(5, Math.min(100, confidence));

    const label = score >= 21 ? "RISK-ON" : score <= 12 ? "RISK-OFF" : "MIXED / NEUTRAL";
    const className = score >= 21 ? "risk-on" : score <= 12 ? "risk-off" : "risk-mixed";
    const supportive = factors.filter((factor) => factor.points >= 4).length;
    const bearish = factors.filter((factor) => factor.points <= 2).length;
    const penaltyNote = penalties.length ? ` Confidence reduced: ${penalties.join(", ")}.` : "";

    return {
      factors,
      score,
      confidence,
      label,
      className,
      preset,
      summary: `${supportive} supportive factor${supportive === 1 ? "" : "s"}, ${bearish} drag factor${bearish === 1 ? "" : "s"} under the ${preset.label} weighting.${penaltyNote}`,
    };
  }

  function buildFactor({ key, label, subLabel, reading, note, rawScore, weight }) {
    const points = Math.max(1, Math.min(5, Number(rawScore) || 3));
    const bias = points >= 4 ? "Bullish" : points <= 2 ? "Bearish" : "Neutral";
    const safeWeight = Number.isFinite(Number(weight)) && Number(weight) > 0 ? Number(weight) : 1;
    return { key, label, subLabel, reading, note, points, bias, weight: safeWeight };
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
