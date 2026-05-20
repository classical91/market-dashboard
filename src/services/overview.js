const VALID_RANGES = ["1D", "1W", "1M", "3M"];

class OverviewService {
  constructor({ marketDataService, onchainService, cache, cacheTtlMs }) {
    this.marketDataService = marketDataService;
    this.onchainService = onchainService;
    this.cache = cache;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? cacheTtlMs : 60_000;
  }

  async getOverview(rawRange) {
    const range = VALID_RANGES.includes(rawRange) ? rawRange : "1D";
    return this.cache.getOrLoad(`overview:${range}`, this.cacheTtlMs, () => this.buildPayload(range));
  }

  async buildPayload(range) {
    const [cryptoResult, equitiesResult, macroResult, chartResult, globalResult, newsResult, calendarResult, onchainResult] =
      await Promise.all([
        safe(() => this.marketDataService.getCryptoPrices()),
        safe(() => this.marketDataService.getEquities()),
        safe(() => this.marketDataService.getMacro()),
        safe(() => this.marketDataService.getMarketChart(range, "bitcoin")),
        safe(() => this.marketDataService.getGlobalDominance()),
        safe(() => this.marketDataService.getNews()),
        safe(() => this.marketDataService.getCalendar()),
        safe(() => (this.onchainService ? this.onchainService.getOverview() : null)),
      ]);

    const crypto = unwrap(cryptoResult, { live: false, source: "fallback", items: [] });
    const equities = unwrap(equitiesResult, { live: false, source: "fallback", items: [] });
    const macro = unwrap(macroResult, { live: false, source: "fallback", items: [] });
    const chart = unwrap(chartResult, { live: false, source: "fallback", points: [] });
    const globalData = unwrap(globalResult, { live: false, source: "fallback", dominance: [] });
    const news = unwrap(newsResult, { live: false, source: "fallback", items: [] });
    const calendar = unwrap(calendarResult, { live: false, source: "fallback", items: [] });
    const onchain = onchainResult.value && !onchainResult.error ? onchainResult.value : null;

    const sources = [];
    const warnings = [];
    if (crypto.live) sources.push("coingecko:crypto");
    else warnings.push(withReason("Crypto prices using fallback data", crypto.error));
    if (chart.live) sources.push("coingecko:chart");
    else if (chart.error) warnings.push(withReason("Market Pulse chart using fallback", chart.error));
    if (globalData.live) sources.push("coingecko:global");
    else if (globalData.error) warnings.push(withReason("Crypto allocation using fallback", globalData.error));
    if (equities.live) sources.push("finnhub:equities");
    else warnings.push(withReason("Equities using fallback (set FINNHUB_API_KEY for live)", equities.error));
    if (!macro.live) warnings.push("Macro/FX using fallback (no provider configured).");
    if (!news.live) warnings.push("News feed using fallback (no MARKET_NEWS_URL configured).");
    if (!calendar.live) warnings.push("Macro calendar using fallback (no provider configured).");
    if (onchainResult.error) warnings.push(withReason("On-chain service unavailable", onchainResult.error.message));
    if (onchain) sources.push("internal:onchain");

    const ticker = [...crypto.items, ...equities.items, ...macro.items].map((item) => ({
      symbol: item.symbol,
      name: item.name,
      price: item.price,
      changePercent: item.changePercent,
      volume: item.volume,
    }));

    const watchlist = ticker.map((row, index) => {
      const source =
        index < crypto.items.length
          ? "crypto"
          : index < crypto.items.length + equities.items.length
            ? "equity"
            : "macro";
      return { ...row, type: source };
    });

    const marketStatus = buildMarketStatus(crypto.items);
    const kpis = buildKpis({ crypto: crypto.items, onchain });
    const heatmap = buildHeatmap({ crypto: crypto.items, equities: equities.items, macro: macro.items });
    const riskFactors = buildRiskFactors({ crypto: crypto.items, macro: macro.items });
    const alerts = buildAlerts({ crypto: crypto.items, macro: macro.items, onchain });
    const allocation = buildAllocation(globalData);

    const marketPulse = {
      range,
      points: chart.points,
      changePercent:
        chart.points.length > 1
          ? Number(
              (((chart.points[chart.points.length - 1].value - chart.points[0].value) /
                chart.points[0].value) *
                100).toFixed(2),
            )
          : 0,
    };

    const live = crypto.live;
    const partial = live && warnings.length > 0;

    return {
      status: "ok",
      updatedAt: new Date().toISOString(),
      range,
      marketStatus,
      kpis,
      ticker,
      watchlist,
      marketPulse,
      heatmap,
      allocation,
      riskFactors,
      alerts,
      news: news.items,
      calendar: calendar.items,
      dataQuality: {
        live,
        partial,
        sources,
        warnings,
      },
    };
  }
}

function buildMarketStatus(crypto) {
  if (!crypto.length) {
    return {
      label: "Unknown",
      summary: "No market data available.",
      riskScore: 50,
      volatilityLabel: "Unknown",
    };
  }
  const avg =
    crypto.reduce((sum, row) => sum + (Number(row.changePercent) || 0), 0) / crypto.length;
  const absMax = crypto.reduce((max, row) => Math.max(max, Math.abs(row.changePercent || 0)), 0);

  let label = "Neutral";
  if (avg >= 1.5) label = "Risk-On";
  else if (avg <= -1.5) label = "Risk-Off";

  let volatilityLabel = "Low";
  if (absMax >= 5) volatilityLabel = "High";
  else if (absMax >= 2) volatilityLabel = "Moderate";

  const riskScore = Math.round(Math.max(0, Math.min(100, 50 + avg * 8 + (absMax >= 5 ? 8 : 0))));

  return {
    label,
    summary: `Average 24h crypto change ${formatPercent(avg)}; max move ${formatPercent(absMax)}.`,
    riskScore,
    volatilityLabel,
  };
}

function buildKpis({ crypto, onchain }) {
  const btc = crypto.find((row) => row.symbol === "BTC");
  const eth = crypto.find((row) => row.symbol === "ETH");
  const avgChange = crypto.length
    ? crypto.reduce((sum, row) => sum + (Number(row.changePercent) || 0), 0) / crypto.length
    : 0;

  const kpis = [];
  if (btc) {
    kpis.push({
      label: "Bitcoin",
      value: formatMoney(btc.price),
      changePercent: Number(btc.changePercent.toFixed(2)),
      note: "24h change",
    });
  }
  if (eth) {
    kpis.push({
      label: "Ethereum",
      value: formatMoney(eth.price),
      changePercent: Number(eth.changePercent.toFixed(2)),
      note: "24h change",
    });
  }
  kpis.push({
    label: "Crypto Sentiment",
    value: avgChange >= 1 ? "Bullish" : avgChange <= -1 ? "Bearish" : "Mixed",
    changePercent: Number(avgChange.toFixed(2)),
    note: "Avg 24h move across majors",
  });

  if (onchain && onchain.stablecoinNetflow != null) {
    const netflow = Number(onchain.stablecoinNetflow) || 0;
    kpis.push({
      label: "Stablecoin Netflow",
      value: formatSignedMoney(netflow),
      changePercent: 0,
      note: "24h on-chain mint/burn",
    });
  } else {
    kpis.push({
      label: "Volatility",
      value: crypto.length
        ? `${(crypto.reduce((max, row) => Math.max(max, Math.abs(row.changePercent || 0)), 0)).toFixed(2)}%`
        : "-",
      changePercent: 0,
      note: "Largest 24h crypto move",
    });
  }

  return kpis;
}

function buildHeatmap({ crypto, equities, macro }) {
  const tiles = [];
  crypto.slice(0, 6).forEach((row) =>
    tiles.push({ label: row.symbol, value: round2(row.changePercent), category: "crypto" }),
  );
  equities.forEach((row) =>
    tiles.push({ label: row.symbol, value: round2(row.changePercent), category: "equity" }),
  );
  macro.forEach((row) =>
    tiles.push({ label: row.symbol, value: round2(row.changePercent), category: "macro" }),
  );
  return tiles;
}

function buildRiskFactors({ crypto, macro }) {
  const btcChange = Math.abs(crypto.find((row) => row.symbol === "BTC")?.changePercent || 0);
  const ethChange = Math.abs(crypto.find((row) => row.symbol === "ETH")?.changePercent || 0);
  const dxy = macro.find((row) => row.symbol === "DXY");
  const vix = macro.find((row) => row.symbol === "VIX");

  return [
    {
      label: "Crypto Volatility",
      value: Math.min(100, Math.round(((btcChange + ethChange) / 2) * 18)),
    },
    {
      label: "Dollar Strength",
      value: dxy ? Math.min(100, Math.round(50 + (dxy.changePercent || 0) * 10)) : 50,
    },
    {
      label: "Equity Risk (VIX)",
      value: vix ? Math.min(100, Math.round((vix.price || 15) * 3.5)) : 50,
    },
  ];
}

function buildAlerts({ crypto, macro, onchain }) {
  const alerts = [];
  const btc = crypto.find((row) => row.symbol === "BTC");
  const eth = crypto.find((row) => row.symbol === "ETH");

  if (btc && Math.abs(btc.changePercent) >= 3) {
    alerts.push({
      title: `BTC moved ${formatPercent(btc.changePercent)} in 24h`,
      category: "Crypto",
      status: "Triggered",
      severity: Math.abs(btc.changePercent) >= 6 ? "high" : "medium",
    });
  }
  if (eth && Math.abs(eth.changePercent) >= 3) {
    alerts.push({
      title: `ETH moved ${formatPercent(eth.changePercent)} in 24h`,
      category: "Crypto",
      status: "Triggered",
      severity: Math.abs(eth.changePercent) >= 6 ? "high" : "medium",
    });
  }

  const dxy = macro.find((row) => row.symbol === "DXY");
  if (dxy && Math.abs(dxy.changePercent) >= 0.3) {
    alerts.push({
      title: `DXY ${dxy.changePercent > 0 ? "rising" : "softening"} (${formatPercent(dxy.changePercent)})`,
      category: "FX / Macro",
      status: "Watching",
      severity: "low",
    });
  }

  if (onchain && Array.isArray(onchain.largeTransfers) && onchain.largeTransfers.length) {
    const transfer = onchain.largeTransfers[0];
    alerts.push({
      title: `Large on-chain transfer: ${transfer.token} ${formatSignedMoney(transfer.usd || 0)}`,
      category: "On-Chain",
      status: "Triggered",
      severity: "high",
    });
  }

  if (onchain && Number(onchain.stablecoinNetflow) && Math.abs(onchain.stablecoinNetflow) > 50_000_000) {
    alerts.push({
      title: `Stablecoin netflow ${formatSignedMoney(onchain.stablecoinNetflow)} (24h)`,
      category: "On-Chain",
      status: "Active",
      severity: "medium",
    });
  }

  if (!alerts.length) {
    alerts.push({
      title: "No priority alerts. Markets within normal range.",
      category: "System",
      status: "Active",
      severity: "low",
    });
  }
  return alerts;
}

function buildAllocation(globalData) {
  const dominance = Array.isArray(globalData?.dominance) ? globalData.dominance.slice(0, 5) : [];
  if (!dominance.length) {
    return { title: "Crypto Market Allocation", segments: [], live: false };
  }
  return {
    title: "Crypto Market Allocation",
    subtitle: "Market cap dominance",
    segments: dominance.map((entry) => ({
      label: entry.symbol,
      percent: Number(entry.percent.toFixed(2)),
    })),
    live: Boolean(globalData.live),
  };
}

function safe(fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error }));
}

function unwrap(result, fallback) {
  if (result.error || !result.value) return fallback;
  return result.value;
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedMoney(value) {
  const n = Number(value || 0);
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatPercent(value) {
  const n = Number(value || 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function withReason(label, reason) {
  if (!reason) return `${label}.`;
  const text = typeof reason === "string" ? reason : reason.message || String(reason);
  return `${label}: ${text}`;
}

module.exports = { OverviewService };
