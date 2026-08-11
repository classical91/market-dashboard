"use strict";

// A raw trade intent — the only thing a strategy is allowed to say.
//
// The architectural rule this file exists to enforce: a strategy finds setups,
// the Trading Lab decides whether a setup is worth taking and how big. So an
// intent carries *market observations* and nothing else. It may not carry a
// stop, a target, a size, a risk amount, or a confidence score, because those
// are decisions rather than observations, and they belong to
// checklist -> edge gate -> risk sizing.
//
// The rule is enforced at runtime here, not just in review: buildTradeIntent()
// rejects a forbidden field and whitelists the observations that may ride
// along, then freezes the result. A future edit that tries to smuggle a
// pre-computed stop loss into a strategy fails loudly at the boundary instead
// of quietly duplicating risk logic.

const ENTRY_SIGNALS = new Set(["LONG", "SHORT"]);

// An exit names the thesis it invalidates, so the handler can close only the
// side that broke rather than flattening the symbol.
const EXIT_SIGNALS = new Map([
  ["EXIT_LONG", "LONG"],
  ["EXIT_SHORT", "SHORT"],
]);

const SIGNALS = new Set([...ENTRY_SIGNALS, ...EXIT_SIGNALS.keys()]);

// Decisions that belong to the Trading Lab. Never valid on an intent.
const RISK_FIELDS = [
  "size",
  "initialSize",
  "sizeMultiplier",
  "stopLoss",
  "slDistance",
  "takeProfit",
  "tp1",
  "tp2",
  "riskUsd",
  "riskPct",
  "confidenceScore",
  "score",
  "decision",
  "plan",
  "trade",
  "leverage",
  "entryPrice", // the intent's price field is `price`; an "entry" is a decision
];

// Market observations a strategy may report. A whitelist rather than a
// blocklist: anything a future strategy wants to pass through has to be added
// here deliberately, which is the review moment worth having.
const ALLOWED_INDICATORS = [
  "ema20",
  "ema50",
  "rsi",
  "atr",
  "atrRatio",
  "volumeRatio",
  "macdBullish",
  "trend",
];

function assertNoRiskFields(object, where) {
  for (const field of RISK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(object, field)) {
      throw new Error(
        `A trade intent may not carry "${field}" (${where}) — sizing, levels and scoring belong to the Trading Lab`,
      );
    }
  }
}

/**
 * Build a frozen, validated trade intent.
 *
 * `indicators` are raw readings the downstream checklist scores against — ATR
 * is a volatility measurement, not a stop distance; risk.js is what turns it
 * into levels by applying SL_ATR_MULTIPLE.
 */
function buildTradeIntent(input = {}) {
  // Checked on the *caller's* object, before destructuring. Validating the
  // constructed intent instead would be theatre: it is built from a fixed set
  // of keys, so a smuggled stopLoss would be silently dropped rather than
  // rejected, and the rule would look enforced while doing nothing.
  assertNoRiskFields(input, "intent");

  const {
    signal,
    symbol,
    price,
    tf,
    strategy,
    candleTs,
    source = "live_scanner",
    indicators = null,
  } = input;

  if (!SIGNALS.has(signal)) {
    throw new Error(`Unknown intent signal "${signal}" (expected one of ${[...SIGNALS].join(", ")})`);
  }
  if (!symbol) throw new Error("A trade intent needs a symbol");
  const numericPrice = Number(price);
  if (!(numericPrice > 0)) throw new Error(`A trade intent needs a positive price, got ${price}`);
  if (!candleTs) throw new Error("A trade intent needs the candle timestamp it was decided on");

  let observations = null;
  if (indicators) {
    assertNoRiskFields(indicators, "indicators");
    observations = {};
    for (const key of ALLOWED_INDICATORS) {
      if (indicators[key] !== undefined) observations[key] = indicators[key];
    }
    Object.freeze(observations);
  }

  const intent = {
    signal,
    symbol: String(symbol),
    price: numericPrice,
    tf: String(tf),
    source: String(source),
    strategy: String(strategy),
    candleTs: String(candleTs),
    indicators: observations,
  };

  return Object.freeze(intent);
}

function isEntry(intent) {
  return Boolean(intent) && ENTRY_SIGNALS.has(intent.signal);
}

function isExit(intent) {
  return Boolean(intent) && EXIT_SIGNALS.has(intent.signal);
}

// The position direction an exit intent invalidates.
function exitDirection(intent) {
  return EXIT_SIGNALS.get(intent && intent.signal) || null;
}

module.exports = {
  buildTradeIntent,
  assertNoRiskFields,
  isEntry,
  isExit,
  exitDirection,
  ENTRY_SIGNALS,
  EXIT_SIGNALS,
  SIGNALS,
  RISK_FIELDS,
  ALLOWED_INDICATORS,
};
