"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TradeJournalService } = require("../src/services/trade-journal");

function makeService() {
  return new TradeJournalService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "md-journal-")) });
}

function sampleEntry(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    interval: "4h",
    signal: "LONG",
    price: 64280,
    setupScore: 82,
    screenerScore: 83,
    regimeLabel: "Risk-On",
    regimeScore: 71,
    newsRisk: "low",
    plan: { trigger: 65000, invalidation: 63200, target: 68600, riskReward: 2.0, riskLabel: "Medium" },
    ...overrides,
  };
}

test("log stores a snapshot of the signal with review fields open", () => {
  const service = makeService();
  const item = service.log(sampleEntry());
  assert.ok(item.id);
  assert.equal(item.symbol, "BTCUSDT");
  assert.equal(item.signal, "LONG");
  assert.equal(item.setupScore, 82);
  assert.equal(item.plan.trigger, 65000);
  assert.equal(item.taken, null);
  assert.equal(item.result, null);
  assert.equal(service.list().length, 1);
});

test("log rejects entries without a symbol or directional signal", () => {
  const service = makeService();
  assert.throws(() => service.log({ signal: "LONG" }), /symbol/);
  assert.throws(() => service.log({ symbol: "BTCUSDT", signal: "FLAT" }), /LONG\/SHORT/);
});

test("update grades the outcome and stamps closedAt when a result lands", () => {
  const service = makeService();
  const item = service.log(sampleEntry());
  const updated = service.update(item.id, {
    taken: true,
    result: "win",
    exitPrice: 68200,
    regimeCorrect: true,
    patternCorrect: true,
    newsRiskMissed: false,
    notes: "Clean breakout, exited into target",
  });
  assert.equal(updated.taken, true);
  assert.equal(updated.result, "win");
  assert.ok(updated.closedAt);
  assert.equal(updated.regimeCorrect, true);
  assert.equal(updated.newsRiskMissed, false);
});

test("update rejects unknown ids and bogus results", () => {
  const service = makeService();
  const item = service.log(sampleEntry());
  assert.throws(() => service.update("nope", { result: "win" }), /not found/);
  assert.throws(() => service.update(item.id, { result: "moon" }), /result must be one of/);
});

test("stats aggregate the feedback loop", () => {
  const service = makeService();
  const a = service.log(sampleEntry({ setupScore: 85 }));
  const b = service.log(sampleEntry({ symbol: "ETHUSDT", setupScore: 55 }));
  const c = service.log(sampleEntry({ symbol: "SOLUSDT", signal: "SHORT", setupScore: 70 }));

  service.update(a.id, { taken: true, result: "win", regimeCorrect: true, patternCorrect: true });
  service.update(b.id, { taken: true, result: "loss", regimeCorrect: false, newsRiskMissed: true });
  service.update(c.id, { taken: false, result: "skipped" });

  const stats = service.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.taken, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 50);
  assert.equal(stats.avgSetupScoreWins, 85);
  assert.equal(stats.avgSetupScoreLosses, 55);
  assert.equal(stats.regimeAccuracy, 50);
  assert.equal(stats.patternAccuracy, 100);
  assert.equal(stats.newsRiskMissed, 1);
});

test("remove deletes an entry and persists across instances", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-journal-"));
  const first = new TradeJournalService({ dataDir });
  const kept = first.log(sampleEntry());
  const dropped = first.log(sampleEntry({ symbol: "ETHUSDT" }));
  first.remove(dropped.id);
  assert.throws(() => first.remove(dropped.id), /not found/);

  const second = new TradeJournalService({ dataDir });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].id, kept.id);
});
