"use strict";

// Freshness answers "is what I am looking at now?" — the one question the
// scores themselves cannot answer. These cover the distinctions that make it
// worth having: a mid-bar candle is not stale, a lagging feed is, a missing
// timestamp is never read as fresh, and the thresholds move with the
// timeframe so a 15m card and a daily card are not judged alike.
const test = require("node:test");
const assert = require("node:assert");

const {
  formatAge,
  intervalMs,
  toMillis,
  candleToleranceMs,
  calculationToleranceMs,
  assessSource,
  assessFreshness,
} = require("../src/services/data-freshness");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function source(overrides = {}) {
  return { key: "screener", label: "Bias & extremes", ...overrides };
}

test("ages read as ages, at most two units", () => {
  assert.equal(formatAge(0), "just now");
  assert.equal(formatAge(45 * 1000), "just now");
  assert.equal(formatAge(23 * MINUTE), "23m");
  assert.equal(formatAge(2 * HOUR), "2h");
  assert.equal(formatAge(2 * HOUR + 13 * MINUTE), "2h 13m");
  assert.equal(formatAge(50 * HOUR), "2d 2h");
  assert.equal(formatAge(null), null);
  // A clock skew that puts the candle marginally in the future is not "-1m".
  assert.equal(formatAge(-5000), "just now");
});

test("timestamps arrive as epoch millis or ISO strings, and both are read", () => {
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.equal(toMillis("2026-09-20T10:00:00.000Z"), Date.parse("2026-09-20T10:00:00.000Z"));
  assert.equal(toMillis(null), null);
  assert.equal(toMillis("not a date"), null);
  assert.equal(toMillis(Number.NaN), null);
});

test("a candle mid-bar is current, not stale — staleness starts past a whole bar", () => {
  const now = Date.now();
  // Three hours into a 4h bar: the newest closed candle is genuinely the
  // newest one there is. Flagging this would flag every healthy 4h card.
  const midBar = assessSource(source({ interval: "4h", candleCloseTime: now - 3 * HOUR, computedAt: now - MINUTE }), now);
  assert.equal(midBar.state, "FRESH");
  assert.equal(midBar.candleStale, false);

  // Past a bar plus the half-bar of slack: a candle should have closed and
  // none did, so the feed is behind.
  const lagging = assessSource(source({ interval: "4h", candleCloseTime: now - 7 * HOUR, computedAt: now - MINUTE }), now);
  assert.equal(lagging.state, "STALE");
  assert.equal(lagging.candleStale, true);
  assert.match(lagging.reason, /closed 4h candle 7h ago/);
});

test("the two clocks fail independently: current candles, stalled recompute", () => {
  const now = Date.now();
  const notRecalculated = assessSource(
    source({ interval: "1h", candleCloseTime: now - 10 * MINUTE, computedAt: now - 3 * HOUR }),
    now,
  );
  assert.equal(notRecalculated.state, "STALE");
  assert.equal(notRecalculated.candleStale, false, "the candles themselves are current");
  assert.equal(notRecalculated.calculationStale, true);
  assert.match(notRecalculated.reason, /last calculated 3h ago/);
});

test("thresholds scale with the timeframe and stay inside a sane bracket", () => {
  assert.equal(candleToleranceMs("4h"), 6 * HOUR);
  assert.equal(candleToleranceMs("1h"), 1.5 * HOUR);
  assert.equal(candleToleranceMs("1D"), 36 * HOUR);
  assert.equal(candleToleranceMs("nonsense"), null);

  // A 15m quarter-bar would be under the engines' own 5-minute cache TTL, so
  // the floor keeps a healthy page off the stale list; the ceiling stops a
  // weekly card from tolerating a recompute from two days ago.
  assert.equal(calculationToleranceMs("15m"), 10 * MINUTE);
  assert.equal(calculationToleranceMs("1h"), 15 * MINUTE);
  assert.equal(calculationToleranceMs("4h"), HOUR);
  assert.equal(calculationToleranceMs("1W"), HOUR);
  assert.equal(intervalMs("1D"), 24 * HOUR);
});

test("an engine with no timestamps is UNKNOWN, never FRESH", () => {
  const now = Date.now();
  const silent = assessSource(source({ interval: "4h" }), now);
  assert.equal(silent.state, "UNKNOWN");
  assert.equal(silent.candleAgeMs, null);

  const broken = assessSource(source({ interval: "4h", error: true, candleCloseTime: now - HOUR, computedAt: now }), now);
  assert.equal(broken.state, "UNKNOWN", "a failed engine's last-known timestamps are not a freshness claim");
  assert.match(broken.reason, /unavailable/);
});

test("the roll-up is pessimistic: the oldest clock, and one stale engine makes the card stale", () => {
  const now = Date.now();
  const freshness = assessFreshness({
    interval: "4h",
    sources: [
      { key: "screener", label: "Bias & extremes", candleCloseTime: now - 23 * MINUTE, computedAt: now - 2 * MINUTE },
      { key: "patterns", label: "Pattern scan", candleCloseTime: now - 9 * HOUR, computedAt: now - 40 * MINUTE },
    ],
  }, now);

  assert.equal(freshness.state, "STALE");
  assert.equal(freshness.candleAgeMs, 9 * HOUR, "the card reports its weakest link, not its strongest");
  assert.equal(freshness.calculationAgeMs, 40 * MINUTE);
  assert.equal(freshness.staleReasons.length, 1);
  assert.match(freshness.staleReasons[0], /^Pattern scan/, "the stale engine is named, not just flagged");
});

test("a healthy card reads as one line of two ages", () => {
  const now = Date.now();
  const freshness = assessFreshness({
    interval: "4h",
    sources: [
      { key: "screener", label: "Bias & extremes", candleCloseTime: now - 23 * MINUTE, computedAt: now - 2 * MINUTE },
      { key: "patterns", label: "Pattern scan", candleCloseTime: now - 23 * MINUTE, computedAt: now - 2 * MINUTE },
    ],
  }, now);

  assert.equal(freshness.state, "FRESH");
  assert.equal(freshness.summary, "4h candle closed 23m ago · context calculated 2m ago");
  assert.deepEqual(freshness.staleReasons, []);
  assert.equal(freshness.sources.length, 2);
});

test("no timestamps anywhere says so rather than claiming an age", () => {
  const freshness = assessFreshness({ interval: "1D", sources: [{ key: "screener", label: "Bias & extremes" }] });
  assert.equal(freshness.state, "UNKNOWN");
  assert.match(freshness.summary, /candle age unknown/);
  assert.match(freshness.summary, /calculation time unknown/);
});

test("one engine down does not make the surviving engine's age the card's verdict", () => {
  const now = Date.now();
  const freshness = assessFreshness({
    interval: "4h",
    sources: [
      { key: "screener", label: "Bias & extremes", error: true },
      { key: "patterns", label: "Pattern scan", candleCloseTime: now - 30 * MINUTE, computedAt: now - MINUTE },
    ],
  }, now);

  // The live engine really is fresh, and the dead one is reported as dead
  // rather than quietly dropped or counted as stale.
  assert.equal(freshness.state, "FRESH");
  assert.equal(freshness.sources.find((s) => s.key === "screener").state, "UNKNOWN");
});
