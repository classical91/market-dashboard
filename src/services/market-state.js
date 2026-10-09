// Canonical market state: one answer to "what environment is the market in?"
// for every page that shows a regime.
//
// Overview, the Terminal Suite and the Decision Engine each grew their own
// regime read — a crypto-only average, a client-side /30 confluence score and
// the Decision Engine's multi-asset vote — and on the same feeds they could
// disagree. The Decision Engine's model is the authoritative one (it is what
// gates setups and feeds the Trading Lab), so this module does not compute a
// regime of its own: it calls the Decision Engine's buildRegime,
// assessNewsRisk and buildRotation unchanged and adds what a display needs on
// top — where each input came from, so a proxy or fallback reading can never
// look like a live one.
//
// Nothing here may change the Decision Engine's numbers. The score, label,
// modifiers and components are exactly buildRegime's output; the data-quality
// fields are annotations, not re-weighting.

const { buildRegime, buildRotation, assessNewsRisk } = require("./decision-engine");

// Which feed each regime component reads from. "AVG" is the crypto-breadth
// component buildRegime adds over all majors.
const COMPONENT_MODULE = {
  BTC: "crypto",
  AVG: "crypto",
  SPY: "equities",
  QQQ: "equities",
  DXY: "macro",
  VIX: "macro",
  XAU: "macro",
  WTI: "macro",
  US10Y: "macro",
  TNX: "macro",
};

function feedStatus(feed) {
  if (!feed) return "unavailable";
  if (feed.live) return "live";
  if (feed.stale) return "delayed";
  return "fallback";
}

function itemsOf(feed) {
  return Array.isArray(feed?.items) ? feed.items : [];
}

function findRow(feed, symbol) {
  return itemsOf(feed).find((row) => row && row.symbol === symbol) || null;
}

// A component's quality is its feed's status, except that a live or delayed
// ETF proxy (UUP standing in for DXY, VIXY for VIX) is called out as a proxy:
// it tracks the instrument's direction but its price is not the index level.
function componentQuality(component, feeds) {
  const module = COMPONENT_MODULE[component.symbol] || "macro";
  const status = feedStatus(feeds[module]);
  if (status === "fallback" || status === "unavailable") return status;
  const row = findRow(feeds[module], component.symbol);
  return row && row.proxy ? "proxy" : status;
}

/**
 * @param feeds { crypto, equities, macro, calendar } — the market-data
 *   service's results ({ live, stale?, items }), as the Overview and Decision
 *   Engine services already unwrap them.
 */
function buildMarketState({ crypto, equities, macro, calendar } = {}, now = new Date()) {
  const feeds = { crypto, equities, macro };
  const rows = { crypto: itemsOf(crypto), equities: itemsOf(equities), macro: itemsOf(macro) };

  const regime = buildRegime(rows);
  const rotation = buildRotation(rows);
  const newsRisk = assessNewsRisk(itemsOf(calendar), now);

  const components = regime.components.map((component) => ({
    ...component,
    module: COMPONENT_MODULE[component.symbol] || "macro",
    quality: componentQuality(component, feeds),
  }));

  const modules = {
    crypto: feedStatus(crypto),
    equities: feedStatus(equities),
    macro: feedStatus(macro),
    calendar: calendar ? (calendar.live ? "live" : "fallback") : "unavailable",
  };

  const fallbackInputs = components.filter((c) => c.quality === "fallback").map((c) => c.symbol);
  const proxyInputs = components.filter((c) => c.quality === "proxy").map((c) => c.symbol);
  const warnings = [];
  if (!components.length) warnings.push("No regime inputs available.");
  if (fallbackInputs.length) warnings.push(`Regime uses fallback data for ${fallbackInputs.join(", ")}.`);
  if (proxyInputs.length) warnings.push(`${proxyInputs.join(", ")} scored from ETF proxies, not the index level.`);
  if (modules.calendar !== "live") warnings.push("News risk is not scored off a live calendar.");

  return {
    source: "decision-engine",
    updatedAt: now.toISOString(),
    regime: { ...regime, components },
    newsRisk: { ...newsRisk, quality: modules.calendar },
    rotation,
    dataQuality: {
      modules,
      degraded: !components.length || fallbackInputs.length > 0,
      fallbackInputs,
      proxyInputs,
      warnings,
    },
  };
}

module.exports = { buildMarketState, COMPONENT_MODULE };
