"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeMindsetPineParity } = require("../src/services/trading/mindset-pine-diagnostic");

function candlesFromCloses(closes) {
  return closes.map((close, index) => ({
    openTime: index * 60000,
    closeTime: (index + 1) * 60000 - 1,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  }));
}

test("Pine diagnostic separates condition states, opportunities, and entries", () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.05 + Math.sin(i / 2) * 2);
  const result = analyzeMindsetPineParity(candlesFromCloses(closes));
  assert.ok(result.counts.longConditionBars > 1);
  assert.ok(result.counts.distinctLongOpportunities > 0);
  assert.ok(result.counts.distinctLongOpportunities < result.counts.longConditionBars);
  assert.equal(result.counts.sizingFailures, 0);
  assert.equal(result.counts.capitalMarginRejections, 0);
  assert.equal(result.counts.actualEntries, result.counts.closedTrades + result.counts.openTradesAtEnd);
});

test("Pine diagnostic reports margin rejections separately from sizing failures", () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.05 + Math.sin(i / 2) * 2);
  const result = analyzeMindsetPineParity(candlesFromCloses(closes), { marginPercent: 1000 });
  assert.equal(result.counts.sizingFailures, 0);
  assert.ok(result.counts.capitalMarginRejections > 0);
  assert.equal(result.counts.actualEntries, 0);
});
