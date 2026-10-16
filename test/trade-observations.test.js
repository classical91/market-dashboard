"use strict";

// "Changed since last scan" is only useful if the baseline is stable. These
// cover the three ways it could lie: a transition that vanishes when you
// refresh, an outage recorded as a change, and a first look reported as
// "nothing changed".
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  TradeObservationStore,
  observeCard,
  advanceRecord,
  transition,
  pairKey,
} = require("../src/services/trade-observations");

const HOUR = 60 * 60 * 1000;
const BAR_1 = Date.UTC(2026, 9, 16, 4, 0, 0) - 1;
const BAR_2 = BAR_1 + 4 * HOUR;
const BAR_3 = BAR_2 + 4 * HOUR;

/** A card shaped like the one buildCard emits, at a given candle. */
function card({
  candle = BAR_1,
  bias = "BULLISH",
  score = 83,
  extremeState = "WATCH",
  extremeDominant = "top",
  pattern = null,
  patternStatus = null,
  divergence = null,
  context = "ALIGNED",
  biasError = null,
  patternError = null,
  patternCandle = undefined,
} = {}) {
  return {
    symbol: "APTUSDT",
    interval: "4h",
    directionalBias: biasError ? { error: biasError } : { bias, score },
    extremes: biasError ? { error: biasError } : { state: extremeState, dominant: extremeDominant },
    patterns: patternError
      ? { error: patternError }
      : { pattern, status: patternStatus, patternBias: "bearish", divergence, divergenceBias: "bearish" },
    context: { state: context },
    freshness: {
      sources: [
        { key: "screener", candleCloseTime: biasError ? null : candle },
        { key: "patterns", candleCloseTime: patternError ? null : (patternCandle === undefined ? candle : patternCandle) },
      ],
    },
  };
}

test("a pair's first look is reported as a first look, not as 'nothing changed'", () => {
  const { record, changes, dirty } = advanceRecord(null, observeCard(card()), Date.now());
  assert.equal(changes.state, "FIRST_OBSERVATION");
  assert.deepEqual(changes.lines, []);
  assert.ok(dirty, "the baseline has to be persisted or every load is a first look");
  assert.equal(record.screener.candleCloseTime, BAR_1);
  assert.equal(record.screener.previous, null);
});

test("a transition survives a refresh — the baseline rolls on candles, not page loads", () => {
  const now = Date.now();
  let state = advanceRecord(null, observeCard(card({ extremeState: "WATCH" })), now);

  // A new candle closes and the extreme confirms.
  state = advanceRecord(state.record, observeCard(card({ candle: BAR_2, extremeState: "CONFIRMED" })), now);
  assert.equal(state.changes.state, "CHANGED");
  const first = state.changes.lines.find((l) => l.kind === "EXTREME");
  assert.equal(first.text, "TOP WATCH → TOP CONFIRMED");

  // The reader refreshes twice more inside the same bar. The transition is
  // still the answer to "what changed on the last candle" — consuming it on
  // first view would mean only a reader who happened to look ever sees it.
  for (let i = 0; i < 2; i++) {
    state = advanceRecord(state.record, observeCard(card({ candle: BAR_2, extremeState: "CONFIRMED" })), now);
    assert.equal(state.changes.state, "CHANGED");
    assert.equal(state.changes.lines.find((l) => l.kind === "EXTREME").text, "TOP WATCH → TOP CONFIRMED");
    assert.equal(state.dirty, false, "an unchanged bar must not rewrite the store on every read");
  }

  // Next candle closes with nothing moving: now it genuinely is unchanged.
  state = advanceRecord(state.record, observeCard(card({ candle: BAR_3, extremeState: "CONFIRMED" })), now);
  assert.equal(state.changes.state, "UNCHANGED");
  assert.deepEqual(state.changes.lines, []);
});

test("the four transitions the card promises all read in the engines' own words", () => {
  const now = Date.now();
  const before = advanceRecord(null, observeCard(card({
    bias: "BULLISH", score: 83, extremeState: "WATCH", context: "ALIGNED", divergence: null, pattern: null,
  })), now);

  const after = advanceRecord(before.record, observeCard(card({
    candle: BAR_2,
    bias: "BULLISH", score: 67, extremeState: "CONFIRMED", context: "MIXED",
    divergence: "Regular Bearish", pattern: "Rising Wedge", patternStatus: "forming",
  })), now);

  const byKind = Object.fromEntries(after.changes.lines.map((l) => [l.kind, l]));
  assert.equal(byKind.CONTEXT.text, "ALIGNED → MIXED");
  assert.equal(byKind.BIAS.text, "BULLISH 83 → BULLISH 67");
  assert.equal(byKind.EXTREME.text, "TOP WATCH → TOP CONFIRMED");
  assert.equal(byKind.DIVERGENCE.text, "Regular Bearish divergence");
  assert.equal(byKind.DIVERGENCE.label, "NEW", "something appearing reads as NEW, not as '— → X'");
  assert.equal(byKind.PATTERN.text, "Rising Wedge · Forming");
  // Agreement first, then what moved underneath it.
  assert.equal(after.changes.lines[0].kind, "CONTEXT");
});

test("something disappearing reads as CLEARED rather than a reversed arrow", () => {
  assert.equal(transition("PATTERN", null, "Rising Wedge").label, "NEW");
  assert.equal(transition("PATTERN", "Rising Wedge", null).label, "CLEARED");
  assert.equal(transition("PATTERN", "Rising Wedge", "Rising Wedge"), null);
  assert.equal(transition("PATTERN", null, null), null);
});

test("an outage is not a transition, and does not overwrite the last good values", () => {
  const now = Date.now();
  const healthy = advanceRecord(null, observeCard(card({ bias: "BULLISH", score: 83, extremeState: "WATCH" })), now);

  // The screener dies while the pattern scan stays on the same candle, so the
  // only thing that happened this read is the outage itself.
  const broken = advanceRecord(
    healthy.record,
    observeCard(card({ candle: BAR_2, patternCandle: BAR_1, biasError: "Binance klines HTTP 451" })),
    now,
  );
  assert.ok(!broken.changes.lines.some((l) => l.kind === "BIAS"), "a dead engine must not read as a bias change");
  assert.equal(broken.record.screener.values.bias, "BULLISH");
  assert.equal(broken.record.screener.values.biasScore, 83, "the last good read is preserved for the comparison to come");
  assert.equal(broken.record.screener.candleCloseTime, BAR_1, "a failed read does not advance the baseline's candle");
  assert.equal(broken.dirty, false, "an outage on its own is not something to persist");

  // It recovers two bars later having actually moved: the change that was
  // hidden by the outage surfaces now rather than being lost with it.
  const recovered = advanceRecord(broken.record, observeCard(card({ candle: BAR_3, patternCandle: BAR_3, bias: "BEARISH", score: 67, extremeState: "CONFIRMED" })), now);
  assert.equal(recovered.changes.state, "CHANGED");
  assert.equal(recovered.changes.lines.find((l) => l.kind === "BIAS").text, "BULLISH 83 → BEARISH 67");
});

test("each engine advances on its own candle clock", () => {
  const now = Date.now();
  const start = advanceRecord(null, observeCard(card({ candle: BAR_1, patternCandle: BAR_1, pattern: null })), now);

  // The pattern scan picks up a new bar while the screener is still serving
  // the old one. Only the pattern side rolls.
  const next = advanceRecord(start.record, observeCard(card({ candle: BAR_1, patternCandle: BAR_2, pattern: "Bull Flag", patternStatus: "forming" })), now);
  assert.equal(next.record.screener.candleCloseTime, BAR_1);
  assert.equal(next.record.patterns.candleCloseTime, BAR_2);
  assert.equal(next.changes.lines.length, 1);
  assert.equal(next.changes.lines[0].kind, "PATTERN");
});

test("continuous readings are deliberately not tracked as change", () => {
  const now = Date.now();
  const first = advanceRecord(null, observeCard({
    ...card(), extremes: { state: "WATCH", dominant: "top", topScore: 71, bottomScore: 12 },
  }), now);
  const second = advanceRecord(first.record, observeCard({
    ...card({ candle: BAR_2 }), extremes: { state: "WATCH", dominant: "top", topScore: 88, bottomScore: 9 },
  }), now);

  // The top score drifted 17 points with no state change: real, but not an
  // event, and reporting it would bury the transitions that are.
  assert.equal(second.changes.state, "UNCHANGED");
});

test("the store round-trips, and a corrupt file refuses to read as empty", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-observations-"));
  try {
    const store = new TradeObservationStore({ dataDir, logger: { error() {} } });
    assert.deepEqual(store.read(), {}, "a store that does not exist yet is simply empty");

    const pairs = { [pairKey("APTUSDT", "4h")]: { screener: { candleCloseTime: BAR_1, values: { bias: "BULLISH" }, previous: null } } };
    assert.equal(store.write(pairs), true);
    assert.deepEqual(store.read(), pairs, "observations survive a restart");

    // Reading a damaged store as "nothing was ever observed" would lose the
    // history and let the next write cement that loss.
    fs.writeFileSync(path.join(dataDir, "trade-observations.json"), "{ not json", "utf8");
    assert.throws(() => store.read(), /unreadable/i);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a store written by a future version is not read as this version's shape", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-observations-"));
  try {
    const store = new TradeObservationStore({ dataDir, logger: { error() {} } });
    fs.writeFileSync(path.join(dataDir, "trade-observations.json"), JSON.stringify({ version: 99, pairs: { x: {} } }), "utf8");
    assert.deepEqual(store.read(), {}, "an unknown layout starts over rather than being misread");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
