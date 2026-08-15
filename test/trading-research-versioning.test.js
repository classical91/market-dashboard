"use strict";

// Comparability of research records.
//
// An expectancy figure is a measurement of the rules that selected the trades
// behind it. Those rules have changed twice in ways that move candidates across
// decision boundaries — same-timeframe trend scored as higher-timeframe daily
// bias, and absent macro/funding scored as favourable observations — so
// experiments from either side of those changes measure different things.
//
// Git commit already records which code ran, but a commit is far too
// fine-grained to group by. These tests pin the two coarse versions a
// researcher actually needs: the rules that chose the trades, and the shape of
// the record holding them.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BacktestService, summarizeEvidence } = require("../src/services/trading/backtest");
const { makeTradingConfig } = require("../src/services/trading/config");
const { SCORING_VERSION, runChecklist, marketState } = require("../src/services/trading/checklist");
const {
  buildExperimentRecord,
  RESEARCH_SCHEMA_VERSION,
} = require("../src/services/trading/experiment-record");
const {
  ExperimentStore,
  isComparable,
  comparabilityNote,
} = require("../src/services/trading/experiment-store");

const FED_LONG = Object.freeze({
  htfTrendUp: true,
  usdtDominanceSignal: "RISK_ON",
  btcDominanceRising: false,
  bearMarket: false,
  fundingRate: 0,
});

function choppyCandles(count) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const close = 100 + Math.sin(i / 9) * 6 + i * 0.05;
    bars.push({
      openTime: i * 3600000,
      closeTime: (i + 1) * 3600000,
      open: close,
      high: close + 1.2,
      low: close - 1.2,
      close,
      volume: 1000 + (i % 11) * 150,
    });
  }
  return bars;
}

function makeStore() {
  return new ExperimentStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-research-")) });
}

async function runOnce({ marketContext = FED_LONG } = {}) {
  const service = new BacktestService({ config: makeTradingConfig() });
  return service.run({
    symbol: "BTCUSDT",
    candles: choppyCandles(400),
    warmupBars: 60,
    strategy: ({ bars }) => (bars.length % 3 === 0 ? "LONG" : null),
    marketContext,
  });
}

/* ── Versioning ───────────────────────────────────────────── */

test("a run and its record both carry the scoring rules they ran under", async () => {
  const result = await runOnce();
  assert.equal(result.scoringVersion, SCORING_VERSION);

  const record = buildExperimentRecord(result, { gitCommit: "abc123" });
  assert.equal(record.scoringVersion, SCORING_VERSION);
  assert.equal(record.researchSchemaVersion, RESEARCH_SCHEMA_VERSION);
  // Git commit still recorded — it answers a different question (which code)
  // from the one scoringVersion answers (which rules).
  assert.equal(record.gitCommit, "abc123");
});

test("the scoring version is a major bump, because the rules changed decisions", () => {
  // Pinned deliberately. 1.x scored a candles-only long at 57 (TAKE_QUARTER)
  // and the identical short at 37 (SKIP); 2.0.0 scores both 32. Anything that
  // could move a candidate across a decision boundary has to bump the major,
  // and this assertion is what makes someone think about it.
  assert.match(SCORING_VERSION, /^2\./);
});

/* ── Legacy records ───────────────────────────────────────── */

test("records written before scoring was versioned are not comparable", () => {
  const legacy = { id: "exp_old", strategy: "smc_v1", expectancyR: 0.4 };
  assert.equal(isComparable(legacy), false);
  assert.match(comparabilityNote(legacy), /before scoring was versioned/);
});

test("records scored under a different rule set are not comparable, and say which", () => {
  const older = { id: "exp_x", scoringVersion: "1.4.0" };
  assert.equal(isComparable(older), false);
  assert.match(comparabilityNote(older), /scored under rules 1\.4\.0, current is/);
});

test("a record scored under the current rules is comparable, with no note", () => {
  const current = { id: "exp_y", scoringVersion: SCORING_VERSION };
  assert.equal(isComparable(current), true);
  assert.equal(comparabilityNote(current), null);
});

test("legacy experiments are kept and labelled, never silently dropped", async () => {
  const store = makeStore();
  const result = await runOnce();

  store.record({ id: "exp_legacy", strategy: "smc_v1", symbol: "BTCUSDT", expectancyR: 0.9 });
  store.record(buildExperimentRecord(result, { id: "exp_current" }));

  const all = store.list();
  assert.equal(all.total, 2, "superseded research is history, not rubbish — it stays");
  assert.equal(all.comparableTotal, 1);
  assert.equal(all.scoringVersion, SCORING_VERSION);

  const legacy = all.items.find((e) => e.id === "exp_legacy");
  const current = all.items.find((e) => e.id === "exp_current");
  // Labelled on every row whether or not the caller filtered, so a browser
  // shows both with one marked rather than quietly missing a record.
  assert.equal(legacy.comparable, false);
  assert.ok(legacy.comparabilityNote);
  assert.equal(current.comparable, true);
  assert.equal(current.comparabilityNote, null);
});

test("a promotion check can ask for comparable records only", async () => {
  const store = makeStore();
  store.record({ id: "exp_legacy", strategy: "smc_v1" });
  store.record(buildExperimentRecord(await runOnce(), { id: "exp_current" }));

  const pooled = store.list({ comparableOnly: true });
  assert.equal(pooled.total, 1);
  assert.equal(pooled.items[0].id, "exp_current");

  // And the default stays inclusive, so no existing reader loses rows.
  assert.equal(store.list().total, 2);
});

/* ── Evidence ratio ───────────────────────────────────────── */

test("summarizeEvidence keeps the raw score and the reachable points apart", () => {
  const empty = summarizeEvidence([]);
  assert.equal(empty.trades, 0);
  assert.equal(empty.meanRatio, null);

  const some = summarizeEvidence([
    { score: 50, available: 60 },
    { score: 30, available: 60 },
  ]);
  assert.equal(some.trades, 2);
  assert.equal(some.meanScore, 40);
  assert.equal(some.meanAvailablePoints, 60);
  assert.equal(some.meanRatio, 0.667);
  assert.equal(some.minRatio, 0.5);
});

test("a run reports the evidence its trades were selected on", async () => {
  const result = await runOnce();
  assert.ok(result.trades.length > 0, "the fixture has to trade for this to mean anything");

  assert.equal(result.evidence.trades, result.trades.length + result.openAtEnd.length);
  assert.ok(result.evidence.meanRatio > 0 && result.evidence.meanRatio <= 1);
  // Every opened position carries its own pair, so the aggregate can always be
  // recomputed from the ledger rather than trusted.
  for (const position of [...result.trades, ...result.openAtEnd]) {
    assert.equal(typeof position.confidenceScore, "number");
    assert.equal(typeof position.meta.availablePoints, "number");
    assert.equal(position.meta.scoringVersion, SCORING_VERSION);
    assert.ok(position.confidenceScore <= position.meta.availablePoints);
  }
});

test("a candles-only run is scored against fewer points than a fed one", async () => {
  // The distinction the ratio exists to capture. Both runs use identical
  // candles and an identical strategy; they differ only in what the caller
  // knew, and the raw score alone cannot tell them apart.
  const fed = await runOnce({ marketContext: FED_LONG });
  const config = makeTradingConfig();

  const candlesOnly = runChecklist(
    { symbol: "BTCUSDT", direction: "LONG", price: 100, atr: 1 },
    marketState({ regime: "TREND_UP", dailyBias: "NEUTRAL", macdBullish: true, atrRatio: 1, volumeRatio: 1 }),
    config,
  );

  assert.equal(candlesOnly.availablePoints, 60);
  assert.equal(fed.evidence.meanAvailablePoints, 100);
  // 60 of 100 reachable against an unchanged 50-point floor: a candle
  // backtest must clear 83% of its available evidence where a fully-fed
  // candidate clears 50%, and can never reach HALF (65) or FULL (80) at all.
  assert.ok(50 / 60 > 50 / 100);
});

test("the experiment record carries the evidence and the context it was given", async () => {
  const fed = buildExperimentRecord(await runOnce({ marketContext: FED_LONG }));
  const bare = buildExperimentRecord(await runOnce({ marketContext: null }));

  assert.equal(fed.evidence.meanAvailablePoints, 100);
  assert.deepEqual(fed.marketContextFields, [
    "bearMarket",
    "btcDominanceRising",
    "fundingRate",
    "htfTrendUp",
    "usdtDominanceSignal",
  ]);

  // A candles-only run records that it was one, so it is never pooled with a
  // fed run on the strength of a matching scoringVersion alone.
  assert.deepEqual(bare.marketContextFields, []);
});
