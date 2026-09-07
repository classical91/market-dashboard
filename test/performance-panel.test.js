"use strict";

// The Backtest Lab performance panel's own logic: model building, the
// zoom/pan viewport, the hover lookup and the chart geometry.
//
// These are the tests that make the chart's INTERACTION checkable. Asserting
// that trading-lab.js contains the string "Reset Zoom" proves a button exists;
// it proves nothing about whether resetting works, whether a zoom can be
// dragged off the end of the run, or whether the tooltip reports the bar the
// crosshair is standing on. performance-panel.js exists so those can be
// answered directly.

const test = require("node:test");
const assert = require("node:assert");

const P = require("../public/assets/js/performance-panel");

function series(count, fn) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const point = fn ? fn(i) : {};
    out.push({
      at: new Date(Date.UTC(2026, 0, 1) + i * 14400000).toISOString(),
      strategy: point.strategy === undefined ? 10000 + i * 10 : point.strategy,
      benchmark: point.benchmark === undefined ? 10000 + i * 5 : point.benchmark,
    });
  }
  return out;
}

function payload(count, extra) {
  return Object.assign(
    {
      startingBalance: 10000,
      strategy: { netPnlUsd: 500, returnPct: 5, maxDrawdownPct: 2, totalTrades: 8, winRate: 50, profitFactor: 1.4, openAtEnd: 0 },
      benchmark: { available: true, netPnlUsd: 250, returnPct: 2.5, maxDrawdownPct: 4 },
      series: series(count),
      aligned: true,
    },
    extra || {},
  );
}

/* ── Model ──────────────────────────────────────────────────────────────── */

test("a well-formed payload builds a drawable model", () => {
  const model = P.buildModel(payload(50));
  assert.strictEqual(model.available, true);
  assert.strictEqual(model.points.length, 50);
  assert.strictEqual(model.hasBenchmark, true);
  assert.strictEqual(model.startingBalance, 10000);
  assert.deepStrictEqual(model.warnings, []);
});

test("a missing or malformed performance block is an empty state, not a crash", () => {
  for (const input of [undefined, null, "", 0, "nope", [], { series: null }, { series: [] }]) {
    const model = P.buildModel(input);
    assert.strictEqual(model.available, false, JSON.stringify(input));
    assert.ok(model.reason, "an empty state must say why");
    assert.deepStrictEqual(model.points, []);
  }
});

test("a single equity point is an empty state — a curve needs two", () => {
  const model = P.buildModel(payload(1));
  assert.strictEqual(model.available, false);
  assert.match(model.reason, /single equity point/i);
});

test("junk inside the series is dropped rather than plotted", () => {
  const model = P.buildModel(
    payload(0, {
      series: [
        { at: "a", strategy: 100, benchmark: 90 },
        null,
        "garbage",
        { at: "b", strategy: null, benchmark: 90 },
        { at: "c", strategy: "not a number", benchmark: 90 },
        { at: "d", strategy: 110, benchmark: 95 },
      ],
    }),
  );
  assert.strictEqual(model.points.length, 2);
  assert.deepStrictEqual(model.points.map((p) => p.strategy), [100, 110]);
});

test("a null benchmark value stays null instead of becoming a $0 equity", () => {
  // Number(null) is 0, and a benchmark line that dives to the floor on a
  // missing point is a chart that invents a crash.
  const model = P.buildModel(
    payload(0, {
      series: [
        { at: "a", strategy: 100, benchmark: null },
        { at: "b", strategy: 110, benchmark: 95 },
      ],
    }),
  );
  assert.strictEqual(model.points[0].benchmark, null);
  assert.strictEqual(model.points[1].benchmark, 95);
});

test("an unavailable benchmark is announced, not silently absent", () => {
  const model = P.buildModel(
    payload(10, { benchmark: { available: false, reason: "no candles were replayed" } }),
  );
  assert.strictEqual(model.hasBenchmark, false);
  assert.strictEqual(model.warnings.length, 1);
  assert.match(model.warnings[0], /no candles were replayed/);
});

test("open positions at the end are called out, because net P&L then means something else", () => {
  const model = P.buildModel(
    payload(10, {
      strategy: { netPnlUsd: 500, returnPct: 5, maxDrawdownPct: 2, totalTrades: 3, winRate: 33, profitFactor: 1, openAtEnd: 2 },
    }),
  );
  assert.ok(model.warnings.some((w) => /marked to market/i.test(w)), model.warnings.join("|"));
});

test("a server-reported misalignment reaches the reader", () => {
  const model = P.buildModel(payload(10, { aligned: false }));
  assert.ok(model.warnings.some((w) => /different span/i.test(w)), model.warnings.join("|"));
});

/* ── Viewport: zoom, pan, reset ─────────────────────────────────────────── */

test("the default view is the whole run and the reset control is idle in it", () => {
  assert.deepStrictEqual(P.fullView(), { start: 0, end: 1 });
  assert.strictEqual(P.isFullView(P.fullView()), true);
  assert.strictEqual(P.isFullView({ start: 0.2, end: 0.8 }), false);
});

test("zooming in narrows the window and keeps the focused point under the cursor", () => {
  const count = 500;
  const zoomed = P.zoomView(P.fullView(), 0.25, 0.5, count);
  assert.ok(zoomed.end - zoomed.start < 1, "the window should have narrowed");
  assert.ok(Math.abs(zoomed.end - zoomed.start - 0.5) < 1e-9);
  // The point at 25% of the old view is still at 25% of the new one.
  const anchorBefore = 0.25;
  const anchorAfter = zoomed.start + (zoomed.end - zoomed.start) * 0.25;
  assert.ok(Math.abs(anchorAfter - anchorBefore) < 1e-9, `anchor drifted to ${anchorAfter}`);
});

test("zooming out can never show more than the whole run", () => {
  const wide = P.zoomView({ start: 0.4, end: 0.6 }, 0.5, 100, 500);
  assert.deepStrictEqual(wide, { start: 0, end: 1 });
  assert.strictEqual(P.isFullView(wide), true);
});

test("zoom stops before the chart becomes fewer points than it can draw", () => {
  const count = 40;
  let view = P.fullView();
  for (let i = 0; i < 60; i += 1) view = P.zoomView(view, 0.5, 0.5, count);
  const range = P.visibleRange(P.buildModel(payload(count)), view);
  assert.ok(
    range.to - range.from + 1 >= P.MIN_VISIBLE_POINTS,
    `zoomed to ${range.to - range.from + 1} points, below the ${P.MIN_VISIBLE_POINTS} floor`,
  );
});

test("a zero or negative zoom factor is refused rather than inverting the view", () => {
  const view = { start: 0.2, end: 0.6 };
  assert.deepStrictEqual(P.zoomView(view, 0.5, 0, 100), view);
  assert.deepStrictEqual(P.zoomView(view, 0.5, -2, 100), view);
  assert.deepStrictEqual(P.zoomView(view, 0.5, NaN, 100), view);
});

test("panning moves by a fraction of the VISIBLE span, not of the whole run", () => {
  // Half a screen at any zoom level. Panning by a fraction of the full domain
  // would make the same drag fly across the run once zoomed in.
  const panned = P.panView({ start: 0.4, end: 0.6 }, 0.5, 500);
  assert.ok(Math.abs(panned.start - 0.5) < 1e-9, `start ${panned.start}`);
  assert.ok(Math.abs(panned.end - 0.7) < 1e-9, `end ${panned.end}`);
});

test("panning cannot drag the chart off either end of the run", () => {
  const right = P.panView({ start: 0.8, end: 1 }, 5, 500);
  assert.ok(right.end <= 1 + 1e-9 && right.start >= -1e-9);
  assert.ok(Math.abs(right.end - right.start - 0.2) < 1e-9, "the span must survive the clamp");

  const left = P.panView({ start: 0, end: 0.2 }, -5, 500);
  assert.ok(left.start >= -1e-9);
  assert.ok(Math.abs(left.end - left.start - 0.2) < 1e-9);
});

test("reset returns to the full view from anywhere", () => {
  let view = P.zoomView(P.fullView(), 0.9, 0.05, 800);
  view = P.panView(view, -0.8, 800);
  assert.strictEqual(P.isFullView(view), false);
  assert.strictEqual(P.isFullView(P.fullView()), true);
});

test("a reversed or nonsense view is repaired instead of drawn", () => {
  assert.deepStrictEqual(P.clampView({ start: 0.8, end: 0.2 }, 500), { start: 0.2, end: 0.8 });
  assert.deepStrictEqual(P.clampView({ start: NaN, end: 0.5 }, 500), { start: 0, end: 1 });
  assert.deepStrictEqual(P.clampView(null, 500), { start: 0, end: 1 });
  const over = P.clampView({ start: -0.5, end: 1.5 }, 500);
  assert.ok(over.start >= 0 && over.end <= 1);
});

/* ── Visible window ─────────────────────────────────────────────────────── */

test("the visible range covers the whole run at full extent", () => {
  const model = P.buildModel(payload(120));
  const range = P.visibleRange(model, P.fullView());
  assert.deepStrictEqual(range, { from: 0, to: 119 });
});

test("a zoomed window selects an interior slice and always has width", () => {
  const model = P.buildModel(payload(100));
  const range = P.visibleRange(model, { start: 0.5, end: 0.6 });
  assert.ok(range.from >= 49 && range.to <= 60, JSON.stringify(range));
  assert.ok(range.to > range.from, "a visible range must never collapse to one index");
  assert.strictEqual(P.visiblePoints(model, { start: 0.5, end: 0.6 }).length, range.to - range.from + 1);
});

/* ── Geometry ───────────────────────────────────────────────────────────── */

test("both lines share one y scale, so a losing strategy cannot sit above a winning benchmark", () => {
  const model = P.buildModel(
    payload(0, {
      startingBalance: 10000,
      series: [
        { at: "a", strategy: 10000, benchmark: 10000 },
        { at: "b", strategy: 9000, benchmark: 14000 },
      ],
    }),
  );
  const geometry = P.buildGeometry(model, P.fullView(), { width: 600, height: 200 });

  // The frame must contain both extremes...
  assert.ok(geometry.min < 9000 && geometry.max > 14000, `${geometry.min}..${geometry.max}`);
  // ...and the losing strategy's endpoint must sit BELOW the benchmark's,
  // which is only true if one scale drew both.
  assert.ok(geometry.yAt(9000) > geometry.yAt(14000), "y grows downward, so the loser must be lower");
});

test("the starting balance stays in frame even when both curves run away from it", () => {
  // A chart that scrolls break-even off the top makes a losing run look like a
  // rising one.
  const model = P.buildModel(
    payload(0, {
      startingBalance: 10000,
      series: [
        { at: "a", strategy: 4000, benchmark: 4200 },
        { at: "b", strategy: 3000, benchmark: 3900 },
      ],
    }),
  );
  const geometry = P.buildGeometry(model, P.fullView(), { width: 600, height: 200 });
  assert.ok(geometry.max > 10000, `break-even fell outside the frame (max ${geometry.max})`);
  assert.ok(geometry.baselineY >= 0 && geometry.baselineY <= 200, `baseline at ${geometry.baselineY}`);
});

test("a gap in the benchmark breaks its line instead of bridging the missing bars", () => {
  const model = P.buildModel(
    payload(0, {
      series: [
        { at: "a", strategy: 100, benchmark: 100 },
        { at: "b", strategy: 101, benchmark: 101 },
        { at: "c", strategy: 102, benchmark: null },
        { at: "d", strategy: 103, benchmark: 103 },
        { at: "e", strategy: 104, benchmark: 104 },
      ],
    }),
  );
  const geometry = P.buildGeometry(model, P.fullView(), { width: 600, height: 200 });
  assert.strictEqual(geometry.strategy.length, 1, "the strategy line is unbroken");
  assert.strictEqual(geometry.benchmark.length, 2, "the benchmark should be two segments");
});

test("no benchmark means no benchmark geometry at all", () => {
  const model = P.buildModel(payload(20, { benchmark: { available: false, reason: "unavailable" } }));
  const geometry = P.buildGeometry(model, P.fullView(), { width: 600, height: 200 });
  assert.deepStrictEqual(geometry.benchmark, []);
  assert.ok(geometry.strategy.length >= 1);
});

test("a perfectly flat run still produces a finite frame rather than dividing by zero", () => {
  const model = P.buildModel(
    payload(0, {
      startingBalance: 10000,
      series: [
        { at: "a", strategy: 10000, benchmark: 10000 },
        { at: "b", strategy: 10000, benchmark: 10000 },
      ],
    }),
  );
  const geometry = P.buildGeometry(model, P.fullView(), { width: 600, height: 200 });
  assert.ok(Number.isFinite(geometry.min) && Number.isFinite(geometry.max));
  assert.ok(geometry.max > geometry.min, "a flat curve still needs a non-zero span");
  geometry.ticks.forEach((tick) => assert.ok(Number.isFinite(tick.y)));
});

test("geometry redraws to the zoomed slice, not the whole run", () => {
  const model = P.buildModel(payload(200));
  const zoomed = P.buildGeometry(model, { start: 0.5, end: 0.6 }, { width: 600, height: 200 });
  assert.ok(zoomed.points.length < 200 / 2, `${zoomed.points.length} points is not a zoom`);
  assert.strictEqual(zoomed.points[0], model.points[zoomed.from]);
});

/* ── Hover ──────────────────────────────────────────────────────────────── */

test("hovering reports the bar under the pointer, with both values and the gap", () => {
  const model = P.buildModel(payload(101));
  const mid = P.pointAtRatio(model, P.fullView(), 0.5);
  assert.strictEqual(mid.index, 50);
  assert.strictEqual(mid.at, model.points[50].at);
  assert.strictEqual(mid.strategy, model.points[50].strategy);
  assert.strictEqual(mid.benchmark, model.points[50].benchmark);
  assert.strictEqual(mid.diff, model.points[50].strategy - model.points[50].benchmark);
});

test("the edges of the chart report the first and last visible bars", () => {
  const model = P.buildModel(payload(60));
  assert.strictEqual(P.pointAtRatio(model, P.fullView(), 0).index, 0);
  assert.strictEqual(P.pointAtRatio(model, P.fullView(), 1).index, 59);
});

test("a pointer position outside the chart is clamped, never read as an out-of-range bar", () => {
  const model = P.buildModel(payload(60));
  assert.strictEqual(P.pointAtRatio(model, P.fullView(), -3).index, 0);
  assert.strictEqual(P.pointAtRatio(model, P.fullView(), 42).index, 59);
  assert.strictEqual(P.pointAtRatio(model, P.fullView(), NaN).index, 0);
});

test("hovering a zoomed chart reads bars from the zoomed window", () => {
  // The specific failure this guards: a tooltip that keeps reading the full
  // run's index while the line under it shows a ten-bar slice.
  const model = P.buildModel(payload(200));
  const view = { start: 0.5, end: 0.6 };
  const range = P.visibleRange(model, view);
  const found = P.pointAtRatio(model, view, 0);
  assert.strictEqual(found.index, range.from);
  assert.strictEqual(P.pointAtRatio(model, view, 1).index, range.to);
});

test("a missing benchmark value reports no difference rather than a fabricated one", () => {
  const model = P.buildModel(
    payload(0, {
      series: [
        { at: "a", strategy: 100, benchmark: null },
        { at: "b", strategy: 110, benchmark: 95 },
      ],
    }),
  );
  const found = P.pointAtRatio(model, P.fullView(), 0);
  assert.strictEqual(found.benchmark, null);
  assert.strictEqual(found.diff, null);
});

test("there is nothing to hover on an unavailable model", () => {
  assert.strictEqual(P.pointAtRatio(P.buildModel(null), P.fullView(), 0.5), null);
});

/* ── Formatting ─────────────────────────────────────────────────────────── */

test("money and percentages carry their sign where the sign is the point", () => {
  assert.strictEqual(P.formatSignedUsd(1234.5), "+$1,234.5");
  assert.strictEqual(P.formatSignedUsd(-1234.5), "-$1,234.5");
  assert.strictEqual(P.formatSignedUsd(0), "$0");
  assert.strictEqual(P.formatUsd(null), "—");
  assert.strictEqual(P.formatPct(4.2), "+4.20%");
  assert.strictEqual(P.formatPct(-4.2), "-4.20%");
  assert.strictEqual(P.formatPct(null), "—");
});

test("a null profit factor is ∞ only when there are trades to justify it", () => {
  // null from metrics.js means "wins, no losses". With no trades at all it
  // means nothing happened, and printing ∞ there would be a claim.
  assert.strictEqual(P.formatProfitFactor(null, 6), "∞");
  assert.strictEqual(P.formatProfitFactor(null, 0), "—");
  assert.strictEqual(P.formatProfitFactor(undefined, 0), "—");
  assert.strictEqual(P.formatProfitFactor(1.5, 6), "1.50");
});

test("epoch-millisecond bar timestamps format as dates, not as raw numbers", () => {
  // Candle closeTime arrives from the exchange as epoch milliseconds (see
  // signal-screener.js), and a panel that stringifies it first ends up
  // printing "1741636800000" in every tooltip and on both axis labels.
  const ms = Date.UTC(2026, 2, 10, 20, 0, 0);
  assert.doesNotMatch(P.formatDateTime(ms), /^\d+$/, "epoch ms should not print as a number");
  assert.match(P.formatDateTime(ms), /2026/);
  assert.match(P.formatDay(ms), /2026/);
  // ...including after a JSON round trip that leaves it as a numeric string.
  assert.match(P.formatDateTime(String(ms)), /2026/);
  assert.match(P.formatDay(String(ms)), /2026/);
});

test("a numeric bar timestamp survives the model with its type intact", () => {
  const ms = Date.UTC(2026, 2, 10);
  const model = P.buildModel(
    payload(0, {
      series: [
        { at: ms, strategy: 100, benchmark: 100 },
        { at: ms + 14400000, strategy: 110, benchmark: 105 },
      ],
    }),
  );
  assert.strictEqual(model.points[0].at, ms);
  assert.match(P.formatDateTime(P.pointAtRatio(model, P.fullView(), 0).at), /2026/);
});

test("an unparseable timestamp is shown as given rather than as a fake date", () => {
  assert.strictEqual(P.formatDateTime(null), "—");
  assert.strictEqual(P.formatDateTime("not-a-date"), "not-a-date");
  assert.strictEqual(P.formatDay("not-a-date"), "not-a-date");
  assert.ok(P.formatDateTime("2026-01-01T00:00:00.000Z").length > 4);
});
