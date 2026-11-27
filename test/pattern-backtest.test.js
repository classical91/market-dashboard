"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  liveLookback,
  atrSeries,
  makeVariants,
  walkForward,
  resolveIndex,
  scoreEvent,
  summarize,
  selectVariant,
  loadCandles,
  runStudy,
  buildReport,
  parseArgs,
} = require("../scripts/pattern-backtest");
const { classifyWindow, detectDivergence, DEFAULTS } = require("../src/services/pattern-scanner");
const { PatternTrackerService } = require("../src/services/pattern-tracker");

const HOUR = 3_600_000;

// Seeded random walk with drift regimes and wide wicks, so the scanner finds
// real wedges, flags and divergences to walk over.
function makeCandles(count, { seed = 7, step = HOUR, start = Date.UTC(2024, 0, 1) } = {}) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out = [];
  let price = 100;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    drift = drift * 0.95 + (rand() - 0.5) * 0.01;
    const open = price;
    const close = Math.max(1, price * (1 + drift + (rand() - 0.5) * 0.03));
    const wick = price * 0.008 * rand();
    out.push({
      openTime: start + i * step,
      closeTime: start + (i + 1) * step - 1,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 100 + rand() * 100,
    });
    price = close;
  }
  return out;
}

function flatCandles(count, price = 100, step = HOUR) {
  return Array.from({ length: count }, (_, i) => ({
    openTime: i * step,
    closeTime: (i + 1) * step - 1,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
  }));
}

const eventKey = (e) => `${e.kind}|${e.variant}|${e.name}|${e.bias}|${e.index}|${e.pivotIndex ?? ""}`;

test("lookback matches the closed candles the live scanner sees", () => {
  // The live request is window + impulseWindow + pivotOrder*2 + rsiLen + 5
  // klines, the newest of which is still open and dropped.
  assert.strictEqual(liveLookback(DEFAULTS), 36 + 20 + 6 + 14 + 5 - 1);
});

test("the synthetic series produces both breakouts and divergences", () => {
  const { events } = walkForward(makeCandles(1500), { variants: makeVariants() });
  assert.ok(events.some((e) => e.kind === "breakout" && e.variant === "default"), "expected default breakouts");
  assert.ok(events.some((e) => e.kind === "breakout" && e.variant !== "default"), "expected ATR-variant breakouts");
  assert.ok(events.some((e) => e.kind === "divergence"), "expected divergences");
});

test("changing future bars never changes events already emitted", () => {
  const candles = makeCandles(1200);
  const variants = makeVariants();
  const cutoff = 700;
  const before = walkForward(candles, { variants }).events.filter((e) => e.index <= cutoff).map(eventKey);

  // Scramble every bar after the cutoff (prices, wicks, volume).
  const scrambled = candles.map((c, i) => (i <= cutoff ? c : {
    ...c,
    open: c.open * 3,
    high: c.high * 5,
    low: c.low * 0.2,
    close: c.close * (i % 2 ? 4 : 0.25),
    volume: c.volume * 50,
  }));
  const after = walkForward(scrambled, { variants }).events.filter((e) => e.index <= cutoff).map(eventKey);
  assert.deepStrictEqual(after, before);

  // And the same events come out when the future doesn't exist at all.
  const truncated = walkForward(candles.slice(0, cutoff + 1), { variants }).events.map(eventKey);
  assert.deepStrictEqual(truncated, before);
});

test("divergence pivots are confirmed exactly pivotOrder bars later, never earlier", () => {
  const { events } = walkForward(makeCandles(3000, { seed: 11 }));
  const divergences = events.filter((e) => e.kind === "divergence");
  assert.ok(divergences.length > 10);
  for (const e of divergences) {
    assert.ok(e.index - e.pivotIndex >= DEFAULTS.pivotOrder, `pivot ${e.pivotIndex} reported at ${e.index}`);
  }
  // Fresh pivots are reported as soon as they confirm.
  assert.ok(divergences.some((e) => e.index - e.pivotIndex === DEFAULTS.pivotOrder));
});

test("a divergence is emitted once per new second pivot, like the live bot", () => {
  const { events } = walkForward(makeCandles(3000, { seed: 11 }));
  const seen = new Set();
  for (const e of events.filter((ev) => ev.kind === "divergence")) {
    const key = `${e.name}|${e.pivotIndex}`;
    assert.ok(!seen.has(key), `duplicate divergence ${key}`);
    seen.add(key);
  }
});

test("each breakout event matches classifyWindow on the live-sized slice at that bar", () => {
  const candles = makeCandles(1500);
  const lookback = liveLookback(DEFAULTS);
  const { events } = walkForward(candles, { divergence: false });
  assert.ok(events.length > 0);
  for (const e of events) {
    const view = candles.slice(e.index - lookback + 1, e.index + 1);
    const detection = classifyWindow(view.slice(-DEFAULTS.window), DEFAULTS, view.slice(-DEFAULTS.window - DEFAULTS.impulseWindow, -DEFAULTS.window));
    assert.ok(detection && detection.breakoutCrossed);
    assert.strictEqual(detection.pattern, e.name);
    assert.strictEqual(detection.bias, e.bias);
  }
  // detectDivergence on the same slice agrees with the walk too.
  const div = walkForward(candles).events.find((e) => e.kind === "divergence");
  const found = detectDivergence(candles.slice(div.index - lookback + 1, div.index + 1), DEFAULTS);
  assert.strictEqual(found.type, div.name);
});

test("the look-ahead guard rejects out-of-order bars", () => {
  const candles = makeCandles(200);
  candles[150] = { ...candles[150], openTime: candles[149].openTime };
  assert.throws(() => walkForward(candles), /look-ahead guard/);
});

test("ATR depends only on past bars and drives the variant thresholds", () => {
  const candles = makeCandles(300);
  const atr = atrSeries(candles);
  assert.strictEqual(atr[13], null);
  assert.ok(atr[14] > 0);
  const changed = candles.map((c, i) => (i > 200 ? { ...c, high: c.high * 2 } : c));
  assert.deepStrictEqual(atrSeries(changed).slice(0, 201), atr.slice(0, 201));

  const variant = makeVariants({ impulseK: [3], bufferK: ["fixed", 0.5] });
  assert.deepStrictEqual(variant.map((v) => v.id), ["default", "atr imp=3x buf=fixed", "atr imp=3x buf=0.5x"]);
  assert.deepStrictEqual(variant[1].paramsAt({ atrPct: 0.02 }), { impulseMin: 0.06 });
  assert.deepStrictEqual(variant[2].paramsAt({ atrPct: 0.02 }), { impulseMin: 0.06, breakoutBuffer: 0.01 });
  assert.strictEqual(variant[2].paramsAt({ atrPct: null }), null);
});

test("scoring uses the tracker horizon, ±2% threshold and candle extremes", () => {
  const candles = flatCandles(60);
  // Bars 11..34 are the 24h horizon after an entry at bar 10.
  candles[15] = { ...candles[15], high: 108, low: 97 };
  candles[34] = { ...candles[34], close: 103, high: 103 };
  assert.strictEqual(resolveIndex(candles, 10, "1h"), 34);

  const bull = scoreEvent(candles, { index: 10, bias: "bullish" }, "1h");
  assert.strictEqual(bull.exitIndex, 34);
  assert.strictEqual(bull.outcome, "hit");
  assert.ok(Math.abs(bull.dirReturn - 0.03) < 1e-12);
  assert.ok(Math.abs(bull.mfe - 0.08) < 1e-12);
  assert.ok(Math.abs(bull.mae + 0.03) < 1e-12);

  const bear = scoreEvent(candles, { index: 10, bias: "bearish" }, "1h");
  assert.strictEqual(bear.outcome, "miss");
  assert.ok(Math.abs(bear.mfe - 0.03) < 1e-12);
  assert.ok(Math.abs(bear.mae + 0.08) < 1e-12);

  candles[34] = { ...candles[34], close: 101.5 };
  assert.strictEqual(scoreEvent(candles, { index: 10, bias: "bullish" }, "1h").outcome, "flat");

  // Not enough future bars yet: unresolved, not scored.
  assert.strictEqual(scoreEvent(candles, { index: 40, bias: "bullish" }, "1h"), null);
  // 4h and 1D use 4 and 10 days.
  assert.strictEqual(resolveIndex(flatCandles(40, 100, 4 * HOUR), 5, "4h"), 29);
  assert.strictEqual(resolveIndex(flatCandles(40, 100, 24 * HOUR), 5, "1D"), 15);
});

test("a missing horizon candle leaves the event unscored, like the tracker", () => {
  const candles = flatCandles(60).filter((_, i) => i !== 34);
  // Entry at bar 10 resolves on bar 34's close, which is missing.
  assert.strictEqual(resolveIndex(candles, 10, "1h"), -1);
  assert.strictEqual(scoreEvent(candles, { index: 10, bias: "bullish" }, "1h"), null);
  // A gap inside the window doesn't matter while the horizon candle exists.
  const holed = flatCandles(60).filter((_, i) => i !== 20);
  assert.strictEqual(holed[resolveIndex(holed, 10, "1h")].openTime, 34 * HOUR);
});

test("MFE and MAE are clamped at zero like the tracker", () => {
  const candles = flatCandles(60);
  for (let i = 11; i <= 34; i++) candles[i] = { ...candles[i], high: 110, low: 105, close: 108 };
  const bull = scoreEvent(candles, { index: 10, bias: "bullish" }, "1h");
  assert.strictEqual(bull.mae, 0);
  const bear = scoreEvent(candles, { index: 10, bias: "bearish" }, "1h");
  assert.strictEqual(bear.mfe, 0);
});

test("outcomes, returns and excursions agree with PatternTrackerService", async () => {
  const candles = makeCandles(600);
  const events = walkForward(candles).events.slice(0, 40);
  const scored = events.map((e) => scoreEvent(candles, e, "1h")).filter(Boolean);
  assert.ok(scored.length > 5);
  const rows = candles.map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume, c.closeTime]);
  const fetchCandles = async ({ startTime, endTime }) => rows.filter((r) => r[0] >= startTime && r[0] <= endTime);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-bt-"));
  const logFile = path.join(dataDir, "pattern-track-log.json");
  try {
    for (const s of scored) {
      fs.rmSync(logFile, { force: true });
      fs.rmSync(`${logFile}.bak`, { force: true });
      const tracker = new PatternTrackerService({ dataDir, fetchCandles, now: () => candles[candles.length - 1].closeTime + 1 });
      tracker.log({
        symbol: "TEST", interval: "1h", kind: s.kind, name: s.name, bias: s.bias, entryPrice: s.entry,
        detectedAt: new Date(candles[s.index].closeTime + 1).toISOString(), candleCloseTime: candles[s.index].closeTime,
      });
      const [resolved] = await tracker.resolveDue();
      assert.ok(resolved, `tracker left event at ${s.index} unresolved`);
      assert.strictEqual(resolved.priceSource, "historical");
      assert.strictEqual(resolved.resolvedPrice, s.exit);
      assert.strictEqual(resolved.outcome, s.outcome);
      assert.strictEqual(resolved.returnPct, Number((s.returnPct * 100).toFixed(2)));
      assert.strictEqual(resolved.mfePct, Number((s.mfe * 100).toFixed(2)));
      assert.strictEqual(resolved.maePct, Number((s.mae * 100).toFixed(2)));
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("summarize matches the tracker's hit-rate definition", () => {
  const s = summarize([
    { outcome: "hit", dirReturn: 0.05, mfe: 0.06, mae: -0.01 },
    { outcome: "miss", dirReturn: -0.03, mfe: 0.01, mae: -0.04 },
    { outcome: "flat", dirReturn: 0.01, mfe: 0.02, mae: -0.01 },
    { outcome: "hit", dirReturn: 0.03, mfe: 0.04, mae: 0 },
  ]);
  assert.strictEqual(s.n, 4);
  assert.strictEqual(s.hitRate, 2 / 3);
  assert.strictEqual(s.flatShare, 0.25);
  assert.ok(Math.abs(s.avgDirReturn - 0.015) < 1e-12);
});

test("variant selection ignores defaults and thin variants", () => {
  const ev = (r) => ({ dirReturn: r });
  const picked = selectVariant({
    default: Array(50).fill(ev(0.1)),
    thin: Array(5).fill(ev(0.5)),
    a: Array(40).fill(ev(0.01)),
    b: Array(40).fill(ev(0.02)),
  }, 30);
  assert.deepStrictEqual({ id: picked.id, n: picked.n }, { id: "b", n: 40 });
  assert.strictEqual(selectVariant({ default: [], thin: [ev(1)] }, 30), null);
});

test("the study splits in- and out-of-sample without overlap and flags thin cells", () => {
  const series = [
    { symbol: "AAAUSDT", interval: "1h", candles: makeCandles(2000, { seed: 3 }) },
    { symbol: "BBBUSDT", interval: "1h", candles: makeCandles(2000, { seed: 5 }) },
  ];
  const variants = makeVariants({ impulseK: ["fixed", 3], bufferK: ["fixed", 0.25] });
  const study = runStudy(series, { variants, split: 0.7, minSamples: 30 });
  const splitIndex = Math.floor(2000 * 0.7);
  for (const e of study.scored) {
    if (e.sample === "is") assert.ok(e.index < splitIndex && e.exitIndex < splitIndex);
    if (e.sample === "oos") assert.ok(e.index >= splitIndex);
    if (e.sample === "purged") assert.ok(e.index < splitIndex && e.exitIndex >= splitIndex);
  }
  assert.ok(study.scored.some((e) => e.sample === "oos"));
  assert.ok(study.checks.viewsChecked > 0 && study.checks.pivotsChecked > 0);

  const report = buildReport(study, { generatedAt: new Date(0) });
  assert.match(report, /# Pattern Scanner backtest/);
  assert.match(report, /## Headline: defaults vs tuned ATR variant \(out-of-sample\)/);
  assert.match(report, /\d+ ⚠/, "thin cells must be flagged");
  assert.match(report, /inconclusive/);
});

test("loadCandles caches closed candles and only tops up the tail", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-bt-cache-"));
  const now = Date.UTC(2025, 0, 2, 5, 30);
  const all = makeCandles(60, { start: Date.UTC(2025, 0, 1) }); // last ones extend past `now`
  const calls = [];
  const fakeFetch = async (url) => {
    const params = new URL(url).searchParams;
    calls.push(Number(params.get("startTime")));
    const start = Number(params.get("startTime"));
    const end = Number(params.get("endTime"));
    const rows = all
      .filter((c) => c.openTime >= start && c.openTime <= end)
      .map((c) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime]);
    return { ok: true, status: 200, json: async () => rows };
  };
  try {
    const first = await loadCandles({ symbol: "TESTUSDT", interval: "1h", days: 2, cacheDir, now, fetchImpl: fakeFetch });
    assert.ok(first.length > 0);
    assert.ok(first.every((c) => c.closeTime < now), "the open candle must be dropped");
    assert.strictEqual(first[first.length - 1].openTime, Date.UTC(2025, 0, 2, 4));

    const offline = await loadCandles({ symbol: "TESTUSDT", interval: "1h", days: 2, cacheDir, now, offline: true, fetchImpl: () => { throw new Error("no network"); } });
    assert.deepStrictEqual(offline, first);

    calls.length = 0;
    const later = now + 2 * HOUR;
    const topped = await loadCandles({ symbol: "TESTUSDT", interval: "1h", days: 2, cacheDir, now: later, fetchImpl: fakeFetch });
    assert.deepStrictEqual(calls, [first[first.length - 1].openTime + 1]);
    assert.strictEqual(topped.length, first.length + 2);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("parseArgs handles both --key value and --key=value", () => {
  assert.deepStrictEqual(parseArgs(["--symbols", "BTCUSDT,ETHUSDT", "--split=0.6", "--offline"]), {
    symbols: "BTCUSDT,ETHUSDT",
    split: "0.6",
    offline: true,
  });
});
