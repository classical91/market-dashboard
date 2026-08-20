"use strict";

// Controlled research orchestration for Mindset v1/v1.1.
//
// This module does not fetch data and never records experiments or touches a
// persistent ledger. Callers supply immutable candle datasets; every run uses
// BacktestService's in-memory paper engine. Splits are chronological and each
// entry experiment changes one feature only.

const { BacktestService, summarizeRun, MIN_WARMUP_BARS } = require("./backtest");
const { makeTradingConfig } = require("./config");

const ABLATIONS = Object.freeze([
  Object.freeze({ code: "A", label: "Frozen Mindset v1", strategy: "mindset_v1", options: {} }),
  Object.freeze({ code: "B", label: "Fresh RSI trigger", strategy: "mindset_v1_1", options: { variant: "rsi_trigger" } }),
  Object.freeze({ code: "C", label: "Normalized trend strength", strategy: "mindset_v1_1", options: { variant: "trend_strength" } }),
  Object.freeze({ code: "D", label: "EMA20 pullback and restore", strategy: "mindset_v1_1", options: { variant: "pullback" } }),
  Object.freeze({ code: "E", label: "MACD confirmation", strategy: "mindset_v1_1", options: { variant: "macd_confirmation" } }),
  Object.freeze({ code: "F", label: "Volume confirmation", strategy: "mindset_v1_1", options: { variant: "volume_confirmation" } }),
]);

const DEFAULT_SPLITS = Object.freeze([
  Object.freeze({ id: "development", fraction: 0.6 }),
  Object.freeze({ id: "validation", fraction: 0.2 }),
  Object.freeze({ id: "out_of_sample", fraction: 0.2 }),
]);

function chronologicalSplits(candles, splits = DEFAULT_SPLITS) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  const totalFraction = splits.reduce((sum, split) => sum + Number(split.fraction), 0);
  if (Math.abs(totalFraction - 1) > 1e-9) throw new Error("chronological split fractions must sum to 1");

  let start = 0;
  return splits.map((split, index) => {
    const end = index === splits.length - 1
      ? candles.length
      : start + Math.floor(candles.length * Number(split.fraction));
    const segment = candles.slice(start, end);
    const result = {
      id: split.id,
      startIndex: start,
      endIndex: end - 1,
      candles: segment,
      from: segment.length ? segment[0].closeTime : null,
      to: segment.length ? segment[segment.length - 1].closeTime : null,
    };
    start = end;
    return result;
  });
}

async function runMindsetResearch({
  datasets,
  config = makeTradingConfig(),
  costScenarios = ["baseline", "stress"],
  executionMode = "shared",
  splits = DEFAULT_SPLITS,
  ablations = ABLATIONS,
} = {}) {
  if (!Array.isArray(datasets) || !datasets.length) throw new Error("at least one candle dataset is required");
  const service = new BacktestService({ config, logger: { error() {}, warn() {} } });
  const rows = [];

  for (const dataset of datasets) {
    if (!dataset || !dataset.symbol || !dataset.timeframe || !Array.isArray(dataset.candles)) {
      throw new Error("each dataset needs symbol, timeframe, and candles[]");
    }
    for (const split of chronologicalSplits(dataset.candles, splits)) {
      for (const costScenario of costScenarios) {
        for (const ablation of ablations) {
          const identity = {
            ablation: ablation.code,
            experiment: ablation.label,
            strategy: ablation.strategy,
            strategyOptions: { ...ablation.options },
            symbol: dataset.symbol,
            timeframe: dataset.timeframe,
            split: split.id,
            sampleFrom: split.from,
            sampleTo: split.to,
            sampleBars: split.candles.length,
            executionMode,
            costScenario,
          };
          if (split.candles.length <= MIN_WARMUP_BARS + 1) {
            rows.push({ ...identity, status: "insufficient-data", reason: `Need more than ${MIN_WARMUP_BARS + 1} bars` });
            continue;
          }

          const result = await service.run({
            symbol: dataset.symbol,
            interval: dataset.timeframe,
            candles: split.candles,
            strategy: ablation.strategy,
            options: ablation.options,
            executionMode,
            costScenario,
          });
          rows.push({
            ...identity,
            status: "ok",
            ...summarizeRun(result),
            regimeMetrics: result.regimeMetrics,
            regimeCounts: result.regimeCounts,
            evidence: result.evidence,
            caveats: result.caveats,
          });
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    methodology: {
      chronological: true,
      shuffled: false,
      persistentLedgerWrites: false,
      entryVariablesChangedTogether: 1,
      executionMode,
      costScenarios: [...costScenarios],
      splits: splits.map((split) => ({ ...split })),
    },
    datasets: datasets.map((dataset) => ({
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      bars: dataset.candles.length,
      from: dataset.candles[0] ? dataset.candles[0].closeTime : null,
      to: dataset.candles.length ? dataset.candles[dataset.candles.length - 1].closeTime : null,
    })),
    rows,
  };
}

module.exports = { ABLATIONS, DEFAULT_SPLITS, chronologicalSplits, runMindsetResearch };
