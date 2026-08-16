"use strict";

// Universal account safety — the only thing allowed to stop a demo account
// from taking its own strategy's signal.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// A demo account answers one question: "how does THIS strategy perform?" It
// only answers it if the strategy's signal is authoritative. Running a valid
// SMC setup — trend, break of structure, displacement, fair value gap, retest —
// through a second, generic opinion about volume and MACD and daily bias, and
// letting that opinion veto, does not measure SMC. It measures
//
//   SMC + whatever the generic filter thought
//
// which is a different strategy that nobody designed and nobody can reason
// about. The checklist and the edge gate still RUN on the live-research path,
// and their verdicts are recorded — they are useful analytics, and a
// disagreement between "the strategy wanted this" and "the checklist hated it"
// is itself a finding. They just no longer decide.
//
// ── What may still stop a trade ─────────────────────────────────────────────
//
// Only facts about the ACCOUNT, never opinions about the setup:
//
//   * a breached daily or weekly loss limit
//   * a consecutive-loss streak
//   * the open-position cap
//   * the total-risk cap
//   * geometry that cannot be traded (no valid stop, or a zero size)
//
// Every one of those is true regardless of which strategy asked, and none of
// them is a judgement about whether the setup is good. Volume, MACD, funding,
// news windows, volatility spikes and regime gates are all strategy opinions
// and belong to the strategy that holds them — vwap_reversion_v1 already
// refuses to trade above ADX 22 on its own, which is exactly where that rule
// should live.
//
// ── Why a refusal is recorded rather than silent ────────────────────────────
//
// "The strategy saw nothing" and "the strategy wanted to trade and the account
// could not" are completely different facts about a research run, and a demo
// account that shows a flat line without distinguishing them is unreadable. So
// every refusal carries a machine-readable code and a human reason, and the
// runner records the signal it could not take.

// Codes are stable strings so a dashboard can group refusals without parsing
// prose.
const SAFETY_CODES = Object.freeze({
  DAILY_LOSS_LIMIT: "DAILY_LOSS_LIMIT",
  WEEKLY_LOSS_LIMIT: "WEEKLY_LOSS_LIMIT",
  CONSECUTIVE_LOSSES: "CONSECUTIVE_LOSSES",
  MAX_OPEN_POSITIONS: "MAX_OPEN_POSITIONS",
  MAX_TOTAL_RISK: "MAX_TOTAL_RISK",
  POSITION_ALREADY_OPEN: "POSITION_ALREADY_OPEN",
  UNTRADEABLE_GEOMETRY: "UNTRADEABLE_GEOMETRY",
});

function refuse(code, reason) {
  return { ok: false, code, reason };
}

/**
 * May this account take a new position right now?
 *
 * `riskState` is PaperTradingService#getRiskState — the real ledger, never a
 * caller-supplied hope. `openSymbols` are the symbols this account already
 * holds, so one strategy cannot stack two positions on the same pair while
 * still being free to trade the other nineteen.
 */
function checkAccountSafety({ riskState, config, symbol = null, openSymbols = [] }) {
  const state = riskState || {};

  // Loss limits first: a breached limit means the account should not be
  // trading at all, whatever the geometry looks like.
  if (Number(state.dailyLossPct) >= config.dailyLossLimitPct) {
    return refuse(
      SAFETY_CODES.DAILY_LOSS_LIMIT,
      `Daily loss ${Number(state.dailyLossPct).toFixed(1)}% has reached the ${config.dailyLossLimitPct}% limit`,
    );
  }
  if (Number(state.weeklyLossPct) >= config.weeklyLossLimitPct) {
    return refuse(
      SAFETY_CODES.WEEKLY_LOSS_LIMIT,
      `Weekly loss ${Number(state.weeklyLossPct).toFixed(1)}% has reached the ${config.weeklyLossLimitPct}% limit`,
    );
  }
  if (Number(state.consecutiveLosses) >= config.maxConsecutiveLosses) {
    return refuse(
      SAFETY_CODES.CONSECUTIVE_LOSSES,
      `${state.consecutiveLosses} consecutive losses reached the limit of ${config.maxConsecutiveLosses}`,
    );
  }

  // One position per symbol per account. Across a 20-pair universe this is the
  // difference between "SMC is long ETH" and "SMC is long ETH four times".
  if (symbol && openSymbols.includes(symbol)) {
    return refuse(SAFETY_CODES.POSITION_ALREADY_OPEN, `A position is already open on ${symbol}`);
  }

  // Capacity. These are the two that bite hardest on a multi-symbol account,
  // and the reason a refusal has to be recorded: with twenty pairs producing
  // signals, a cap that silently swallows the last eighteen would leave the
  // account measuring signal arrival order rather than the strategy.
  if (Number(state.openPositions) >= config.maxOpenPositions) {
    return refuse(
      SAFETY_CODES.MAX_OPEN_POSITIONS,
      `Account is holding ${state.openPositions} positions, the maximum is ${config.maxOpenPositions}`,
    );
  }
  if (Number(state.totalRiskPct) >= config.maxTotalRiskPct) {
    return refuse(
      SAFETY_CODES.MAX_TOTAL_RISK,
      `Open risk ${Number(state.totalRiskPct).toFixed(1)}% has reached the ${config.maxTotalRiskPct.toFixed(0)}% account cap`,
    );
  }

  return { ok: true, code: null, reason: null };
}

/**
 * Can this trade actually be placed?
 *
 * Geometry, not judgement: a stop on the wrong side of the entry or a size that
 * rounds to nothing cannot become a position no matter how good the setup is.
 */
function checkTradeGeometry(trade) {
  if (!trade || trade.ok === false) {
    return refuse(SAFETY_CODES.UNTRADEABLE_GEOMETRY, (trade && trade.reason) || "No tradeable levels were produced");
  }
  if (!(Number(trade.size) > 0)) {
    return refuse(SAFETY_CODES.UNTRADEABLE_GEOMETRY, "Position size rounds to zero at this account's risk budget");
  }
  const long = trade.direction === "LONG";
  const stop = Number(trade.stopLoss);
  if (!Number.isFinite(stop) || (long ? !(stop < trade.entryPrice) : !(stop > trade.entryPrice))) {
    return refuse(
      SAFETY_CODES.UNTRADEABLE_GEOMETRY,
      `Stop ${trade.stopLoss} is not on the correct side of a ${trade.direction} entry at ${trade.entryPrice}`,
    );
  }
  return { ok: true, code: null, reason: null };
}

module.exports = { SAFETY_CODES, checkAccountSafety, checkTradeGeometry };
