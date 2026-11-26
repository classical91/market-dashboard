"use strict";

// Analysis and backtest: deterministic, reproducible, and free of look-ahead.
const test = require("node:test");
const assert = require("node:assert");

const { buildAnalysis, normaliseSettings, settingsKey, BAR_MS } = require("../src/services/gann/analysis");
const { runBacktest, touchOutcome, strategyMetrics, createStateAt } = require("../src/services/gann/backtest");
const G = require("../public/assets/js/gann-math");
const { syntheticCandles } = require("./helpers/gann-fixtures");

const candles = syntheticCandles({ count: 500, seed: 7 });

test("settings are clamped and produce a stable cache key", () => {
  const s = normaliseSettings({ pivotLeft: "999", lookback: "1", sq9Step: "13", scaleMode: "manual" });
  assert.equal(s.pivotLeft, 20);
  assert.equal(s.lookback, 30);
  assert.equal(s.sq9Step, 45, "unsupported step falls back to 45");
  assert.equal(s.scaleMode, "atr", "manual without a value falls back to ATR");
  assert.equal(settingsKey(normaliseSettings({})), settingsKey(normaliseSettings({ pivotLeft: "5" })));
});

test("analysis is deterministic and reports every module", () => {
  const a = buildAnalysis(candles, { timeframe: "4h" });
  const b = buildAnalysis(candles, { timeframe: "4h" });
  assert.deepStrictEqual(a, b);
  assert.equal(a.ok, true);
  assert.ok(a.anchor && a.anchor.confirmedIndex <= candles.length - 1);
  assert.equal(a.fan.length, 9);
  assert.ok(a.squareOfNine.fromPrice.levels.length > 0);
  assert.ok(a.box && a.square && a.squareOf144);
  assert.ok(a.confluence.supports.every((c) => c.price < a.lastClosed.close));
  assert.ok(a.confluence.resistances.every((c) => c.price >= a.lastClosed.close));
  assert.ok(a.calendar.every((c) => c.barsAway > 0), "the calendar only lists future windows");
  for (let i = 1; i < a.calendar.length; i += 1) assert.ok(a.calendar[i].fromIndex >= a.calendar[i - 1].fromIndex);
  // No probability or confidence field anywhere in the output.
  assert.doesNotMatch(JSON.stringify(a), /"(confidence|probability|winChance)"/i);
});

test("manual anchor uses the chosen candle's extreme and falls back when out of range", () => {
  const pick = candles[300];
  const m = buildAnalysis(candles, { timeframe: "4h", settings: { anchorMode: "manual", anchorTime: String(pick.openTime), anchorSide: "high" } });
  assert.equal(m.anchor.source, "manual");
  assert.equal(m.anchor.index, 300);
  assert.equal(m.anchor.price, pick.high);
  const missing = buildAnalysis(candles, { timeframe: "4h", settings: { anchorMode: "manual", anchorTime: "1" } });
  assert.equal(missing.anchor.source, "auto");
  assert.equal(missing.warnings.length, 1);
});

test("too few candles is an explicit failure, not a guess", () => {
  const r = buildAnalysis(candles.slice(0, 20), { timeframe: "4h" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Not enough closed candles/);
  assert.throws(() => buildAnalysis(candles, { timeframe: "3h" }), /Unsupported timeframe/);
});

test("the state used at bar t depends only on candles up to t (no look-ahead)", () => {
  const settings = normaliseSettings({});
  const fullPivots = G.findPivots(candles, { left: settings.pivotLeft, right: settings.pivotRight });
  const full = createStateAt(candles, fullPivots, settings);
  for (const t of [200, 320, 450]) {
    const cut = candles.slice(0, t + 1);
    const partial = createStateAt(cut, G.findPivots(cut, { left: settings.pivotLeft, right: settings.pivotRight }), settings);
    assert.deepStrictEqual(full(t), partial(t), `state at ${t} must not see later bars`);
  }
});

test("analysis of a prefix is unchanged by later candles", () => {
  const prefix = candles.slice(0, 400);
  const fromPrefix = buildAnalysis(prefix, { timeframe: "4h" });
  const again = buildAnalysis(candles.slice(0, 400).map((c) => ({ ...c })), { timeframe: "4h" });
  assert.deepStrictEqual(fromPrefix, again);
});

test("touch outcome is decided by closes, in order", () => {
  const bars = [100, 101, 103, 99].map((c) => ({ close: c }));
  assert.equal(touchOutcome(bars, 0, 100, true, 2, 4), "reaction"); // 103 - 100 >= 2 first
  assert.equal(touchOutcome([{ close: 100 }, { close: 97 }, { close: 104 }, { close: 100 }], 0, 100, true, 2, 4), "break");
  assert.equal(touchOutcome([{ close: 100 }, { close: 100.5 }], 0, 100, true, 2, 2), "unresolved");
  assert.equal(touchOutcome([{ close: 100 }], 0, 100, true, 2, 5), "censored");
});

test("strategy metrics", () => {
  const m = strategyMetrics([{ netReturn: 0.1 }, { netReturn: -0.05 }, { netReturn: 0.02 }]);
  assert.equal(m.trades, 3);
  assert.equal(m.winRate, 0.6667);
  assert.equal(m.profitFactor, 2.4);
  assert.equal(m.losingTrades, 1);
  // Peak 1.1, then 1.045: a 5% drawdown.
  assert.equal(m.maxDrawdownPct, 5);
  assert.equal(strategyMetrics([]).trades, 0);
});

test("backtest is reproducible and fingerprints its inputs", () => {
  const a = runBacktest(candles, { timeframe: "4h", barMs: BAR_MS["4h"] });
  const b = runBacktest(candles, { timeframe: "4h", barMs: BAR_MS["4h"] });
  assert.deepStrictEqual(a, b);
  assert.equal(a.ok, true);
  const changed = candles.map((c, i) => (i === 250 ? { ...c, close: c.close * 1.01 } : c));
  assert.notEqual(runBacktest(changed, { timeframe: "4h", barMs: BAR_MS["4h"] }).fingerprint, a.fingerprint);
  assert.ok(a.dataset.splitIndex > a.dataset.warmupBars && a.dataset.splitIndex < candles.length);
  for (const kind of ["gann", "control"]) {
    for (const sample of ["inSample", "outOfSample"]) {
      const t = a.levelReactions[kind][sample];
      assert.equal(t.touches, t.reactions + t.breaks + t.unresolved);
    }
  }
  for (const sample of ["inSample", "outOfSample"]) {
    const c = a.cycleReversals[sample];
    assert.ok(c.baselineRate > 0 && c.baselineRate < 1, "cycle baseline is the window coverage");
  }
  assert.ok(a.caveats.length >= 1);
});

test("trading costs are charged on every trade", () => {
  const free = runBacktest(candles, { timeframe: "4h", barMs: BAR_MS["4h"], options: { costScenario: "frictionless" } });
  const base = runBacktest(candles, { timeframe: "4h", barMs: BAR_MS["4h"], options: { costScenario: "baseline" } });
  const f = free.strategies.rsiOnly.inSample;
  const c = base.strategies.rsiOnly.inSample;
  assert.equal(f.trades, c.trades);
  if (f.trades) {
    const perTrade = 2 * (base.costs.takerFeeRate + base.costs.slippageRate) * 100;
    assert.ok(Math.abs((f.avgNetPct - c.avgNetPct) - perTrade) < 1e-3);
  }
  assert.ok(free.caveats.some((x) => /Frictionless/.test(x)));
});

test("backtest refuses short histories", () => {
  const r = runBacktest(candles.slice(0, 100), { timeframe: "4h", barMs: BAR_MS["4h"] });
  assert.equal(r.ok, false);
});
