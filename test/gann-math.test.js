"use strict";

// Pins the Gann formulas themselves. These are the numbers the page draws
// and TraderClaw receives, so each is checked against a hand-computed value
// rather than against the code's own output.
const test = require("node:test");
const assert = require("node:assert");

const G = require("../public/assets/js/gann-math");
const { syntheticCandles } = require("./helpers/gann-fixtures");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

test("Square of Nine: one rotation adds 2 to the square root", () => {
  close(G.sq9PriceAt(100, 360), 144); // (10 + 2)²
  close(G.sq9PriceAt(100, 180), 121); // (10 + 1)²
  close(G.sq9PriceAt(100, 90), 110.25); // (10 + 0.5)²
  close(G.sq9PriceAt(144, -360), 100);
  assert.equal(G.sq9PriceAt(1, -360), null, "a level below zero root is not a price");
  assert.equal(G.sq9PriceAt(-5, 45), null);
});

test("Square of Nine: normalisation scales into [100, 1000) and back", () => {
  assert.equal(G.normalisationFactor(90000), 0.01);
  assert.equal(G.normalisationFactor(0.0003), 1e6);
  assert.equal(G.normalisationFactor(250), 1);
  const r = G.squareOfNine(90000, { step: 360, count: 1 });
  assert.equal(r.factor, 0.01);
  const up = r.levels.find((l) => l.degrees === 360);
  close(up.price, 102400); // (√900 + 2)² × 100
  const raw = G.squareOfNine(90000, { step: 360, count: 1, normalise: false });
  close(raw.levels.find((l) => l.degrees === 360).price, 91204); // (300 + 2)²
});

test("Square of Nine: levels are sorted, split around the price and flag cardinals", () => {
  const r = G.squareOfNine(500, { step: 45, count: 4 });
  assert.equal(r.levels.length, 8);
  for (let i = 1; i < r.levels.length; i += 1) assert.ok(r.levels[i].price > r.levels[i - 1].price);
  assert.ok(r.levels.filter((l) => l.direction === "support").every((l) => l.price < 500));
  assert.ok(r.levels.filter((l) => l.direction === "resistance").every((l) => l.price > 500));
  assert.deepStrictEqual(r.levels.filter((l) => l.cardinal).map((l) => l.degrees).sort((a, b) => a - b), [-180, -90, 90, 180]);
});

test("pivots are confirmed only after `right` bars and never repaint", () => {
  const candles = syntheticCandles({ count: 300, seed: 3 });
  const right = 5;
  const all = G.findPivots(candles, { left: 5, right });
  assert.ok(all.length > 10);
  assert.ok(all.every((p) => p.confirmedIndex === p.index + right));
  // Whatever was knowable at bar t is identical whether or not later bars exist.
  for (const t of [120, 180, 240]) {
    const partial = G.findPivots(candles.slice(0, t + 1), { left: 5, right });
    assert.deepStrictEqual(G.pivotsKnownAt(all, t), partial);
  }
});

test("auto anchor uses only confirmed pivots inside the lookback", () => {
  const candles = syntheticCandles({ count: 300, seed: 5 });
  const pivots = G.findPivots(candles, { left: 5, right: 5 });
  const a = G.autoAnchor(candles, pivots, { at: 250, lookback: 100 });
  assert.ok(a.confirmedIndex <= 250 && a.index >= 150);
  const lows = G.pivotsKnownAt(pivots, 250).filter((p) => p.type === "low" && p.index >= 150);
  const low = G.autoAnchor(candles, pivots, { at: 250, lookback: 100, side: "low" });
  assert.equal(low.price, Math.min(...lows.map((p) => p.price)));
});

test("price-to-time scale: ATR, range and manual modes", () => {
  const candles = [
    { openTime: 0, open: 10, high: 11, low: 9, close: 10 },
    { openTime: 1, open: 10, high: 12, low: 10, close: 11 }, // TR 2
    { openTime: 2, open: 11, high: 11, low: 8, close: 9 }, // TR 3
    { openTime: 3, open: 9, high: 10, low: 9, close: 10 }, // TR 1
  ];
  close(G.priceTimeScale(candles, { mode: "atr", length: 3 }).value, 2);
  close(G.priceTimeScale(candles, { mode: "range", length: 4 }).value, (12 - 8) / 4);
  assert.deepStrictEqual(G.priceTimeScale(candles, { mode: "manual", value: 0.5 }), { mode: "manual", value: 0.5 });
  assert.equal(G.priceTimeScale(candles, { mode: "manual", value: -1 }), null);
});

test("Gann fan lines are in bar/price units, up from lows and down from highs", () => {
  const low = { index: 10, price: 100, type: "low" };
  const fan = G.gannFan(low, 2);
  assert.deepStrictEqual(fan.map((l) => l.name), ["8x1", "4x1", "3x1", "2x1", "1x1", "1x2", "1x3", "1x4", "1x8"]);
  const oneByOne = fan.find((l) => l.name === "1x1");
  close(G.fanPriceAt(oneByOne, 20), 120);
  close(G.fanPriceAt(fan.find((l) => l.name === "2x1"), 20), 140);
  close(G.fanPriceAt(fan.find((l) => l.name === "1x2"), 20), 110);
  const down = G.gannFan({ index: 10, price: 100, type: "high" }, 2);
  close(G.fanPriceAt(down.find((l) => l.name === "1x1"), 20), 80);
  // fanLevelsAt drops lines that have run below zero.
  assert.ok(G.fanLevelsAt(down, 100).every((l) => l.price > 0));
});

test("Gann Box, Gann Square and Square of 144", () => {
  const box = G.gannBox({ index: 0, price: 100 }, { index: 80, price: 180 }, { extend: 1 });
  close(box.prices.find((p) => p.fraction === 0.5).price, 140);
  close(box.prices.find((p) => p.fraction === 0.125).price, 110);
  assert.equal(box.times.find((t) => t.fraction === 0.5).index, 40);
  assert.equal(box.times.find((t) => t.fraction === 1.5).index, 120);

  const sq = G.gannSquare({ index: 10, price: 100 }, 50, 2); // 25 bars squares 50 price units at 2/bar
  assert.equal(sq.squareBars, 25);
  assert.equal(sq.marks.find((m) => m.multiple === 1).index, 35);
  assert.equal(sq.marks.find((m) => m.multiple === 2).index, 60);

  const s144 = G.squareOf144({ index: 5, price: 100, type: "low" }, 0.5);
  assert.deepStrictEqual(s144.times.map((t) => t.index), G.SQ144_DIVISIONS.map((d) => 5 + d));
  close(s144.prices.find((p) => p.division === 144).price, 172);
  const s144down = G.squareOf144({ index: 5, price: 50, type: "high" }, 0.5);
  assert.ok(s144down.prices.every((p) => p.price > 0 && p.price < 50));
});

test("time cycles count bars and calendar days independently", () => {
  const anchor = { index: 100, time: Date.UTC(2026, 0, 1) };
  const day = 86400000;
  const daily = G.timeCycles(anchor, { barMs: day, tolerance: 1, bars: [90], days: [90] });
  assert.equal(daily.length, 2);
  assert.ok(daily.every((w) => w.index === 190 && w.fromIndex === 189 && w.toIndex === 191));
  const fourHour = G.timeCycles(anchor, { barMs: 4 * 3600000, tolerance: 2, bars: [90], days: [30] });
  const cal = fourHour.find((w) => w.kind === "days");
  assert.equal(cal.index, 100 + 180); // 30 days of 4h bars
  assert.equal(cal.time, anchor.time + 30 * day);
  assert.equal(fourHour.find((w) => w.kind === "bars").index, 190);
});

test("fibonacci and volume profile", () => {
  const fib = G.fibonacciLevels({ index: 0, price: 100 }, { index: 10, price: 200 });
  close(fib.find((f) => f.ratio === 0.5).price, 150);
  close(fib.find((f) => f.ratio === 0.618).price, 138.2);
  const candles = syntheticCandles({ count: 200, seed: 11 });
  const vp = G.volumeProfile(candles, { bins: 30 });
  assert.equal(vp.bins.length, 30);
  assert.ok(vp.valueAreaLow <= vp.poc && vp.poc <= vp.valueAreaHigh);
  const total = candles.reduce((s, c) => s + c.volume, 0);
  close(vp.bins.reduce((s, b) => s + b.volume, 0), total, 1e-6);
});

test("confluence counts distinct methods, not raw levels", () => {
  const clusters = G.priceConfluence([
    { source: "Square of Nine", label: "a", price: 100 },
    { source: "Square of Nine", label: "b", price: 100.2 },
    { source: "Gann Fan", label: "c", price: 100.3 },
    { source: "Fibonacci", label: "d", price: 105 },
  ], 0.5);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].members.length, 3);
  assert.equal(clusters[0].sourceCount, 2);
  assert.deepStrictEqual(clusters[0].sources, ["Gann Fan", "Square of Nine"]);
  const times = G.timeConfluence([
    { source: "Bar cycles", label: "90", index: 50 },
    { source: "Gann Box", label: "1", index: 51 },
    { source: "Gann Box", label: "2", index: 60 },
  ], 2);
  assert.deepStrictEqual(times.map((t) => t.sourceCount), [2, 1]);
});

test("output is deterministic for identical input", () => {
  const candles = syntheticCandles({ count: 200, seed: 9 });
  const run = () => ({
    sq9: G.squareOfNine(candles[150].close, { step: 45, count: 8 }),
    pivots: G.findPivots(candles, { left: 5, right: 5 }),
    vp: G.volumeProfile(candles, {}),
  });
  assert.deepStrictEqual(run(), run());
});
