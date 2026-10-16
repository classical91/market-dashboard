"use strict";

// What changed on this pair since the last time the engines looked?
//
// The card says what is true now. It cannot say what is new, which is the
// question a watchlist is actually read with: fifteen pairs all showing a
// state tell you nothing about which three to inspect. A transition does —
// TOP WATCH becoming TOP CONFIRMED is the event; TOP CONFIRMED sitting there
// for two days is not.
//
// Two design rules follow from "since the last scan" having to mean something
// stable:
//
//   The baseline rolls on bar closes, not on page loads. Reporting a
//   transition and then immediately rebasing would make it vanish on the next
//   refresh — the reader would see it once, if they happened to look. Each
//   source instead keeps the values it held at the previous closed candle, so
//   the same transition reads identically for as long as the current bar
//   lasts, and rolls forward only when a new candle closes.
//
//   A broken engine never rewrites history. An outage would otherwise read as
//   a transition ("BULLISH 67 → unavailable") and, worse, overwrite the last
//   good values with nothing, so the real change would be lost when the
//   engine recovered. An untrustworthy read is skipped: its baseline is left
//   exactly as it was.
//
// Only categorical transitions are tracked — bias, extreme state, pattern,
// divergence, context. Continuous readings (raw extreme scores, OI change
// percentages, RSI values) drift every bar, and reporting that drift as
// change would bury the four transitions that matter in noise. The directional
// score is the exception: it moves in whole confluence checks, so any change
// in it is a check flipping rather than a rounding wobble.

const path = require("path");
const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");

const STORE_VERSION = 1;

// Each source is one engine's worth of state, tracked on its own candle clock
// because the engines advance independently.
const SOURCES = ["screener", "patterns", "context"];

function pairKey(symbol, interval) {
  return `${symbol}:${interval}`;
}

function titleCase(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * The categorical state of one card, split by the engine that owns each part.
 *
 * `candleCloseTime` is what decides when a source's baseline rolls, and
 * `trusted` is what decides whether it rolls at all: a section carrying an
 * error contributes no values and keeps whatever the store already held.
 */
function observeCard(card) {
  const freshness = card.freshness || {};
  const sources = freshness.sources || [];
  const candleOf = (key) => {
    const source = sources.find((s) => s.key === key);
    return source && Number.isFinite(source.candleCloseTime) ? source.candleCloseTime : null;
  };

  const bias = card.directionalBias || {};
  const extremes = card.extremes || {};
  const patterns = card.patterns || {};
  const context = card.context || {};

  const screenerCandle = candleOf("screener");
  const patternCandle = candleOf("patterns");

  return {
    screener: {
      candleCloseTime: screenerCandle,
      trusted: !bias.error && !extremes.error && screenerCandle != null,
      values: {
        bias: bias.bias || null,
        biasScore: Number.isFinite(bias.score) ? bias.score : null,
        extremeState: extremes.state || null,
        extremeDominant: extremes.dominant || null,
      },
    },
    patterns: {
      candleCloseTime: patternCandle,
      trusted: !patterns.error && patternCandle != null,
      values: {
        pattern: patterns.pattern || null,
        patternStatus: patterns.status || null,
        patternBias: patterns.patternBias || null,
        divergence: patterns.divergence || null,
        divergenceBias: patterns.divergenceBias || null,
      },
    },
    // The context state is derived from both engines, so it is only
    // trustworthy when both are — and it advances on whichever candle moved.
    context: {
      candleCloseTime: screenerCandle != null && patternCandle != null
        ? Math.max(screenerCandle, patternCandle)
        : screenerCandle ?? patternCandle,
      trusted: !bias.error && !extremes.error && !patterns.error
        && (screenerCandle != null || patternCandle != null),
      values: { state: context.state || null },
    },
  };
}

/** `BULLISH 83` — the score rides along with the label it qualifies. */
function biasText(values) {
  if (!values.bias) return null;
  return values.biasScore == null ? values.bias : `${values.bias} ${values.biasScore}`;
}

/** `TOP CONFIRMED` — the dominant side is part of the state, not a separate one. */
function extremeText(values) {
  if (!values.extremeState) return null;
  if (!values.extremeDominant || values.extremeState === "NONE") return values.extremeState;
  return `${values.extremeDominant.toUpperCase()} ${values.extremeState}`;
}

function patternText(values) {
  if (!values.pattern) return null;
  return values.patternStatus ? `${values.pattern} · ${titleCase(values.patternStatus)}` : values.pattern;
}

function divergenceText(values) {
  return values.divergence ? `${values.divergence} divergence` : null;
}

/**
 * One transition line. Something appearing from nothing reads as NEW and
 * something disappearing as CLEARED, because "— → Rising Wedge" is a worse
 * way of saying a wedge has formed.
 */
function transition(kind, from, to) {
  if (from === to) return null;
  if (from == null && to == null) return null;
  if (from == null) return { kind, label: "NEW", from: null, to, text: to };
  if (to == null) return { kind, label: "CLEARED", from, to: null, text: from };
  return { kind, label: "CHANGED", from, to, text: `${from} → ${to}` };
}

/**
 * Transitions between two observations of one pair, in the order a reader
 * wants them: whether the engines' agreement changed first, then what moved
 * underneath it.
 */
function diffValues(previous, current) {
  const lines = [];
  const prevContext = (previous.context && previous.context.values) || {};
  const curContext = (current.context && current.context.values) || {};
  const prevScreener = (previous.screener && previous.screener.values) || {};
  const curScreener = (current.screener && current.screener.values) || {};
  const prevPatterns = (previous.patterns && previous.patterns.values) || {};
  const curPatterns = (current.patterns && current.patterns.values) || {};

  const push = (line) => { if (line) lines.push(line); };

  if (current.context && current.context.trusted && previous.context) {
    push(transition("CONTEXT", prevContext.state, curContext.state));
  }
  if (current.screener && current.screener.trusted && previous.screener) {
    push(transition("BIAS", biasText(prevScreener), biasText(curScreener)));
    push(transition("EXTREME", extremeText(prevScreener), extremeText(curScreener)));
  }
  if (current.patterns && current.patterns.trusted && previous.patterns) {
    push(transition("DIVERGENCE", divergenceText(prevPatterns), divergenceText(curPatterns)));
    push(transition("PATTERN", patternText(prevPatterns), patternText(curPatterns)));
  }
  return lines;
}

/**
 * The stored record for one pair, advanced against a fresh observation.
 *
 * Returns the record to persist and the transitions to report. A source rolls
 * only when a new candle has closed on it, so `previous` holds the values from
 * the candle before the current one for the whole of the current bar — which
 * is what makes a reported change survive a refresh.
 */
function advanceRecord(record, observation, now = Date.now()) {
  const next = {};
  let rolled = false;
  let firstObservation = false;

  for (const key of SOURCES) {
    const source = observation[key];
    const stored = record ? record[key] : null;

    if (!source || !source.trusted) {
      // Nothing trustworthy to record: keep the last good baseline untouched
      // rather than overwriting it with an outage.
      if (stored) next[key] = stored;
      continue;
    }
    if (!stored) {
      next[key] = { candleCloseTime: source.candleCloseTime, values: source.values, previous: null, changedAt: new Date(now).toISOString() };
      firstObservation = true;
      continue;
    }
    if (source.candleCloseTime != null && stored.candleCloseTime != null
      && source.candleCloseTime > stored.candleCloseTime) {
      next[key] = {
        candleCloseTime: source.candleCloseTime,
        values: source.values,
        previous: { candleCloseTime: stored.candleCloseTime, values: stored.values },
        changedAt: new Date(now).toISOString(),
      };
      rolled = true;
      continue;
    }
    next[key] = stored;
  }

  const comparable = SOURCES.some((key) => next[key] && next[key].previous);
  const previousView = {};
  const currentView = {};
  for (const key of SOURCES) {
    const slot = next[key];
    if (!slot || !slot.previous) continue;
    previousView[key] = { values: slot.previous.values, trusted: true };
    currentView[key] = { values: slot.values, trusted: Boolean(observation[key] && observation[key].trusted) };
  }

  const lines = comparable ? diffValues(previousView, currentView) : [];
  const changedAt = SOURCES
    .map((key) => next[key] && next[key].changedAt)
    .filter(Boolean)
    .sort()
    .pop() || null;
  const candleCloseTime = SOURCES
    .map((key) => next[key] && next[key].candleCloseTime)
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => (max == null || value > max ? value : max), null);

  let state;
  if (!comparable) state = firstObservation || !record ? "FIRST_OBSERVATION" : "UNAVAILABLE";
  else state = lines.length ? "CHANGED" : "UNCHANGED";

  return {
    record: next,
    dirty: rolled || firstObservation,
    changes: {
      state,
      lines,
      since: comparable ? { candleCloseTime, at: changedAt } : null,
    },
  };
}

/**
 * Last-known categorical state per tracked pair, on disk.
 *
 * It uses the repository's fail-closed reader, so a corrupt file throws rather
 * than silently reading as "nothing was ever observed" — which would both lose
 * the history and let the next write cement that loss. Callers are expected to
 * catch it and degrade the change section alone: losing transitions is not a
 * reason to blank a page full of live market context.
 */
class TradeObservationStore {
  constructor({ dataDir, logger = console } = {}) {
    this._file = path.join(dataDir, "trade-observations.json");
    this._logger = logger;
    this._lock = { depth: 0 };
  }

  read() {
    const parsed = readJsonStore(this._file, this._logger, "[TradeObservations]");
    if (!parsed || typeof parsed !== "object" || parsed.version !== STORE_VERSION) return {};
    return parsed.pairs && typeof parsed.pairs === "object" ? parsed.pairs : {};
  }

  write(pairs) {
    return withExclusiveLock(
      this._file,
      this._lock,
      () => writeJsonAtomic(this._file, { version: STORE_VERSION, pairs }, this._logger, "[TradeObservations]"),
      { busyMessage: "Trade observations are busy; retry the request." },
    );
  }
}

module.exports = {
  TradeObservationStore,
  observeCard,
  advanceRecord,
  diffValues,
  transition,
  pairKey,
  STORE_VERSION,
  SOURCES,
};
