"use strict";

// Local audit of the recovered Mindset v1 Pine strategy. This intentionally
// lives outside mindset_v1: it reproduces the Pine wrapper's signal, sizing,
// single-position rule, and two-stage exits without changing the production
// strategy or the shared Trading Lab executor.

const { ema, rsi } = require("../signal-screener");
const { atrSeries } = require("./strategies/mindset-v1-rules");

const DEFAULTS = Object.freeze({
  initialCapital: 10000,
  riskPct: 1,
  fastLen: 20,
  slowLen: 50,
  rsiLen: 14,
  atrLen: 14,
  rsiLongMin: 50,
  rsiLongMax: 75,
  rsiShortMin: 25,
  rsiShortMax: 50,
  slAtrMult: 1.5,
  tp1R: 1.5,
  tp2R: 2.5,
  tp1ClosePct: 50,
  moveToBE: true,
  marginPercent: 1,
});

function fillPnl(position, price, quantity) {
  const direction = position.direction === "LONG" ? 1 : -1;
  return direction * (price - position.entry) * quantity;
}

function closeQuantity(state, price, quantity, reason, barIndex) {
  const position = state.position;
  const fillQty = Math.min(quantity, position.remainingQty);
  if (!(fillQty > 0)) return;
  const pnl = fillPnl(position, price, fillQty);
  position.realizedPnl += pnl;
  position.remainingQty -= fillQty;
  state.equity += pnl;
  position.fills.push({ barIndex, price, quantity: fillQty, reason, pnl });

  if (position.remainingQty <= position.qty * 1e-10) {
    position.remainingQty = 0;
    state.closed.push({
      direction: position.direction,
      entryIndex: position.entryIndex,
      exitIndex: barIndex,
      durationBars: barIndex - position.entryIndex,
      pnl: position.realizedPnl,
      fills: position.fills,
    });
    state.position = null;
  }
}

function processPoint(state, price, barIndex) {
  const p = state.position;
  if (!p) return;
  if (p.direction === "LONG") {
    if (price <= p.activeRunnerStop) {
      closeQuantity(state, price, p.remainingQty, "stop-gap", barIndex);
    } else if (!p.tp1Filled && price >= p.tp1) {
      closeQuantity(state, price, p.tp1Qty, "tp1-gap", barIndex);
      if (state.position) state.position.tp1Filled = true;
      if (state.position && price >= state.position.tp2) {
        closeQuantity(state, price, state.position.remainingQty, "tp2-gap", barIndex);
      }
    } else if (p.tp1Filled && price >= p.tp2) {
      closeQuantity(state, price, p.remainingQty, "tp2-gap", barIndex);
    }
  } else if (price >= p.activeRunnerStop) {
    closeQuantity(state, price, p.remainingQty, "stop-gap", barIndex);
  } else if (!p.tp1Filled && price <= p.tp1) {
    closeQuantity(state, price, p.tp1Qty, "tp1-gap", barIndex);
    if (state.position) state.position.tp1Filled = true;
    if (state.position && price <= state.position.tp2) {
      closeQuantity(state, price, state.position.remainingQty, "tp2-gap", barIndex);
    }
  } else if (p.tp1Filled && price <= p.tp2) {
    closeQuantity(state, price, p.remainingQty, "tp2-gap", barIndex);
  }
}

function processSegment(state, from, to, barIndex) {
  const p = state.position;
  if (!p || from === to) return;
  const rising = to > from;

  if (p.direction === "LONG") {
    if (!rising && to <= p.activeRunnerStop && from > p.activeRunnerStop) {
      closeQuantity(state, p.activeRunnerStop, p.remainingQty, "stop", barIndex);
      return;
    }
    if (rising) {
      if (!p.tp1Filled && from < p.tp1 && to >= p.tp1) {
        closeQuantity(state, p.tp1, p.tp1Qty, "tp1", barIndex);
        if (state.position) state.position.tp1Filled = true;
      }
      if (state.position && state.position.tp1Filled && from < state.position.tp2 && to >= state.position.tp2) {
        closeQuantity(state, state.position.tp2, state.position.remainingQty, "tp2", barIndex);
      }
    }
    return;
  }

  if (rising && to >= p.activeRunnerStop && from < p.activeRunnerStop) {
    closeQuantity(state, p.activeRunnerStop, p.remainingQty, "stop", barIndex);
    return;
  }
  if (!rising) {
    if (!p.tp1Filled && from > p.tp1 && to <= p.tp1) {
      closeQuantity(state, p.tp1, p.tp1Qty, "tp1", barIndex);
      if (state.position) state.position.tp1Filled = true;
    }
    if (state.position && state.position.tp1Filled && from > state.position.tp2 && to <= state.position.tp2) {
      closeQuantity(state, state.position.tp2, state.position.remainingQty, "tp2", barIndex);
    }
  }
}

// TradingView's documented historical broker-emulator path: the nearer
// extreme to the open is visited first, followed by the opposite extreme and
// the close. Exit orders were submitted on the prior calculation, so a TP1
// touch only moves the runner stop to breakeven for the next bar.
function processBar(state, candle, barIndex, moveToBE) {
  if (!state.position) return;
  const nearerHigh = Math.abs(candle.open - candle.high) < Math.abs(candle.open - candle.low);
  const path = nearerHigh
    ? [candle.open, candle.high, candle.low, candle.close]
    : [candle.open, candle.low, candle.high, candle.close];
  processPoint(state, path[0], barIndex);
  for (let i = 1; i < path.length && state.position; i++) {
    processSegment(state, path[i - 1], path[i], barIndex);
  }
  if (state.position && state.position.tp1Filled && moveToBE) {
    state.position.activeRunnerStop = state.position.entry;
  }
}

function analyzeMindsetPineParity(candles, overrides = {}) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  const options = { ...DEFAULTS, ...overrides };
  const closes = candles.map((c) => Number(c.close));
  const fast = ema(closes, options.fastLen);
  const slow = ema(closes, options.slowLen);
  const rsiValues = rsi(closes, options.rsiLen);
  const atrValues = atrSeries(candles, options.atrLen);
  const neededBars = Math.max(options.slowLen, options.rsiLen + 1, options.atrLen + 20);

  const counts = {
    longConditionBars: 0,
    shortConditionBars: 0,
    distinctLongOpportunities: 0,
    distinctShortOpportunities: 0,
    longEntryRequests: 0,
    shortEntryRequests: 0,
    actualLongEntries: 0,
    actualShortEntries: 0,
    sizingFailures: 0,
    capitalMarginRejections: 0,
    signalBarsBlockedByOpenPosition: 0,
  };
  const maxSignalRun = { LONG: 0, SHORT: 0 };
  let longRun = 0;
  let shortRun = 0;
  let priorLong = false;
  let priorShort = false;
  let maxRequiredMarginPctOfEquity = 0;
  const state = { equity: options.initialCapital, position: null, closed: [] };

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    processBar(state, candle, i, options.moveToBE);

    const ready = i + 1 >= neededBars && [fast[i], slow[i], rsiValues[i], atrValues[i]].every(Number.isFinite);
    const longSignal = Boolean(ready && fast[i] > slow[i] && rsiValues[i] > options.rsiLongMin && rsiValues[i] < options.rsiLongMax);
    const shortSignal = Boolean(ready && fast[i] < slow[i] && rsiValues[i] < options.rsiShortMax && rsiValues[i] > options.rsiShortMin);

    if (longSignal) {
      counts.longConditionBars += 1;
      longRun += 1;
      shortRun = 0;
      if (!priorLong) counts.distinctLongOpportunities += 1;
    } else if (shortSignal) {
      counts.shortConditionBars += 1;
      shortRun += 1;
      longRun = 0;
      if (!priorShort) counts.distinctShortOpportunities += 1;
    } else {
      longRun = 0;
      shortRun = 0;
    }
    maxSignalRun.LONG = Math.max(maxSignalRun.LONG, longRun);
    maxSignalRun.SHORT = Math.max(maxSignalRun.SHORT, shortRun);
    priorLong = longSignal;
    priorShort = shortSignal;

    if (!longSignal && !shortSignal) continue;
    if (state.position) {
      counts.signalBarsBlockedByOpenPosition += 1;
      continue;
    }

    const direction = longSignal ? "LONG" : "SHORT";
    counts[longSignal ? "longEntryRequests" : "shortEntryRequests"] += 1;
    const riskDistance = options.slAtrMult * atrValues[i];
    const riskUsd = state.equity * options.riskPct / 100;
    const qty = riskDistance > 0 ? riskUsd / riskDistance : 0;
    if (!(Number.isFinite(qty) && qty > 0)) {
      counts.sizingFailures += 1;
      continue;
    }

    const requiredMargin = qty * closes[i] * options.marginPercent / 100;
    const requiredMarginPctOfEquity = state.equity > 0 ? requiredMargin / state.equity * 100 : Infinity;
    maxRequiredMarginPctOfEquity = Math.max(maxRequiredMarginPctOfEquity, requiredMarginPctOfEquity);
    if (!(requiredMargin <= state.equity)) {
      counts.capitalMarginRejections += 1;
      continue;
    }

    const sign = direction === "LONG" ? 1 : -1;
    state.position = {
      direction,
      entryIndex: i,
      entry: closes[i],
      qty,
      remainingQty: qty,
      tp1Qty: qty * options.tp1ClosePct / 100,
      stop: closes[i] - sign * riskDistance,
      activeRunnerStop: closes[i] - sign * riskDistance,
      tp1: closes[i] + sign * options.tp1R * riskDistance,
      tp2: closes[i] + sign * options.tp2R * riskDistance,
      tp1Filled: false,
      realizedPnl: 0,
      fills: [],
    };
    counts[longSignal ? "actualLongEntries" : "actualShortEntries"] += 1;
  }

  const durations = state.closed.map((trade) => trade.durationBars).sort((a, b) => a - b);
  const medianDurationBars = durations.length
    ? durations.length % 2
      ? durations[(durations.length - 1) / 2]
      : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2
    : null;
  const actualEntries = counts.actualLongEntries + counts.actualShortEntries;
  return {
    settings: { ...options, neededBars, pyramiding: 0, processOrdersOnClose: true, commissionPercent: 0 },
    bars: candles.length,
    counts: {
      ...counts,
      actualEntries,
      closedTrades: state.closed.length,
      openTradesAtEnd: state.position ? 1 : 0,
    },
    diagnostics: {
      maxLongConditionRunBars: maxSignalRun.LONG,
      maxShortConditionRunBars: maxSignalRun.SHORT,
      medianClosedTradeDurationBars: medianDurationBars,
      maxClosedTradeDurationBars: durations.length ? durations[durations.length - 1] : null,
      openTradeDurationBars: state.position ? candles.length - 1 - state.position.entryIndex : null,
      maxRequiredMarginPctOfEquity,
      endingEquity: state.equity,
    },
    closedTrades: state.closed,
    openTrade: state.position,
  };
}

module.exports = { DEFAULTS, analyzeMindsetPineParity };
