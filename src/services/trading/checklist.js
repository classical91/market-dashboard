"use strict";

// Strategy rules engine, ported from TraderClaw's checklist.py.
//
// Scores a candidate setup 0-100 and returns TAKE_FULL / TAKE_HALF /
// TAKE_QUARTER / SKIP with the full reasoning attached. Kill switches run
// first: no score is high enough to trade through a breached loss limit.

const { getTradingConfig } = require("./config");

// Market conditions the checklist reasons over.
//
// Anything the caller leaves out is UNKNOWN — `null` — and unknown never earns
// points. That sentence used to be a comment rather than a fact, and the gap
// between the two was a systematic bias:
//
//   usdtDominanceSignal defaulted to "NEUTRAL", btcDominanceRising to false,
//   bearMarket to false. Read literally those say "dominance is flat, BTC
//   dominance is not rising, and this is not a bear market" — three
//   OBSERVATIONS, and for a LONG all three are favourable. A long candidate
//   with no macro feed at all therefore collected the macro block's full +20.
//   A short under identical no-data conditions collected +0, because the same
//   three defaults read as unfavourable for it. Twenty points of directional
//   bias, produced entirely by the absence of data.
//
//   fundingRate defaulted to 0, which reads as "funding is neutral" and paid
//   +5 to both directions for a feed nobody had.
//
// A candle backtest has none of these feeds, so it was scoring every long 25
// points above the evidence and every short 5 above — and 20 points apart from
// each other. With SKIP at 50 and TAKE_QUARTER at 50-64, that gap alone decides
// whether a setup trades.
//
// `null` now means "not measured" and is scored as such. A caller with a real
// feed passes the real value and scores exactly as before.
function marketState(overrides = {}) {
  return {
    regime: "UNKNOWN", // TREND_UP | TREND_DOWN | RANGE | VOLATILE_EXPANSION | LOW_COMPRESSION
    dailyBias: "NEUTRAL", // BULLISH | BEARISH | NEUTRAL
    // null = not measured. "NEUTRAL" is a real observation and scores as one.
    usdtDominanceSignal: null, // RISK_ON | RISK_OFF | NEUTRAL | null
    btcDominanceRising: null, // true | false | null
    bearMarket: null, // true | false | null
    dxyBullish: false,
    newsBlackout: false,
    openPositions: 0,
    totalRiskPct: 0,
    dailyLossPct: 0,
    weeklyLossPct: 0,
    consecutiveLosses: 0,
    fundingRate: null, // 8h funding rate as a fraction, or null when unmeasured
    atrRatio: 1, // current ATR / 20-period ATR average
    volumeRatio: 1, // current volume / 20-period MA
    macdBullish: null,
    stochSignal: null, // OVERSOLD_CROSS | OVERBOUGHT_CROSS | NEUTRAL
    ...overrides,
  };
}

function known(value) {
  return value !== null && value !== undefined;
}

function runKillSwitches(state, config = getTradingConfig()) {
  if (state.dailyLossPct >= config.dailyLossLimitPct) {
    return `DAILY_LOSS_LIMIT hit: ${state.dailyLossPct.toFixed(1)}% (max ${config.dailyLossLimitPct.toFixed(0)}%)`;
  }
  if (state.weeklyLossPct >= config.weeklyLossLimitPct) {
    return `WEEKLY_LOSS_LIMIT hit: ${state.weeklyLossPct.toFixed(1)}% (max ${config.weeklyLossLimitPct.toFixed(0)}%)`;
  }
  if (state.consecutiveLosses >= config.maxConsecutiveLosses) {
    return `CONSECUTIVE_LOSSES: ${state.consecutiveLosses} in a row`;
  }
  if (state.newsBlackout) {
    return "NEWS_WINDOW: High-impact event active";
  }
  if (state.atrRatio > config.maxAtrRatio) {
    return `VOLATILITY_SPIKE: ATR is ${state.atrRatio.toFixed(1)}x average`;
  }
  // Symmetric by design: crowded shorts paying longs are as much a warning as
  // the reverse, so the magnitude of funding matters, not its sign. An
  // unmeasured rate cannot breach a limit — a kill switch that fires, or
  // declines to fire, on data nobody has is not a safety control.
  if (known(state.fundingRate) && Math.abs(state.fundingRate) > config.fundingKillAbs) {
    const rate = (state.fundingRate * 100).toFixed(3);
    return `FUNDING_BLOCK: Rate ${state.fundingRate >= 0 ? "+" : ""}${rate}% (max ±${(config.fundingKillAbs * 100).toFixed(2)}%)`;
  }
  return "";
}

function scoreSetup(signal, state, config = getTradingConfig()) {
  const long = signal.direction === "LONG";
  let score = 0;
  const reasons = [];

  // ── 1. Higher-timeframe trend alignment (30 pts) ────────────────────────
  const withTrend = long ? "BULLISH" : "BEARISH";
  const againstTrend = long ? "BEARISH" : "BULLISH";
  if (state.dailyBias === withTrend) {
    score += 30;
    reasons.push(`HTF: Daily bias ${withTrend} (+30)`);
  } else if (state.dailyBias === "NEUTRAL") {
    score += 15;
    reasons.push("HTF: Daily bias NEUTRAL (+15)");
  } else {
    reasons.push(`HTF: Daily bias ${againstTrend} (+0) — trading against trend`);
  }

  // ── 2. Macro filter (20 pts) ────────────────────────────────────────────
  //
  // Scored over the inputs that were actually MEASURED. Each known input
  // contributes to both the numerator and the denominator; an unmeasured one
  // contributes to neither, so absent data can neither help nor hurt a
  // direction. With all three present this is arithmetically identical to the
  // original — the thresholds are the same 2.5-of-3 and 2-of-3, expressed as a
  // fraction of what was available rather than of an assumed three.
  let macroGreen = 0;
  let macroKnown = 0;

  if (known(state.usdtDominanceSignal)) {
    macroKnown += 1;
    const wantedDominanceSignal = long ? "RISK_ON" : "RISK_OFF";
    if (state.usdtDominanceSignal === wantedDominanceSignal) macroGreen += 1;
    else if (state.usdtDominanceSignal === "NEUTRAL") macroGreen += 0.5;
  }

  if (known(state.btcDominanceRising)) {
    macroKnown += 1;
    macroGreen += (long ? !state.btcDominanceRising : state.btcDominanceRising) ? 1 : 0.5;
  }

  if (known(state.bearMarket)) {
    macroKnown += 1;
    if (long ? !state.bearMarket : state.bearMarket) macroGreen += 1;
  }

  if (macroKnown === 0) {
    // No macro feed at all. Absent evidence is not evidence FOR the trade, and
    // crucially it is not evidence for one direction over the other.
    reasons.push("Macro: no data (+0)");
  } else {
    const scale = macroKnown / 3;
    if (macroGreen >= 2.5 * scale) {
      score += 20;
      reasons.push(`Macro: All green (${macroGreen}/${macroKnown} measured) (+20)`);
    } else if (macroGreen >= 2 * scale) {
      score += 10;
      reasons.push(`Macro: Partial (${macroGreen}/${macroKnown} measured) (+10)`);
    } else {
      reasons.push(`Macro: Weak (${macroGreen}/${macroKnown} measured) (+0)`);
    }
  }

  // ── 3. Entry triggers (20 pts) ──────────────────────────────────────────
  let triggersFired = 0;
  if (state.macdBullish !== null && state.macdBullish !== undefined) {
    if (long === Boolean(state.macdBullish)) triggersFired += 1;
  }
  if (state.stochSignal) {
    const wanted = long ? "OVERSOLD_CROSS" : "OVERBOUGHT_CROSS";
    if (state.stochSignal === wanted) triggersFired += 1;
  }
  const haveTriggerData =
    (state.macdBullish !== null && state.macdBullish !== undefined) || Boolean(state.stochSignal);

  if (triggersFired === 2) {
    score += 20;
    reasons.push("Entry triggers: Both fired (+20)");
  } else if (triggersFired === 1) {
    score += 10;
    reasons.push("Entry triggers: One fired (+10)");
  } else if (haveTriggerData) {
    reasons.push("Entry triggers: None fired (+0)");
  } else {
    // Absent indicators are not evidence for the trade, so this defaults to
    // zero; MISSING_INDICATOR_POINTS can restore partial credit if wanted.
    score += config.missingIndicatorPoints;
    reasons.push(`Entry triggers: No indicator data (+${config.missingIndicatorPoints})`);
  }

  // ── 4. Volume confirmation (15 pts) ─────────────────────────────────────
  if (state.volumeRatio >= 1.5) {
    score += 15;
    reasons.push(`Volume: ${state.volumeRatio.toFixed(1)}x MA (+15)`);
  } else if (state.volumeRatio >= 1) {
    score += 7;
    reasons.push(`Volume: ${state.volumeRatio.toFixed(1)}x MA (+7)`);
  } else {
    reasons.push(`Volume: ${state.volumeRatio.toFixed(1)}x MA — below average (+0)`);
  }

  // ── 5. Volatility (10 pts) ──────────────────────────────────────────────
  if (state.atrRatio <= 1.5) {
    score += 10;
    reasons.push(`Volatility: ATR ${state.atrRatio.toFixed(1)}x avg — normal (+10)`);
  } else {
    reasons.push(`Volatility: ATR ${state.atrRatio.toFixed(1)}x avg — elevated (+0)`);
  }

  // ── 6. Funding / sentiment (5 pts) ──────────────────────────────────────
  // A rate of 0 is an observation ("funding is flat") and earns the points.
  // No rate at all is not, and does not — this block used to default to 0 and
  // pay every candidate for a feed nobody had.
  if (!known(state.fundingRate)) {
    reasons.push("Funding: no data (+0)");
  } else if (Math.abs(state.fundingRate) <= config.fundingNeutralAbs) {
    score += 5;
    reasons.push("Funding: Neutral (+5)");
  } else {
    const rate = (state.fundingRate * 100).toFixed(3);
    reasons.push(`Funding: ${state.fundingRate >= 0 ? "+" : ""}${rate}% — crowded (+0)`);
  }

  // The ceiling this candidate could actually have reached. With no macro
  // feed, no funding feed and no higher-timeframe read, 45 of the 100 points
  // are unavailable before the setup is looked at — so a score of 55 out of an
  // available 60 and a score of 55 out of 100 mean very different things, and
  // the decision thresholds below were written for the second. Reporting it
  // makes the distortion visible rather than silent; recalibrating the
  // thresholds for partial-evidence runs is a promotion-policy decision and
  // belongs with the rest of that policy, which does not exist yet.
  const availablePoints =
    // A NEUTRAL daily bias caps this block at +15 whichever way the trade
    // faces — there is no direction that earns the other 15 from it.
    (state.dailyBias === "NEUTRAL" ? 15 : 30) +
    (macroKnown === 0 ? 0 : 20) +
    (haveTriggerData ? 20 : config.missingIndicatorPoints) +
    15 + // volume, always measured
    10 + // volatility, always measured
    (known(state.fundingRate) ? 5 : 0);

  return { score, reasons, availablePoints };
}

function skip(reasons, score = 0, extra = {}) {
  return { decision: "SKIP", confidenceScore: score, sizeMultiplier: 0, reasons, warnings: [], killSwitch: false, killReason: "", ...extra };
}

function runChecklist(signal, rawState, config = getTradingConfig()) {
  const state = marketState(rawState);

  // 1. Kill switches — checked before anything else can earn points.
  const killReason = runKillSwitches(state, config);
  if (killReason) {
    return skip([`KILL SWITCH: ${killReason}`], 0, { killSwitch: true, killReason });
  }

  // 2. Regime gate.
  if (state.regime === "LOW_COMPRESSION") {
    return skip(["Regime: LOW_COMPRESSION — no entries allowed"]);
  }
  // The directional half of the gate is a trend-following house rule, and a
  // mean-reversion strategy is counter-trend BY DEFINITION — so applying it
  // unconditionally does not make reversion strategies safe, it makes them
  // untestable: every signal is refused before it can become evidence. A
  // strategy may therefore declare `allowCounterTrend`, which waives *only*
  // these two directional checks.
  //
  // Everything else still applies: kill switches ran above, LOW_COMPRESSION
  // still blocks, position and risk limits still bind, and the setup is still
  // scored — including the 30-point trend-alignment component, which a
  // counter-trend entry simply does not earn. A waived trade therefore has to
  // clear the 50-point floor on its other merits rather than being handed a
  // pass, and the waiver is recorded in `reasons` so no result is ambiguous
  // about which rules it ran under.
  const counterTrend =
    (signal.direction === "LONG" && state.regime === "TREND_DOWN") ||
    (signal.direction === "SHORT" && state.regime === "TREND_UP");
  const waivedReasons = [];

  if (counterTrend) {
    if (!signal.allowCounterTrend) {
      return skip([`Regime: ${state.regime} — ${signal.direction === "LONG" ? "longs" : "shorts"} forbidden`]);
    }
    waivedReasons.push(
      `Regime: ${state.regime} — counter-trend entry allowed by strategy declaration (trend alignment scores 0)`,
    );
  }

  // 3. Position limits.
  if (state.openPositions >= config.maxOpenPositions) {
    return skip([`Max positions (${config.maxOpenPositions}) already open`]);
  }
  if (state.totalRiskPct >= config.maxTotalRiskPct) {
    return skip([`Total account risk at max (${config.maxTotalRiskPct.toFixed(0)}%)`]);
  }

  const warnings = [];
  // `=== true` throughout: an unknown bear-market state must not read as
  // "not a bear market" and waive the gate, nor as "bear market" and impose
  // it. Unknown means the gate has nothing to act on, which is what a missing
  // `false` did by accident and now does on purpose.
  if (signal.direction === "LONG" && state.bearMarket === true) {
    warnings.push("Bear market: Long requires 80+ score");
  }
  if (state.dxyBullish) {
    warnings.push("DXY bullish: Reducing size by 25%");
  }

  // 4. Score the setup.
  const { score, reasons: scoreReasons, availablePoints } = scoreSetup(signal, state, config);
  const reasons = [...waivedReasons, ...scoreReasons];

  if (signal.direction === "LONG" && state.bearMarket === true && score < 80) {
    reasons.unshift(`Bear market long blocked — need 80+ score, got ${score}`);
    return { ...skip(reasons, score), warnings };
  }

  // 5. Size decision.
  const dxyPenalty = state.dxyBullish ? 0.75 : 1;
  let decision;
  let multiplier;
  if (score >= 80) {
    decision = "TAKE_FULL";
    multiplier = 1 * dxyPenalty;
    reasons.unshift(`Score ${score}/100 — FULL SIZE`);
  } else if (score >= 65) {
    decision = "TAKE_HALF";
    multiplier = 0.5 * dxyPenalty;
    reasons.unshift(`Score ${score}/100 — HALF SIZE`);
  } else if (score >= 50) {
    decision = "TAKE_QUARTER";
    multiplier = 0.25 * dxyPenalty;
    reasons.unshift(`Score ${score}/100 — QUARTER SIZE`);
  } else {
    decision = "SKIP";
    multiplier = 0;
    reasons.unshift(`Score ${score}/100 — SKIP`);
  }

  return {
    decision,
    confidenceScore: score,
    // Out of how many points were actually reachable given the feeds present.
    // 100 when everything is measured; 60 for a candle backtest with no macro,
    // no funding and no higher-timeframe read.
    availablePoints,
    sizeMultiplier: multiplier,
    reasons,
    warnings,
    killSwitch: false,
    killReason: "",
  };
}

module.exports = { marketState, runKillSwitches, scoreSetup, runChecklist };
