/**
 * Deterministic On-Chain Pulse scoring.
 *
 * Context, not trade signals: nothing here says LONG or SHORT. Every
 * threshold lives in RULES and is echoed in the API payload, so the UI can
 * show exactly how a state was reached.
 *
 * Each component scores its 7-day % change:
 *   |change| < neutral          →  0
 *   neutral ≤ |change| < strong → ±1
 *   |change| ≥ strong           → ±2
 * The pulse is the sum across available components (max ±6). At least two
 * components must be present, or the pulse is reported as unavailable.
 */

const RULES = {
  components: {
    liquidity: { label: "Stablecoin supply 7D", neutral: 0.5, strong: 1.5 },
    tvl: { label: "DeFi TVL 7D", neutral: 3, strong: 8 },
    activity: { label: "DEX volume 7D vs prior 7D", neutral: 10, strong: 25 },
  },
  // Stablecoin 30D fallback band when 7D history is missing.
  liquidity30d: { neutral: 1.5 },
  pulse: [
    { min: 4, label: "Strong Expansion", state: "EXPANDING" },
    { min: 2, label: "Expansion", state: "EXPANDING" },
    { min: -1, label: "Neutral", state: "NEUTRAL" },
    { min: -3, label: "Contraction", state: "CONTRACTING" },
    { min: -Infinity, label: "Strong Contraction", state: "CONTRACTING" },
  ],
  minComponents: 2,
};

function scoreChange(change, { neutral, strong }) {
  if (!Number.isFinite(change)) return null;
  const magnitude = Math.abs(change);
  const sign = Math.sign(change);
  if (magnitude >= strong) return 2 * sign;
  if (magnitude >= neutral) return sign;
  return 0;
}

// ↑ / → / ↓ using the component's neutral band.
function trend(change, neutral) {
  if (!Number.isFinite(change)) return null;
  if (change >= neutral) return "up";
  if (change <= -neutral) return "down";
  return "flat";
}

function liquidityRegime(stablecoins) {
  const change7d = stablecoins?.change7d;
  const change30d = stablecoins?.change30d;
  const band = RULES.components.liquidity.neutral;
  if (Number.isFinite(change7d)) {
    return { regime: regimeFor(change7d, band), basis: "7d" };
  }
  if (Number.isFinite(change30d)) {
    return { regime: regimeFor(change30d, RULES.liquidity30d.neutral), basis: "30d" };
  }
  return { regime: null, basis: null };
}

function regimeFor(change, band) {
  if (change >= band) return "EXPANDING";
  if (change <= -band) return "CONTRACTING";
  return "NEUTRAL";
}

function activityLabel(dex) {
  const change = dex?.change7d;
  const band = RULES.components.activity.neutral;
  if (!Number.isFinite(change)) return null;
  if (change >= band) return "RISING";
  if (change <= -band) return "FADING";
  return "STEADY";
}

function computePulse({ stablecoins, tvl, dex }) {
  const inputs = {
    liquidity: stablecoins?.change7d,
    tvl: tvl?.change7d,
    activity: dex?.change7d,
  };
  const components = Object.entries(RULES.components).map(([key, rule]) => {
    const change = Number.isFinite(inputs[key]) ? inputs[key] : null;
    return { key, label: rule.label, change, score: scoreChange(change, rule), trend: trend(change, rule.neutral) };
  });
  const scored = components.filter((component) => component.score !== null);
  if (scored.length < RULES.minComponents) {
    return { score: null, label: null, state: null, components };
  }
  const score = scored.reduce((sum, component) => sum + component.score, 0);
  const band = RULES.pulse.find((entry) => score >= entry.min);
  return { score, label: band.label, state: band.state, components };
}

module.exports = { RULES, scoreChange, trend, liquidityRegime, activityLabel, computePulse };
