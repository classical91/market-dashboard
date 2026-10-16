"use strict";

// Which of these cards deserves a look first?
//
// The page can already answer "what is true" and "what just changed" per
// pair. On a fifteen-pair watchlist neither helps until the cards are in an
// order that puts the few worth opening at the top — otherwise the reader
// does the ranking by eye, every time, against whatever order they happened
// to star things in.
//
// This assigns each card a rank and a set of tags. It decides nothing about
// trades: a rank says "look at this one before that one", never "take this
// one". The ordering is a fixed, explainable rule rather than a learned or
// weighted score, so a reader can always tell why a card is where it is.

// Disagreement outranks agreement, deliberately. A CONFLICT is a confirmed
// extreme pointing against the directional structure — the one reading on
// this page that is worth stopping for. ALIGNED means nothing currently
// contradicts anything, which is the least urgent thing a card can say, and
// QUIET and PARTIAL carry no directional read at all.
const CONTEXT_WEIGHT = { CONFLICT: 6, MIXED: 4, ALIGNED: 3, PARTIAL: 2, QUIET: 1 };

// A transition dominates the ordering: something happening on the last closed
// candle is newer information than any standing state, so it is worth more
// than the widest gap between two context states.
const CHANGED_WEIGHT = 10;

// A confirmed or confirming extreme breaks ties between cards whose context
// reads the same — price has actually turned, not merely stretched.
const EXTREME_WEIGHT = 1;
const CONFIRMED_EXTREME_STATES = new Set(["CONFIRMED", "CONFIRMING"]);

// The filters the toolbar offers. STALE is a tag but carries no weight: a
// card whose feed has stopped advancing needs attention for a different
// reason than a market event, and folding the two together would let an
// outage outrank a real transition — or quietly bury a stale card that is
// still worth seeing.
const TAGS = ["CHANGED", "CONFLICT", "MIXED", "ALIGNED", "QUIET", "PARTIAL", "EXTREME_CONFIRMED", "STALE"];

function hasChanged(card) {
  const changes = card.changes;
  return Boolean(changes && changes.state === "CHANGED" && Array.isArray(changes.lines) && changes.lines.length);
}

function hasConfirmedExtreme(card) {
  const extremes = card.extremes || {};
  return Boolean(!extremes.error && extremes.dominant && CONFIRMED_EXTREME_STATES.has(extremes.state));
}

/**
 * One card's place in the attention order, plus the tags it can be filtered
 * by. `changeCount` rides along so the page can break ties between two
 * changed cards on how much moved, without re-deriving it.
 */
function attentionFor(card) {
  const contextState = (card.context && card.context.state) || null;
  const changed = hasChanged(card);
  const confirmedExtreme = hasConfirmedExtreme(card);
  const stale = Boolean(card.freshness && card.freshness.state === "STALE");

  const tags = [];
  if (changed) tags.push("CHANGED");
  if (contextState && CONTEXT_WEIGHT[contextState] != null) tags.push(contextState);
  if (confirmedExtreme) tags.push("EXTREME_CONFIRMED");
  if (stale) tags.push("STALE");

  const rank =
    (changed ? CHANGED_WEIGHT : 0) +
    (CONTEXT_WEIGHT[contextState] || 0) +
    (confirmedExtreme ? EXTREME_WEIGHT : 0);

  return {
    rank,
    tags,
    changeCount: changed ? card.changes.lines.length : 0,
  };
}

/** Attaches `attention` to every card. Called after changes, which it reads. */
function attachAttention(cards) {
  for (const card of cards) card.attention = attentionFor(card);
  return cards;
}

/**
 * How many cards carry each tag, so the toolbar can show counts and disable
 * a filter that would empty the grid rather than letting a reader select it
 * and wonder where everything went.
 */
function tagCounts(cards) {
  const counts = {};
  for (const tag of TAGS) counts[tag] = 0;
  for (const card of cards) {
    for (const tag of (card.attention && card.attention.tags) || []) {
      if (counts[tag] != null) counts[tag] += 1;
    }
  }
  return counts;
}

module.exports = {
  attentionFor,
  attachAttention,
  tagCounts,
  CONTEXT_WEIGHT,
  CHANGED_WEIGHT,
  EXTREME_WEIGHT,
  TAGS,
};
