"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  ABLATIONS,
  chronologicalSplits,
  runMindsetResearch,
} = require("../src/services/trading/mindset-research");

function candles(count = 420) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.08 + Math.sin(i / 6) * 4;
    return {
      openTime: i * 3600000,
      closeTime: (i + 1) * 3600000 - 1,
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + (i % 11) * 50,
    };
  });
}

test("chronological research splits are contiguous and never shuffle time", () => {
  const source = candles(100);
  const splits = chronologicalSplits(source);
  assert.deepEqual(splits.map((split) => split.candles.length), [60, 20, 20]);
  assert.deepEqual(splits.map((split) => split.id), ["development", "validation", "out_of_sample"]);
  assert.equal(splits[0].endIndex + 1, splits[1].startIndex);
  assert.equal(splits[1].endIndex + 1, splits[2].startIndex);
  assert.equal(splits[0].candles[0], source[0]);
  assert.equal(splits[2].candles.at(-1), source.at(-1));
});

test("the research suite runs A-F one variable at a time without persistence", async () => {
  const report = await runMindsetResearch({
    datasets: [{ symbol: "BTCUSDT", timeframe: "1h", candles: candles() }],
    costScenarios: ["baseline"],
    splits: [{ id: "out_of_sample", fraction: 1 }],
  });

  assert.equal(report.rows.length, 6);
  assert.deepEqual(report.rows.map((row) => row.ablation), ABLATIONS.map((item) => item.code));
  assert.equal(report.methodology.chronological, true);
  assert.equal(report.methodology.shuffled, false);
  assert.equal(report.methodology.persistentLedgerWrites, false);
  assert.equal(report.methodology.entryVariablesChangedTogether, 1);
  report.rows.forEach((row) => {
    assert.equal(row.status, "ok");
    assert.equal(row.costScenario, "baseline");
    assert.equal(row.executionMode, "shared");
    assert.equal(row.sampleBars, 420);
  });
});

test("undersized validation samples are reported, not silently pooled", async () => {
  const report = await runMindsetResearch({
    datasets: [{ symbol: "BTCUSDT", timeframe: "1h", candles: candles(120) }],
    costScenarios: ["baseline"],
  });
  const validation = report.rows.filter((row) => row.split === "validation");
  assert.equal(validation.length, 6);
  assert.ok(validation.every((row) => row.status === "insufficient-data"));
});
