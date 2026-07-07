"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildRegime,
  buildRotation,
  assessNewsRisk,
  scoreSetup,
  buildPlan,
  atr,
} = require("../src/services/decision-engine");

function macroRow(symbol, price, changePercent, proxy = false) {
  return { symbol, name: symbol, price, changePercent, proxy };
}

const RISK_ON_FEEDS = {
  crypto: [
    { symbol: "BTC", changePercent: 3.5 },
    { symbol: "ETH", changePercent: 4.1 },
    { symbol: "SOL", changePercent: 5.0 },
  ],
  equities: [
    { symbol: "SPY", changePercent: 1.2 },
    { symbol: "QQQ", changePercent: 1.6 },
  ],
  macro: [
    macroRow("DXY", 104, -0.5),
    macroRow("VIX", 13, -5),
    macroRow("XAU", 2340, -0.6),
    macroRow("WTI", 78, 0.4),
  ],
};

test("regime: broad strength across assets scores Risk-On", () => {
  const regime = buildRegime(RISK_ON_FEEDS);
  assert.equal(regime.label, "Risk-On");
  assert.ok(regime.score >= 62, `expected >= 62, got ${regime.score}`);
  assert.ok(regime.components.length >= 6);
  assert.match(regime.summary, /Risk-On/);
});

test("regime: broad weakness with a stressed VIX scores Risk-Off", () => {
  const regime = buildRegime({
    crypto: [
      { symbol: "BTC", changePercent: -4.2 },
      { symbol: "ETH", changePercent: -5.5 },
    ],
    equities: [
      { symbol: "SPY", changePercent: -1.8 },
      { symbol: "QQQ", changePercent: -2.4 },
    ],
    macro: [macroRow("DXY", 106, 0.7), macroRow("VIX", 29, 12), macroRow("XAU", 2400, 1.4), macroRow("WTI", 74, -2.5)],
  });
  assert.equal(regime.label, "Risk-Off");
  assert.ok(regime.score <= 38, `expected <= 38, got ${regime.score}`);
});

test("regime: gold bid + soft equities in the middle zone reads Defensive", () => {
  const regime = buildRegime({
    crypto: [{ symbol: "BTC", changePercent: -0.5 }],
    equities: [
      { symbol: "SPY", changePercent: -0.4 },
      { symbol: "QQQ", changePercent: -0.6 },
    ],
    macro: [macroRow("DXY", 104, 0.1), macroRow("VIX", 17, 0), macroRow("XAU", 2400, 1.2), macroRow("WTI", 78, 0)],
  });
  assert.equal(regime.label, "Defensive");
});

test("regime: flat directionless tape reads Choppy", () => {
  const regime = buildRegime({
    crypto: [
      { symbol: "BTC", changePercent: 0.1 },
      { symbol: "ETH", changePercent: -0.2 },
    ],
    equities: [
      { symbol: "SPY", changePercent: 0.05 },
      { symbol: "QQQ", changePercent: -0.1 },
    ],
    macro: [macroRow("DXY", 104, 0.02), macroRow("VIX", 15, 0.5), macroRow("XAU", 2340, 0.05), macroRow("WTI", 78, 0.1)],
  });
  assert.equal(regime.label, "Choppy");
  assert.ok(regime.score > 38 && regime.score < 62);
});

test("regime: a VIX spike marks the environment Volatile", () => {
  const regime = buildRegime({
    crypto: [
      { symbol: "BTC", changePercent: 2.5 },
      { symbol: "ETH", changePercent: -2.8 },
    ],
    equities: [
      { symbol: "SPY", changePercent: -0.3 },
      { symbol: "QQQ", changePercent: 0.4 },
    ],
    macro: [macroRow("DXY", 104, 0.05), macroRow("VIX", 31, 15), macroRow("XAU", 2340, -1.0), macroRow("WTI", 78, 0.2)],
  });
  assert.equal(regime.label, "Volatile");
});

test("regime: US10Y row from the macro feed joins the vote", () => {
  const regime = buildRegime({
    ...RISK_ON_FEEDS,
    macro: [...RISK_ON_FEEDS.macro, macroRow("US10Y", 4.3, 2.5)],
  });
  const yields = regime.components.find((c) => c.name === "US 10Y yield");
  assert.ok(yields, "US10Y should be a scored component");
  assert.ok(yields.vote < 0, "rising yields must vote risk-negative");
});

test("regime: proxy VIX rows are scored on change only, not ETF price level", () => {
  // VIXY trades near $12 — treating that as a real VIX level would read as
  // extreme calm. The proxy flag must suppress the level component.
  const withProxy = buildRegime({
    crypto: [],
    equities: [],
    macro: [macroRow("VIX", 12, 0, true)],
  });
  assert.equal(withProxy.components[0].vote, 0);
});

test("rotation: per-class thresholds classify direction and strength", () => {
  const rotation = buildRotation({
    crypto: [
      { symbol: "BTC", changePercent: 4.0 },
      { symbol: "ETH", changePercent: 3.0 },
    ],
    equities: [
      { symbol: "SPY", changePercent: 0.1 },
      { symbol: "QQQ", changePercent: 0.1 },
    ],
    macro: [macroRow("DXY", 104, 0.55), macroRow("XAU", 2340, -0.6), macroRow("WTI", 78, 1.0), macroRow("US10Y", 4.3, 2.0)],
  });
  const byClass = new Map(rotation.rows.map((row) => [row.assetClass, row]));
  assert.deepEqual(
    [byClass.get("Crypto").direction, byClass.get("Crypto").strength],
    ["Up", "Strong"],
  );
  assert.equal(byClass.get("Stocks").direction, "Flat");
  assert.deepEqual([byClass.get("USD").direction, byClass.get("USD").strength], ["Up", "Strong"]);
  assert.deepEqual([byClass.get("Gold").direction, byClass.get("Gold").strength], ["Down", "Medium"]);
  assert.equal(byClass.get("Bonds/Yields").direction, "Yields Up");
  assert.equal(byClass.get("Bonds/Yields").note, "Risk pressure");
  assert.equal(rotation.leader, "Crypto");
});

test("rotation: missing yields feed degrades to a labelled no-data row", () => {
  const rotation = buildRotation({ crypto: [], equities: [], macro: [] });
  const yields = rotation.rows.find((row) => row.assetClass === "Bonds/Yields");
  assert.equal(yields.direction, "No data");
  assert.match(yields.note, /US10Y/);
});

test("news risk: high-impact event inside the 45-minute window is high", () => {
  const now = new Date("2026-07-07T08:00:00Z");
  const risk = assessNewsRisk([{ time: "08:30", title: "US CPI Inflation", impact: "High" }], now);
  assert.equal(risk.level, "high");
  assert.match(risk.reason, /US CPI/);
});

test("news risk: high-impact events later today are medium; none is low", () => {
  const now = new Date("2026-07-07T08:00:00Z");
  const medium = assessNewsRisk(
    [
      { time: "14:00", title: "FOMC Statement", impact: "High" },
      { time: "10:00", title: "Consumer Sentiment", impact: "Medium" },
    ],
    now,
  );
  assert.equal(medium.level, "medium");
  assert.equal(medium.nextHighImpact.title, "FOMC Statement");

  const low = assessNewsRisk([{ time: "10:00", title: "Consumer Sentiment", impact: "Medium" }], now);
  assert.equal(low.level, "low");
});

test("setup quality: aligned LONG in Risk-On with calm news scores Ready", () => {
  const regime = { label: "Risk-On", score: 75, modifiers: [] };
  const quality = scoreSetup({
    signal: "LONG",
    screenerScore: 83,
    adx: 30,
    regime,
    newsRisk: { level: "low" },
  });
  assert.ok(quality.setupScore >= 75, `expected >= 75, got ${quality.setupScore}`);
  assert.equal(quality.action, "Ready — watch for entry");
  assert.equal(quality.components.regimeAlignment, 75);
});

test("setup quality: the same LONG scores lower against a Risk-Off regime", () => {
  const base = { signal: "LONG", screenerScore: 83, adx: 30, newsRisk: { level: "low" } };
  const riskOn = scoreSetup({ ...base, regime: { label: "Risk-On", score: 75, modifiers: [] } });
  const riskOff = scoreSetup({ ...base, regime: { label: "Risk-Off", score: 25, modifiers: [] } });
  assert.ok(riskOff.setupScore < riskOn.setupScore);
});

test("setup quality: an imminent news window forces Stand down", () => {
  const quality = scoreSetup({
    signal: "SHORT",
    screenerScore: 83,
    adx: 30,
    regime: { label: "Risk-Off", score: 25, modifiers: [] },
    newsRisk: { level: "high" },
  });
  assert.equal(quality.action, "Stand down — news window");
});

test("setup quality: FLAT signals are not scored", () => {
  const quality = scoreSetup({
    signal: "FLAT",
    screenerScore: 50,
    adx: 10,
    regime: { label: "Choppy", score: 50, modifiers: [] },
    newsRisk: { level: "low" },
  });
  assert.equal(quality.setupScore, null);
  assert.equal(quality.action, "No setup");
});

function makeCandles(count, { start = 100, step = 0.5, spread = 1 } = {}) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const close = start + step * i;
    return {
      openTime: now - (count - i) * 3600_000,
      high: close + spread,
      low: close - spread,
      close,
      volume: 1000,
      closeTime: now - (count - i - 1) * 3600_000 - 1,
    };
  });
}

test("atr: constant-range candles converge to the bar range", () => {
  const value = atr(makeCandles(60, { step: 0, spread: 1 }), 14);
  assert.ok(Math.abs(value - 2) < 1e-9);
});

test("execution plan: LONG levels sit trigger < target with invalidation below", () => {
  const candles = makeCandles(60);
  const plan = buildPlan({
    symbol: "BTCUSDT",
    signal: "LONG",
    candles,
    price: candles[candles.length - 1].close,
    regime: { label: "Risk-On", score: 75, modifiers: [] },
    newsRisk: { level: "low" },
  });
  assert.equal(plan.bias, "Long");
  assert.ok(plan.invalidation < plan.trigger, "invalidation must sit below a long trigger");
  assert.ok(plan.target > plan.trigger, "target must sit above a long trigger");
  assert.ok(plan.riskReward >= 1.5);
  assert.deepEqual(plan.doNotTrade, []);
  assert.equal(plan.tradeable, true);
});

test("execution plan: regime conflict and news windows populate doNotTrade", () => {
  const candles = makeCandles(60);
  const plan = buildPlan({
    symbol: "BTCUSDT",
    signal: "LONG",
    candles,
    price: candles[candles.length - 1].close,
    regime: { label: "Risk-Off", score: 30, modifiers: [] },
    newsRisk: { level: "high", reason: "US CPI in 20 min (08:30)." },
  });
  assert.equal(plan.tradeable, false);
  assert.ok(plan.doNotTrade.some((reason) => /news|event/i.test(reason)));
  assert.ok(plan.doNotTrade.some((reason) => /risk-off/i.test(reason)));
});

test("execution plan: SHORT mirrors the level geometry", () => {
  const candles = makeCandles(60, { step: -0.5, start: 200 });
  const plan = buildPlan({
    symbol: "ETHUSDT",
    signal: "SHORT",
    candles,
    price: candles[candles.length - 1].close,
    regime: { label: "Risk-Off", score: 30, modifiers: [] },
    newsRisk: { level: "low" },
  });
  assert.equal(plan.bias, "Short");
  assert.ok(plan.invalidation > plan.trigger);
  assert.ok(plan.target < plan.trigger);
});

test("execution plan: too little history returns an explicit error", () => {
  const plan = buildPlan({
    symbol: "BTCUSDT",
    signal: "LONG",
    candles: makeCandles(5),
    price: 100,
    regime: { label: "Risk-On", score: 70, modifiers: [] },
    newsRisk: { level: "low" },
  });
  assert.match(plan.error, /history/i);
});
