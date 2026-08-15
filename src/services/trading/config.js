"use strict";

// Trading Lab configuration — the single source of truth for risk sizing,
// position limits, kill-switch thresholds and volatility assumptions, ported
// from TraderClaw's config.py. Every Trading Lab module reads its numbers from
// here rather than re-reading process.env, so a change to risk policy happens
// in exactly one place and paper results stay comparable across runs.
//
// Environment variable names match TraderClaw's so an existing deployment's
// settings carry over unchanged.

class TradingConfigError extends Error {}

function envString(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function envNumber(name, fallback) {
  const raw = envString(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new TradingConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function envInt(name, fallback) {
  return Math.trunc(envNumber(name, fallback));
}

function envBool(name, fallback) {
  const raw = envString(name, undefined);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function validate(config) {
  if (config.accountSize <= 0) {
    throw new TradingConfigError("ACCOUNT_SIZE must be positive");
  }
  if (!(config.maxRiskPerTrade > 0 && config.maxRiskPerTrade <= 0.1)) {
    throw new TradingConfigError("MAX_RISK_PER_TRADE must be in (0, 0.1] — it is a fraction, not a percent");
  }
  if (!(config.maxTotalRisk > 0 && config.maxTotalRisk <= 1)) {
    throw new TradingConfigError("MAX_TOTAL_RISK must be in (0, 1]");
  }
  if (config.maxRiskPerTrade > config.maxTotalRisk) {
    throw new TradingConfigError("MAX_RISK_PER_TRADE cannot exceed MAX_TOTAL_RISK");
  }
  if (config.maxOpenPositions < 1) {
    throw new TradingConfigError("MAX_OPEN_POSITIONS must be at least 1");
  }
  if (!(config.atrFallbackPct > 0 && config.atrFallbackPct < 1)) {
    throw new TradingConfigError("ATR_FALLBACK_PCT must be in (0, 1)");
  }
  if (config.slAtrMultiple <= 0) {
    throw new TradingConfigError("SL_ATR_MULTIPLE must be positive");
  }
  if (!(config.tp1CloseFraction > 0 && config.tp1CloseFraction < 1)) {
    throw new TradingConfigError(
      "TP1_CLOSE_FRACTION must be in (0, 1) — 1.0 would close the whole position at TP1",
    );
  }
  if (config.tp2RMultiple <= config.tp1RMultiple) {
    throw new TradingConfigError("TP2_R_MULTIPLE must be greater than TP1_R_MULTIPLE");
  }
  if (!["next-day", "never"].includes(config.consecutiveLossCooloff)) {
    throw new TradingConfigError(
      `CONSECUTIVE_LOSS_COOLOFF must be 'next-day' or 'never', got ${JSON.stringify(config.consecutiveLossCooloff)}`,
    );
  }
  if (config.tradingMode !== "paper" && config.tradingMode !== "live") {
    throw new TradingConfigError(`TRADING_MODE must be 'paper' or 'live', got ${JSON.stringify(config.tradingMode)}`);
  }
  for (const [key, value] of Object.entries({
    takerFeeRate: config.takerFeeRate,
    slippageRate: config.slippageRate,
    fundingRate8h: config.fundingRate8h,
  })) {
    if (!Number.isFinite(value)) {
      throw new TradingConfigError(`${key} must be finite`);
    }
  }
  if (config.takerFeeRate < 0 || config.slippageRate < 0) {
    throw new TradingConfigError("Trading cost rates cannot be negative");
  }
  // Live trading needs every safety belt fastened before startup succeeds.
  if (config.tradingMode === "live" && !config.allowLiveTrading) {
    throw new TradingConfigError(
      "TRADING_MODE=live requires ALLOW_LIVE_TRADING=true. Refusing to start in an ambiguous live/paper state.",
    );
  }
}

function loadTradingConfig(overrides = {}) {
  const config = {
    // ── Mode ────────────────────────────────────────────────────────────────
    // Live execution needs both gates to agree; see `liveEnabled` below. A
    // single mistaken environment variable can never send a real order.
    tradingMode: String(envString("TRADING_MODE", "paper")).trim().toLowerCase(),
    allowLiveTrading: envBool("ALLOW_LIVE_TRADING", false),

    // ── Risk ────────────────────────────────────────────────────────────────
    accountSize: envNumber("ACCOUNT_SIZE", 10000),
    maxRiskPerTrade: envNumber("MAX_RISK_PER_TRADE", 0.01),
    maxTotalRisk: envNumber("MAX_TOTAL_RISK", 0.04),
    maxOpenPositions: envInt("MAX_OPEN_POSITIONS", 3),

    // ── Volatility assumptions ──────────────────────────────────────────────
    // Used only when an incoming signal carries no ATR. One value for every
    // code path — two different synthetic volatility assumptions would make
    // paper results incomparable.
    atrFallbackPct: envNumber("ATR_FALLBACK_PCT", 0.01),
    slAtrMultiple: envNumber("SL_ATR_MULTIPLE", 1.5),
    tp1RMultiple: envNumber("TP1_R_MULTIPLE", 1.5),
    tp2RMultiple: envNumber("TP2_R_MULTIPLE", 2.5),

    // ── Trade management ────────────────────────────────────────────────────
    tp1CloseFraction: envNumber("TP1_CLOSE_FRACTION", 0.5),
    moveStopToBreakevenAtTp1: envBool("MOVE_STOP_TO_BREAKEVEN_AT_TP1", true),

    // ── Execution costs ─────────────────────────────────────────────────────
    // Rates are decimal fractions: 0.0006 = 0.06%. Defaults keep legacy paper
    // math unchanged until a deployment opts into realistic costs.
    takerFeeRate: envNumber("BACKTEST_TAKER_FEE_RATE", 0),
    slippageRate: envNumber("BACKTEST_SLIPPAGE_RATE", 0),
    fundingRate8h: envNumber("BACKTEST_FUNDING_RATE_8H", 0),

    // ── Kill switches ───────────────────────────────────────────────────────
    dailyLossLimitPct: envNumber("DAILY_LOSS_LIMIT_PCT", 3),
    weeklyLossLimitPct: envNumber("WEEKLY_LOSS_LIMIT_PCT", 6),
    maxConsecutiveLosses: envInt("MAX_CONSECUTIVE_LOSSES", 3),
    // What the consecutive-loss breaker MEANS once it has fired.
    //
    //   "next-day"  (default) A cooling-off period: entries are blocked for
    //               the rest of the UTC day the streak completed on, and the
    //               streak clears at the next day boundary.
    //   "never"     The streak clears only on a winning trade.
    //
    // "never" is an absorbing state, and deliberately so if you choose it: no
    // trade can open, so no trade can win, so the streak never clears and the
    // book is halted permanently. That is a defensible policy for real money
    // and a useless one for research, where it silently truncates a replay to
    // however many bars it took to lose three times. Naming the policy is the
    // point — the old behaviour was "never" by omission rather than by
    // decision.
    consecutiveLossCooloff: String(envString("CONSECUTIVE_LOSS_COOLOFF", "next-day")).trim().toLowerCase(),
    maxAtrRatio: envNumber("MAX_ATR_RATIO", 3),
    fundingKillAbs: envNumber("FUNDING_KILL_ABS", 0.001),
    fundingNeutralAbs: envNumber("FUNDING_NEUTRAL_ABS", 0.0005),

    // ── Scoring ─────────────────────────────────────────────────────────────
    // Points awarded when entry-trigger indicators are absent. Missing data is
    // not evidence for a trade, so this defaults to zero.
    missingIndicatorPoints: envInt("MISSING_INDICATOR_POINTS", 0),

    // ── Edge gate ───────────────────────────────────────────────────────────
    edgeMinSampleTrades: envInt("EDGE_MIN_SAMPLE_TRADES", 20),
    edgeMinExpectancyR: envNumber("EDGE_MIN_EXPECTANCY_R", 0.05),
    edgeMinProfitFactor: envNumber("EDGE_MIN_PROFIT_FACTOR", 1.1),
    edgeMaxDrawdownPct: envNumber("EDGE_MAX_DRAWDOWN_PCT", 15),
    edgeSoftDrawdownPct: envNumber("EDGE_SOFT_DRAWDOWN_PCT", 10),
    edgeSoftExpectancyR: envNumber("EDGE_SOFT_EXPECTANCY_R", 0.15),

    ...overrides,
  };

  // Derived values, kept out of the override surface so they can never drift
  // from the fractions they come from.
  config.maxTotalRiskPct = config.maxTotalRisk * 100;
  config.riskUsdPerTrade = config.accountSize * config.maxRiskPerTrade;
  // Both gates must agree before any live order path is reachable.
  config.liveEnabled = config.tradingMode === "live" && config.allowLiveTrading === true;

  validate(config);
  return config;
}

let cached = null;

function getTradingConfig() {
  if (!cached) cached = loadTradingConfig();
  return cached;
}

// Tests and the Trading Lab's what-if runs build a config without touching the
// process environment.
function makeTradingConfig(overrides = {}) {
  return loadTradingConfig(overrides);
}

function resetTradingConfig() {
  cached = null;
}

module.exports = {
  TradingConfigError,
  loadTradingConfig,
  makeTradingConfig,
  getTradingConfig,
  resetTradingConfig,
};
