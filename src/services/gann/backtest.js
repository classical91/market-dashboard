"use strict";

// Walk-forward validation of Gann geometry on closed candles.
//
// Three questions, each answered against a baseline rather than in isolation,
// because "price reacted at a Gann level 58% of the time" means nothing until
// you know how often it reacts at any line of the same density:
//
//   1. Level reactions — when price touches a Gann level, how often does it
//      reverse by k·ATR before breaking through by k·ATR? Baseline: the
//      midpoints between the same Gann levels (same count, same spacing,
//      no Gann meaning).
//   2. Cycle reversals — what share of confirmed swing pivots land inside a
//      Gann cycle window projected from the anchor that was known BEFORE the
//      window opened? Baseline: the share of all bars those windows cover
//      (the hit rate a randomly placed pivot would get).
//   3. Strategy comparison — a plain RSI reversal strategy, with and without
//      a "near a Gann level" filter, and with a "near a control level"
//      filter, net of trading costs.
//
// Look-ahead rules: at bar t only pivots with confirmedIndex <= t, an ATR and
// scale computed through t, and entries at the NEXT bar's open. Settings are
// fixed in advance — nothing is optimised — so the 70/30 split is a genuine
// holdout. Everything is deterministic; the fingerprint identifies the exact
// candles and settings that produced a result.

const crypto = require("node:crypto");
const G = require("../../../public/assets/js/gann-math");
const { rsi } = require("../signal-screener");
const { getCostScenario, costCaveats } = require("../trading/cost-scenarios");
const { normaliseSettings } = require("./analysis");

const DEFAULT_OPTIONS = Object.freeze({
  reactionAtr: 1,
  reactionBars: 10,
  filterAtr: 0.5,
  stopAtr: 1.5,
  maxHoldBars: 20,
  splitRatio: 0.7,
  costScenario: "baseline",
});

function round(v, digits = 6) {
  return Number.isFinite(v) ? Number(v.toFixed(digits)) : null;
}

function fingerprint(candles, settings, options) {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({ settings, options }));
  for (const c of candles) h.update(`${c.openTime},${c.open},${c.high},${c.low},${c.close},${c.volume};`);
  return h.digest("hex").slice(0, 16);
}

/**
 * The anchor, scale and level set knowable at the close of bar t. Memoised
 * per anchor so a 500-bar walk does not rebuild identical Square of Nine
 * wheels on every bar.
 */
function createStateAt(candles, pivots, settings) {
  const sq9Cache = new Map();
  return function stateAt(t) {
    const anchor = G.autoAnchor(candles, pivots, { at: t, lookback: settings.lookback });
    if (!anchor) return null;
    const scale = G.priceTimeScale(candles, { mode: settings.scaleMode === "manual" ? "atr" : settings.scaleMode, length: settings.scaleLength, at: t });
    const atr = G.atr(candles, 14, t);
    if (!scale || !(atr > 0)) return null;
    const key = `${anchor.index}:${anchor.type}`;
    if (!sq9Cache.has(key)) {
      sq9Cache.set(key, G.squareOfNine(anchor.price, { step: settings.sq9Step, count: settings.sq9Count * 2, normalise: settings.sq9Normalise }).levels.map((l) => l.price));
    }
    const fan = G.gannFan(anchor, scale.value);
    return { anchor, scale, atr, sq9: sq9Cache.get(key), fan };
  };
}

function levelSets(state, barIndex, close) {
  const band = 8 * state.atr;
  const gann = state.sq9
    .concat(G.fanLevelsAt(state.fan, barIndex).map((l) => l.price))
    .filter((p) => p > 0 && Math.abs(p - close) <= band)
    .sort((a, b) => a - b);
  const unique = gann.filter((p, i) => i === 0 || p - gann[i - 1] > 1e-12);
  const control = [];
  for (let i = 1; i < unique.length; i += 1) control.push((unique[i - 1] + unique[i]) / 2);
  return { gann: unique, control };
}

function emptyTally() {
  return { touches: 0, reactions: 0, breaks: 0, unresolved: 0 };
}

function finishTally(t) {
  const resolved = t.reactions + t.breaks;
  return { ...t, reactionRate: resolved ? round(t.reactions / resolved, 4) : null, falseSignalRate: resolved ? round(t.breaks / resolved, 4) : null };
}

/**
 * Outcome of a touch of `level` on bar i, approached from `fromAbove`.
 * Decided by closes only, from bar i onward, within `bars` bars.
 */
function touchOutcome(candles, i, level, fromAbove, dist, bars) {
  const end = Math.min(candles.length - 1, i + bars - 1);
  for (let j = i; j <= end; j += 1) {
    const c = candles[j].close;
    const away = fromAbove ? c - level : level - c;
    if (away >= dist) return "reaction";
    if (away <= -dist) return "break";
  }
  return end - i + 1 < bars ? "censored" : "unresolved";
}

function levelReactionTest(candles, stateAt, settings, options, warmup, split) {
  const tallies = { gann: { inSample: emptyTally(), outOfSample: emptyTally() }, control: { inSample: emptyTally(), outOfSample: emptyTally() } };
  const lastTouch = { gann: new Map(), control: new Map() };
  for (let t = warmup; t < candles.length - 1; t += 1) {
    const state = stateAt(t);
    if (!state) continue;
    const next = candles[t + 1];
    const prevClose = candles[t].close;
    const sets = levelSets(state, t + 1, prevClose);
    const dist = options.reactionAtr * state.atr;
    for (const kind of ["gann", "control"]) {
      for (const level of sets[kind]) {
        if (!(next.low <= level && next.high >= level)) continue;
        // One touch episode per level until price has been away for a full window.
        const key = `${state.anchor.index}:${level.toPrecision(10)}`;
        const prior = lastTouch[kind].get(key);
        lastTouch[kind].set(key, t + 1);
        if (prior != null && t + 1 - prior < options.reactionBars) continue;
        const outcome = touchOutcome(candles, t + 1, level, prevClose > level, dist, options.reactionBars);
        if (outcome === "censored") continue;
        const tally = tallies[kind][t + 1 < split ? "inSample" : "outOfSample"];
        tally.touches += 1;
        if (outcome === "reaction") tally.reactions += 1;
        else if (outcome === "break") tally.breaks += 1;
        else tally.unresolved += 1;
      }
    }
  }
  const out = {};
  for (const kind of ["gann", "control"]) {
    out[kind] = { inSample: finishTally(tallies[kind].inSample), outOfSample: finishTally(tallies[kind].outOfSample) };
  }
  return out;
}

function cycleIndicesFor(anchor, barMs, tol) {
  return G.timeCycles(anchor, { barMs, tolerance: tol }).map((w) => w.index);
}

function cycleReversalTest(candles, pivots, settings, barMs, warmup, split) {
  const tol = settings.cycleTolerance;
  const memo = new Map();
  const windowsKnownAt = (t) => {
    if (memo.has(t)) return memo.get(t);
    const anchor = G.autoAnchor(candles, pivots, { at: t, lookback: settings.lookback });
    const value = anchor ? { anchorIndex: anchor.index, cycles: cycleIndicesFor(anchor, barMs, tol) } : null;
    memo.set(t, value);
    return value;
  };
  const inWindow = (b, known) => known && known.anchorIndex !== b && known.cycles.some((c) => Math.abs(c - b) <= tol);

  const result = {};
  for (const [name, from, to] of [["inSample", warmup, split - 1], ["outOfSample", split, candles.length - 1]]) {
    // A projection must be known before its window opens: the anchor active
    // at bar b - tol - 1 decides whether bar b is "in a cycle window".
    let barsCovered = 0;
    let barsTotal = 0;
    for (let b = from; b <= to; b += 1) {
      const known = windowsKnownAt(b - tol - 1);
      if (!known) continue;
      barsTotal += 1;
      if (inWindow(b, known)) barsCovered += 1;
    }
    let pivotsTotal = 0;
    let pivotHits = 0;
    for (const p of pivots) {
      if (p.index < from || p.index > to) continue;
      const known = windowsKnownAt(p.index - tol - 1);
      if (!known) continue;
      pivotsTotal += 1;
      if (inWindow(p.index, known)) pivotHits += 1;
    }
    const hitRate = pivotsTotal ? pivotHits / pivotsTotal : null;
    const baseline = barsTotal ? barsCovered / barsTotal : null;
    result[name] = {
      pivots: pivotsTotal,
      pivotsInWindow: pivotHits,
      hitRate: round(hitRate, 4),
      baselineRate: round(baseline, 4),
      lift: hitRate != null && baseline ? round(hitRate / baseline, 3) : null,
    };
  }
  return result;
}

function strategyMetrics(trades) {
  const n = trades.length;
  if (!n) return { trades: 0, winRate: null, avgNetPct: null, totalNetPct: null, profitFactor: null, maxDrawdownPct: null, losingTrades: 0 };
  let wins = 0;
  let gross = 0;
  let loss = 0;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let sum = 0;
  for (const t of trades) {
    sum += t.netReturn;
    if (t.netReturn > 0) { wins += 1; gross += t.netReturn; } else loss += -t.netReturn;
    equity *= 1 + t.netReturn;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return {
    trades: n,
    winRate: round(wins / n, 4),
    avgNetPct: round((sum / n) * 100, 4),
    totalNetPct: round((equity - 1) * 100, 4),
    profitFactor: loss > 0 ? round(gross / loss, 3) : null,
    maxDrawdownPct: round(maxDd * 100, 4),
    losingTrades: n - wins,
  };
}

/**
 * RSI(14) reversal: long when RSI crosses up through 30, short when it
 * crosses down through 70. Entry at the next bar's open; exit when RSI
 * reaches 50, at a k·ATR stop (checked intrabar, filled at the stop), or
 * after maxHoldBars. Costs are charged on entry and exit. `filter(t, close)`
 * decides whether a signal at bar t is taken.
 */
function runStrategy(candles, rsiSeries, stateAt, filter, options, costs, warmup) {
  const perSide = costs.takerFeeRate + costs.slippageRate;
  const trades = [];
  let t = warmup;
  while (t < candles.length - 2) {
    const r0 = rsiSeries[t - 1];
    const r1 = rsiSeries[t];
    let side = null;
    if (r0 != null && r1 != null && r0 < 30 && r1 >= 30) side = 1;
    else if (r0 != null && r1 != null && r0 > 70 && r1 <= 70) side = -1;
    if (!side) { t += 1; continue; }
    const state = stateAt(t);
    if (!state || !filter(t, candles[t].close, state)) { t += 1; continue; }
    const entryIndex = t + 1;
    const entry = candles[entryIndex].open;
    const stop = entry - side * options.stopAtr * state.atr;
    let exitIndex = null;
    let exit = null;
    for (let j = entryIndex; j < candles.length; j += 1) {
      const c = candles[j];
      if (side === 1 ? c.low <= stop : c.high >= stop) { exitIndex = j; exit = side === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open); break; }
      const rj = rsiSeries[j];
      if (rj != null && (side === 1 ? rj >= 50 : rj <= 50)) { exitIndex = j; exit = c.close; break; }
      if (j - entryIndex + 1 >= options.maxHoldBars) { exitIndex = j; exit = c.close; break; }
    }
    if (exitIndex == null) break; // still open at the end of data: not counted
    const gross = side * (exit - entry) / entry;
    trades.push({ entryIndex, exitIndex, side, entry, exit, grossReturn: gross, netReturn: gross - 2 * perSide });
    t = exitIndex + 1;
  }
  return trades;
}

/**
 * Historical cycle analysis: how many bars separate consecutive swing
 * pivots, and how often those durations sit within ±tolerance of a Gann
 * bar-cycle number versus how often an arbitrary duration in the same range
 * would.
 */
function historicalCycles(pivots, settings) {
  const tol = settings.cycleTolerance;
  const lengths = [];
  for (const type of ["high", "low"]) {
    const list = pivots.filter((p) => p.type === type);
    for (let i = 1; i < list.length; i += 1) lengths.push(list[i].index - list[i - 1].index);
  }
  lengths.sort((a, b) => a - b);
  if (!lengths.length) return { swings: 0 };
  const median = lengths[Math.floor(lengths.length / 2)];
  const near = (n) => G.DEFAULT_CYCLE_BARS.some((c) => Math.abs(c - n) <= tol);
  const hits = lengths.filter(near).length;
  const maxLen = lengths[lengths.length - 1];
  let covered = 0;
  for (let n = 1; n <= maxLen; n += 1) if (near(n)) covered += 1;
  return {
    swings: lengths.length,
    medianBars: median,
    minBars: lengths[0],
    maxBars: maxLen,
    nearGannNumber: hits,
    nearGannRate: round(hits / lengths.length, 4),
    baselineRate: round(covered / maxLen, 4),
  };
}

function runBacktest(candles, { timeframe, barMs, settings: rawSettings, options: rawOptions } = {}) {
  const settings = normaliseSettings(rawSettings);
  const options = { ...DEFAULT_OPTIONS, ...(rawOptions || {}) };
  const costs = getCostScenario(options.costScenario) || getCostScenario("baseline");
  const warmup = Math.max(settings.lookback, 60);
  if (!Array.isArray(candles) || candles.length < warmup + 60) {
    return { ok: false, reason: `Not enough closed candles for a backtest (${candles ? candles.length : 0}; need ${warmup + 60})` };
  }
  const split = Math.floor(warmup + (candles.length - warmup) * options.splitRatio);
  const pivots = G.findPivots(candles, { left: settings.pivotLeft, right: settings.pivotRight });
  const stateAt = createStateAt(candles, pivots, settings);
  const rsiSeries = rsi(candles.map((c) => c.close), 14);

  const levels = levelReactionTest(candles, stateAt, settings, options, warmup, split);
  const cycles = cycleReversalTest(candles, pivots, settings, barMs, warmup, split);

  const near = (kind) => (t, close, state) => {
    const tol = options.filterAtr * state.atr;
    return levelSets(state, t, close)[kind].some((p) => Math.abs(p - close) <= tol);
  };
  const variants = {
    rsiOnly: runStrategy(candles, rsiSeries, stateAt, () => true, options, costs, warmup),
    rsiWithGann: runStrategy(candles, rsiSeries, stateAt, near("gann"), options, costs, warmup),
    rsiWithControl: runStrategy(candles, rsiSeries, stateAt, near("control"), options, costs, warmup),
  };
  const strategies = {};
  for (const [name, trades] of Object.entries(variants)) {
    strategies[name] = {
      inSample: strategyMetrics(trades.filter((tr) => tr.entryIndex < split)),
      outOfSample: strategyMetrics(trades.filter((tr) => tr.entryIndex >= split)),
    };
  }

  const caveats = costCaveats(costs).slice();
  const oos = levels.gann.outOfSample;
  if (oos.touches < 30) caveats.push(`Only ${oos.touches} out-of-sample Gann level touches — too few to distinguish from chance.`);
  if (cycles.outOfSample.pivots < 20) caveats.push(`Only ${cycles.outOfSample.pivots} out-of-sample pivots for the cycle test.`);
  caveats.push("Single-asset, single-timeframe history of at most 500 bars. Treat every number here as exploratory, not as validation.");

  return {
    ok: true,
    timeframe,
    dataset: {
      bars: candles.length,
      firstOpenTime: candles[0].openTime,
      lastOpenTime: candles[candles.length - 1].openTime,
      warmupBars: warmup,
      splitIndex: split,
      splitOpenTime: candles[split] ? candles[split].openTime : null,
    },
    settings,
    options,
    costs: { id: costs.id, label: costs.label, takerFeeRate: costs.takerFeeRate, slippageRate: costs.slippageRate },
    fingerprint: fingerprint(candles, settings, options),
    levelReactions: levels,
    cycleReversals: cycles,
    strategies,
    historicalCycles: historicalCycles(pivots, settings),
    caveats,
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  runBacktest,
  touchOutcome,
  strategyMetrics,
  historicalCycles,
  levelSets,
  createStateAt,
};
