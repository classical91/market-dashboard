"use strict";

const fs = require("fs");
const path = require("path");

const { buildStrategyMetrics, calculateTradeMetrics, round } = require("./metrics");

const STRATEGY_ID = "shadow_bananagun_v1";
const STRATEGY_NAME = "Shadow Banana Gun v1";

const DEFAULT_COSTS = Object.freeze({
  positionUsd: 100,
  gasUsd: 18,
  slippagePct: 0.08,
  mevPenaltyPct: 0.03,
  failedTxPct: 0.02,
  failedTxGasUsd: 18,
  minLiquidityUsd: 75_000,
  maxTopHolderPct: 20,
  minTokenAgeMinutes: 20,
  maxBuyTaxPct: 8,
  maxSellTaxPct: 8,
  maxContractRiskScore: 35,
  maxSignalAgeSeconds: 180,
  duplicateWindowSeconds: 3600,
  dailyExposureCapUsd: 500,
  dailyAlertCap: 10,
  paperMinScore: 75,
});

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolValue(value) {
  if (value === true || value === false) return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return value;
}

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(String(value).replace("Z", "+00:00"));
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function eventKey(event) {
  return String(event.id || event.event_id || event.candidate_id || "").trim();
}

function tokenKey(event) {
  return String(
    event.token_address ||
      event.tokenAddress ||
      event.pair_address ||
      event.pairAddress ||
      event.symbol ||
      "",
  ).toLowerCase();
}

function readJsonDataset(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function datasetPath(dataDir, strategyId = STRATEGY_ID) {
  return path.join(dataDir || process.cwd(), "trading-lab", "event-replay", strategyId, "candidates.jsonl");
}

function loadEventDataset(dataDir, strategyId = STRATEGY_ID) {
  const file = datasetPath(dataDir, strategyId);
  if (!fs.existsSync(file)) {
    return { status: "insufficient-data", path: file, events: [] };
  }
  const events = readJsonDataset(file);
  return {
    status: events.length ? "available" : "insufficient-data",
    path: file,
    events,
  };
}

function safetySnapshot(event) {
  return { ...(event.safety || {}), ...event };
}

function validateEvent(event, seen, cfg) {
  const reasons = [];
  const safety = safetySnapshot(event);
  const signalAt = parseTime(event.signal_timestamp || event.signalTimestamp || event.timestamp);
  const observedAt = parseTime(event.observed_at || event.observedAt || event.evaluated_at || event.ingested_at) || signalAt;
  const safetyAt = parseTime(
    (event.safety && (event.safety.observed_at || event.safety.observedAt)) ||
      event.safety_observed_at ||
      event.safetyObservedAt,
  );
  const outcome = event.outcome || {};
  const exitAt = parseTime(outcome.exit_timestamp || event.exit_timestamp || event.exitTimestamp);
  const key = tokenKey(event);

  for (const field of ["symbol", "chain"]) {
    if (!event[field]) reasons.push(`missing candidate field: ${field}`);
  }
  if (!key) reasons.push("missing candidate field: token_address");
  if (!signalAt) reasons.push("missing or invalid signal timestamp");
  if (safetyAt && signalAt && safetyAt > signalAt) reasons.push("safety snapshot is after the signal");
  if (observedAt && signalAt && (observedAt - signalAt) / 1000 > cfg.maxSignalAgeSeconds) {
    reasons.push("stale signal");
  }

  const requiredSafety = [
    "liquidity_usd",
    "top_holder_pct",
    "token_age_minutes",
    "honeypot",
    "sellable",
    "buy_tax_pct",
    "sell_tax_pct",
    "contract_risk_score",
  ];
  const missingSafety = requiredSafety.filter((field) => safety[field] === undefined || safety[field] === null);
  if (missingSafety.length) reasons.push(`missing safety data: ${missingSafety.join(", ")}`);

  const liquidity = num(safety.liquidity_usd);
  const topHolder = num(safety.top_holder_pct);
  const tokenAge = num(safety.token_age_minutes);
  const buyTax = num(safety.buy_tax_pct);
  const sellTax = num(safety.sell_tax_pct);
  const contractRisk = num(safety.contract_risk_score);

  if (liquidity !== null && liquidity < cfg.minLiquidityUsd) reasons.push("liquidity below minimum");
  if (topHolder !== null && topHolder > cfg.maxTopHolderPct) reasons.push("holder concentration too high");
  if (tokenAge !== null && tokenAge < cfg.minTokenAgeMinutes) reasons.push("token age below minimum");
  if (boolValue(safety.honeypot) !== false) reasons.push("honeypot/sellability risk");
  if (boolValue(safety.sellable) !== true) reasons.push("token is not confirmed sellable");
  if (buyTax !== null && buyTax > cfg.maxBuyTaxPct) reasons.push("buy tax too high");
  if (sellTax !== null && sellTax > cfg.maxSellTaxPct) reasons.push("sell tax too high");
  if (contractRisk !== null && contractRisk > cfg.maxContractRiskScore) reasons.push("contract risk too high");

  const id = eventKey(event);
  if (id && seen.ids.has(id)) reasons.push("duplicate event id");
  if (key) {
    const last = seen.tokens.get(key);
    if (last && observedAt && observedAt - last <= cfg.duplicateWindowSeconds * 1000) {
      reasons.push("duplicate candidate");
    }
  }

  if (!num(event.entry_price_usd || event.entryPriceUsd, null)) reasons.push("missing entry price");
  const exitPrice = num((event.outcome || {}).exit_price_usd || event.exit_price_usd || event.exitPriceUsd, null);
  if (exitPrice === null) reasons.push("missing historical exit outcome");
  if (exitAt && signalAt && exitAt < signalAt) reasons.push("exit outcome predates signal");

  return { reasons, observedAt: observedAt || signalAt || 0, signalAt, exitAt, safety };
}

function costModel(event, cfg) {
  const outcome = event.outcome || {};
  const notional = num(event.position_usd || event.positionUsd, cfg.positionUsd);
  const entry = num(event.entry_price_usd || event.entryPriceUsd, 0);
  const exitPrice = num(outcome.exit_price_usd || event.exit_price_usd || event.exitPriceUsd, entry);
  const riskUsd = num(event.risk_usd || event.riskUsd, Math.max(notional * 0.35, 1));
  const safety = safetySnapshot(event);
  const buyTax = (num(safety.buy_tax_pct, 0) || 0) / 100;
  const sellTax = (num(safety.sell_tax_pct, 0) || 0) / 100;
  const failedTxs = Math.max(0, Math.trunc(num(outcome.failed_txs || event.failed_txs, 0) || 0));

  const grossExit = entry > 0 ? notional * (exitPrice / entry) : 0;
  const buyCost = cfg.gasUsd + notional * (cfg.slippagePct + cfg.mevPenaltyPct + cfg.failedTxPct + buyTax);
  const sellCost = cfg.gasUsd + grossExit * (cfg.slippagePct + cfg.mevPenaltyPct + cfg.failedTxPct + sellTax);
  const failedTxCost = failedTxs * cfg.failedTxGasUsd;
  const pnl = grossExit - notional - buyCost - sellCost - failedTxCost;

  return {
    notionalUsd: round(notional),
    entryPriceUsd: entry,
    exitPriceUsd: exitPrice,
    buyCostUsd: round(buyCost, 4),
    sellCostUsd: round(sellCost, 4),
    failedTxCostUsd: round(failedTxCost, 4),
    totalCostUsd: round(buyCost + sellCost + failedTxCost, 4),
    riskUsd: round(riskUsd),
    simulatedPnlUsd: round(pnl, 4),
    rMultiple: round(riskUsd ? pnl / riskUsd : 0, 4),
    assumptions: {
      gasUsd: cfg.gasUsd,
      slippagePct: cfg.slippagePct,
      mevPenaltyPct: cfg.mevPenaltyPct,
      failedTxPct: cfg.failedTxPct,
      failedTxGasUsd: cfg.failedTxGasUsd,
      buyTaxPct: buyTax * 100,
      sellTaxPct: sellTax * 100,
    },
  };
}

function dailyRows(rows, observedAt) {
  const day = iso(observedAt).slice(0, 10);
  return rows.filter((row) => String(row.observedAt || "").startsWith(day));
}

function replayBananaGunEvents({ events, dataSource = "fixture", config = {} } = {}) {
  const cfg = { ...DEFAULT_COSTS, ...config };
  const ordered = [...(events || [])].sort((a, b) => {
    const atA = parseTime(a.observed_at || a.observedAt || a.signal_timestamp || a.signalTimestamp) || 0;
    const atB = parseTime(b.observed_at || b.observedAt || b.signal_timestamp || b.signalTimestamp) || 0;
    return atA - atB;
  });

  if (!ordered.length) {
    return insufficientData({ dataSource, reason: "No historical candidate events available" });
  }

  const seen = { ids: new Set(), tokens: new Map() };
  const candidates = [];
  const trades = [];
  const signals = [];

  for (const event of ordered) {
    const checked = validateEvent(event, seen, cfg);
    const observedAt = checked.observedAt || Date.now();
    const key = tokenKey(event);
    const id = eventKey(event);
    const sameDay = dailyRows(candidates, observedAt);
    const notional = num(event.position_usd || event.positionUsd, cfg.positionUsd);
    const exposure = sameDay.reduce((sum, row) => sum + num(row.costModel && row.costModel.notionalUsd, 0), 0);
    const reasons = [...checked.reasons];
    if (sameDay.length >= cfg.dailyAlertCap) reasons.push("daily alert cap reached");
    if (exposure + notional > cfg.dailyExposureCapUsd) reasons.push("daily exposure cap reached");

    const score = num(event.confluence_score || event.confluenceScore, 0);
    const cm = costModel(event, cfg);
    const verdict = reasons.length ? "REJECT" : score >= cfg.paperMinScore ? "PAPER" : "WATCH";

    const candidate = {
      id: id || `${key}:${iso(observedAt)}`,
      observedAt: iso(observedAt),
      signalAt: checked.signalAt ? iso(checked.signalAt) : null,
      tokenKey: key,
      symbol: event.symbol || null,
      verdict,
      reasons,
      confluenceScore: score,
      costModel: cm,
    };
    candidates.push(candidate);
    signals.push({
      at: candidate.observedAt,
      signal: verdict === "PAPER" ? "LONG" : "FLAT",
      price: cm.entryPriceUsd,
      reasons,
      indicators: {
        confluenceScore: score,
        liquidityUsd: num(checked.safety.liquidity_usd),
        topHolderPct: num(checked.safety.top_holder_pct),
        tokenAgeMinutes: num(checked.safety.token_age_minutes),
      },
      confidence: score,
    });

    if (id) seen.ids.add(id);
    if (key) seen.tokens.set(key, observedAt);

    if (verdict === "PAPER") {
      trades.push({
        id: `${STRATEGY_ID}:${candidate.id}`,
        status: "closed",
        symbol: event.symbol,
        direction: "LONG",
        strategy: STRATEGY_ID,
        signalSource: STRATEGY_ID,
        confidenceScore: score,
        entryPrice: cm.entryPriceUsd,
        exitPrice: cm.exitPriceUsd,
        riskUsd: cm.riskUsd,
        realizedPnl: cm.simulatedPnlUsd,
        rMultiple: cm.rMultiple,
        openedAt: candidate.observedAt,
        closedAt: checked.exitAt ? iso(checked.exitAt) : candidate.observedAt,
        closeReason: "EVENT_REPLAY_EXIT",
        costModel: cm,
      });
    }
  }

  const riskMetrics = calculateTradeMetrics(trades, 10_000);
  const winRate = trades.length
    ? round((trades.filter((trade) => num(trade.realizedPnl, 0) > 0).length / trades.length) * 100)
    : 0;

  return {
    status: "ok",
    replayType: "event-replay",
    dataStatus: "available",
    dataSource,
    strategy: STRATEGY_ID,
    strategyName: STRATEGY_NAME,
    symbol: "ONCHAIN",
    interval: "event",
    bars: ordered.length,
    warmupBars: 0,
    from: candidates[0].observedAt,
    to: candidates[candidates.length - 1].observedAt,
    options: {},
    costs: { ...DEFAULT_COSTS, ...config },
    stats: {
      startingBalance: 10_000,
      totalTrades: trades.length,
      winRate,
      realizedPnl: riskMetrics.netReturnUsd,
      riskMetrics,
    },
    metrics: buildStrategyMetrics(trades, 10_000),
    trades,
    openAtEnd: [],
    skipped: candidates.filter((c) => c.verdict !== "PAPER").map((c) => ({ at: c.observedAt, direction: "LONG", reasons: c.reasons })),
    signals,
    equityCurve: trades.reduce((rows, trade) => {
      const prior = rows.length ? rows[rows.length - 1].equity : 10_000;
      rows.push({ at: trade.closedAt, close: trade.exitPrice, balance: round(prior + trade.realizedPnl), equity: round(prior + trade.realizedPnl), openPositions: 0 });
      return rows;
    }, []),
    caveats: [],
    dataset: {
      status: "available",
      source: dataSource,
      events: ordered.length,
      pointInTime: true,
    },
  };
}

function insufficientData({ dataSource, reason }) {
  const riskMetrics = calculateTradeMetrics([], 10_000);
  return {
    status: "insufficient-data",
    replayType: "event-replay",
    dataStatus: "insufficient-data",
    dataSource,
    strategy: STRATEGY_ID,
    strategyName: STRATEGY_NAME,
    symbol: "ONCHAIN",
    interval: "event",
    bars: 0,
    warmupBars: 0,
    from: null,
    to: null,
    options: {},
    costs: { ...DEFAULT_COSTS },
    stats: { startingBalance: 10_000, totalTrades: 0, winRate: 0, realizedPnl: 0, riskMetrics },
    metrics: buildStrategyMetrics([], 10_000),
    trades: [],
    openAtEnd: [],
    skipped: [],
    signals: [],
    equityCurve: [],
    caveats: [reason],
    dataset: {
      status: "insufficient-data",
      source: dataSource,
      events: 0,
      pointInTime: true,
      reason,
    },
  };
}

module.exports = {
  STRATEGY_ID,
  DEFAULT_COSTS,
  datasetPath,
  loadEventDataset,
  replayBananaGunEvents,
  insufficientData,
};
