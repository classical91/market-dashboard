"use strict";

// The attention order decides what a reader looks at first, so the ordering
// has to be explainable: a transition beats a standing state, disagreement
// beats agreement, and an outage never outranks a market event.
const test = require("node:test");
const assert = require("node:assert");

const { attentionFor, attachAttention, tagCounts, TAGS } = require("../src/services/trade-attention");

function card({ symbol = "APTUSDT", context = "ALIGNED", changeLines = 0, extremeState = "NONE", dominant = "top", stale = false, extremeError = null } = {}) {
  return {
    symbol,
    interval: "4h",
    context: { state: context },
    extremes: extremeError ? { error: extremeError } : { state: extremeState, dominant },
    changes: changeLines
      ? { state: "CHANGED", lines: Array.from({ length: changeLines }, (_, i) => ({ kind: "BIAS", text: `line ${i}` })) }
      : { state: "UNCHANGED", lines: [] },
    freshness: { state: stale ? "STALE" : "FRESH" },
  };
}

function rank(options) {
  return attentionFor(card(options)).rank;
}

test("a transition outranks any standing state", () => {
  // Something that happened on the last candle is newer information than
  // anything that has merely been true for a while.
  assert.ok(rank({ context: "ALIGNED", changeLines: 1 }) > rank({ context: "CONFLICT", extremeState: "CONFIRMED" }));
});

test("disagreement outranks agreement", () => {
  assert.ok(rank({ context: "CONFLICT" }) > rank({ context: "MIXED" }));
  assert.ok(rank({ context: "MIXED" }) > rank({ context: "ALIGNED" }));
  // Nothing contradicting anything is the least urgent thing a card can say,
  // but it still outranks a card with no directional read at all.
  assert.ok(rank({ context: "ALIGNED" }) > rank({ context: "PARTIAL" }));
  assert.ok(rank({ context: "PARTIAL" }) > rank({ context: "QUIET" }));
});

test("a confirmed extreme breaks ties between cards reading the same state", () => {
  assert.ok(rank({ context: "MIXED", extremeState: "CONFIRMED" }) > rank({ context: "MIXED", extremeState: "WATCH" }));
  assert.equal(rank({ context: "MIXED", extremeState: "CONFIRMING" }), rank({ context: "MIXED", extremeState: "CONFIRMED" }));
  // ...but never enough to jump a whole context tier.
  assert.ok(rank({ context: "CONFLICT", extremeState: "NONE" }) > rank({ context: "MIXED", extremeState: "CONFIRMED" }));
});

test("staleness is a tag, never a rank", () => {
  // An outage needs attention for a different reason than a market event.
  // Weighting it would let a dead feed outrank a real transition, and
  // demoting it would quietly bury a card still worth seeing.
  assert.equal(rank({ context: "ALIGNED", stale: true }), rank({ context: "ALIGNED", stale: false }));
  assert.ok(attentionFor(card({ stale: true })).tags.includes("STALE"));
  assert.ok(!attentionFor(card({ stale: false })).tags.includes("STALE"));
});

test("tags describe the card, and a broken extremes engine claims nothing", () => {
  const conflicted = attentionFor(card({ context: "CONFLICT", changeLines: 2, extremeState: "CONFIRMED" }));
  assert.deepEqual(conflicted.tags.sort(), ["CHANGED", "CONFLICT", "EXTREME_CONFIRMED"]);
  assert.equal(conflicted.changeCount, 2);

  const broken = attentionFor(card({ context: "PARTIAL", extremeError: "Local extremes unavailable" }));
  assert.ok(!broken.tags.includes("EXTREME_CONFIRMED"), "a failed engine must not be read as a confirmed extreme");
  assert.deepEqual(broken.tags, ["PARTIAL"]);
});

test("a changed card with no transition lines is not tagged as changed", () => {
  const empty = attentionFor({
    symbol: "X", interval: "4h", context: { state: "ALIGNED" }, extremes: { state: "NONE" },
    changes: { state: "CHANGED", lines: [] }, freshness: { state: "FRESH" },
  });
  assert.ok(!empty.tags.includes("CHANGED"));
  assert.equal(empty.changeCount, 0);
});

test("a card with no change section at all still ranks", () => {
  // The observation store is optional, so cards can arrive without one.
  const plain = attentionFor({ symbol: "X", interval: "4h", context: { state: "CONFLICT" }, extremes: { state: "NONE" }, freshness: { state: "FRESH" } });
  assert.equal(plain.changeCount, 0);
  assert.deepEqual(plain.tags, ["CONFLICT"]);
  assert.ok(plain.rank > 0);
});

test("sorting by rank puts the cards worth opening at the top", () => {
  const cards = [
    card({ symbol: "AAAUSDT", context: "ALIGNED" }),
    card({ symbol: "BBBUSDT", context: "CONFLICT", extremeState: "CONFIRMED" }),
    card({ symbol: "CCCUSDT", context: "QUIET" }),
    card({ symbol: "DDDUSDT", context: "ALIGNED", changeLines: 1 }),
  ];
  attachAttention(cards);
  const order = cards
    .slice()
    .sort((a, b) => b.attention.rank - a.attention.rank || a.symbol.localeCompare(b.symbol))
    .map((c) => c.symbol);

  assert.deepEqual(order, ["DDDUSDT", "BBBUSDT", "AAAUSDT", "CCCUSDT"]);
});

test("tag counts cover every filter the toolbar offers, including the empty ones", () => {
  const cards = [card({ context: "CONFLICT", changeLines: 1, extremeState: "CONFIRMED" }), card({ symbol: "ETHUSDT", context: "ALIGNED", stale: true })];
  attachAttention(cards);
  const counts = tagCounts(cards);

  // Every tag is present even at zero, so the control set keeps its shape
  // between loads instead of filters appearing and vanishing.
  assert.deepEqual(Object.keys(counts).sort(), TAGS.slice().sort());
  assert.equal(counts.CHANGED, 1);
  assert.equal(counts.CONFLICT, 1);
  assert.equal(counts.ALIGNED, 1);
  assert.equal(counts.EXTREME_CONFIRMED, 1);
  assert.equal(counts.STALE, 1);
  assert.equal(counts.MIXED, 0);
  assert.equal(counts.QUIET, 0);
});
