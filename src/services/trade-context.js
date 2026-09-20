"use strict";

// One tracked pair -> one card of evidence, assembled from the engines that
// already exist. This service computes no indicators of its own: the
// directional bias and the local extremes come from SignalScreenerService,
// the pattern and divergence from PatternScannerService, and both are read
// through their per-symbol scanToken methods so a three-pair watchlist costs
// three pairs of cached lookups rather than two full 25-symbol universe scans.
//
// It deliberately does not produce a combined score. Direction, location and
// structure answer different questions, and averaging them into one number
// would rebuild exactly the ambiguity the screener's bias rename removed. The
// only thing added on top is a context state — whether the engines currently
// agree — and that state never becomes an instruction to buy or sell.

const { assessFreshness } = require("./data-freshness");

// The bias engine speaks in LONG / SHORT / FLAT on the wire; the dashboards
// read it as BULLISH / BEARISH / NEUTRAL.
const BIAS_LABELS = { LONG: "BULLISH", SHORT: "BEARISH", FLAT: "NEUTRAL" };

// Which direction each piece of evidence leans, so disagreement can be
// detected without any of them being treated as a trade signal.
const BIAS_DIRECTION = { LONG: "bullish", SHORT: "bearish", FLAT: null };
// A local bottom is exhaustion of a down-move (leans bullish); a local top is
// exhaustion of an up-move (leans bearish).
const EXTREME_DIRECTION = { bottom: "bullish", top: "bearish" };

// Only these extreme states are strong enough for a disagreement to read as a
// hard CONFLICT; the weaker ones make a card MIXED instead.
const STRONG_EXTREME_STATES = new Set(["CONFIRMED", "CONFIRMING"]);

function biasLabel(signal) {
  return BIAS_LABELS[signal] || "NEUTRAL";
}

function titleCase(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Directional bias from the screener row, or an error placeholder. The score
 * is passed through untouched — it is the screener's own confluence count.
 */
function buildDirectionalBias(row) {
  if (!row || row.error) {
    return { bias: null, score: null, trendRegime: null, error: (row && row.error) || "Directional bias unavailable" };
  }
  return {
    bias: biasLabel(row.signal),
    signal: row.signal,
    score: Number.isFinite(row.score) ? row.score : null,
    trendRegime: row.trendRegime || null,
    rsi: Number.isFinite(row.rsi) ? row.rsi : null,
    adx: Number.isFinite(row.adx) ? row.adx : null,
  };
}

/**
 * Bottom and top stay separate, exactly as the engine reports them: this is
 * the one place a reader can see that a stretched top and a bullish bias are
 * both true at once.
 */
function buildExtremes(row) {
  const extreme = row && !row.error ? row.extreme : null;
  if (!extreme || extreme.error) {
    return {
      bottomScore: null,
      topScore: null,
      dominant: null,
      state: null,
      error: (extreme && extreme.error) || (row && row.error) || "Local extremes unavailable",
    };
  }
  const dominantSide = extreme.dominant ? extreme[extreme.dominant] : null;
  return {
    bottomScore: extreme.bottom ? extreme.bottom.score : null,
    topScore: extreme.top ? extreme.top.score : null,
    dominant: extreme.dominant || null,
    state: extreme.state || "NONE",
    setupType: (extreme.context && extreme.context.setupType) || null,
    trend: (extreme.context && extreme.context.trend) || null,
    reasons: dominantSide && Array.isArray(dominantSide.reasons)
      ? dominantSide.reasons.map((reason) => reason.label)
      : [],
  };
}

function buildPatterns(row) {
  if (!row || row.error) {
    return { pattern: null, status: null, divergence: null, error: (row && row.error) || "Pattern scan unavailable" };
  }
  return {
    pattern: row.pattern ? row.pattern.pattern : null,
    patternBias: row.pattern ? row.pattern.bias : null,
    patternScore: row.pattern ? row.pattern.score : null,
    status: row.pattern ? row.pattern.status : null,
    divergence: row.divergence ? row.divergence.type : null,
    divergenceBias: row.divergence ? row.divergence.bias : null,
    divergenceBarsAgo: row.divergence ? row.divergence.barsAgo : null,
  };
}

/**
 * The strongest few observations behind the numbers above, in the engines'
 * own words. Capped so a card stays readable rather than exhaustive.
 */
function buildEvidence({ directionalBias, extremes, patterns }) {
  const evidence = [];
  if (extremes.reasons && extremes.reasons.length) {
    evidence.push(...extremes.reasons.slice(0, 3));
  }
  if (patterns.divergence) {
    const age = patterns.divergenceBarsAgo;
    evidence.push(`${patterns.divergence} divergence${age != null ? ` (${age} ${age === 1 ? "bar" : "bars"} ago)` : ""}`);
  }
  if (patterns.pattern) {
    evidence.push(`${patterns.pattern}${patterns.status ? ` · ${titleCase(patterns.status)}` : ""}`);
  }
  if (directionalBias.trendRegime) {
    const regime = { TREND_UP: "EMA structure bullish", TREND_DOWN: "EMA structure bearish", MIXED: "EMA structure mixed" };
    evidence.push(regime[directionalBias.trendRegime] || directionalBias.trendRegime);
  }
  // The extremes engine and the pattern scan both report divergence, so the
  // same observation can arrive twice under slightly different wording.
  const seen = new Set();
  return evidence
    .filter((line) => {
      const key = line.toLowerCase().replace(/\s*\(.*\)$/, "").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

/**
 * Whether the engines currently agree — never what to do about it.
 *
 * QUIET    no engine has a directional read
 * PARTIAL  an engine is down and too little is left to compare
 * ALIGNED  every read present points the same way
 * MIXED    reads disagree, but only weakly (a candidate extreme, a pattern or
 *          a divergence against the bias)
 * CONFLICT a confirmed or confirming extreme points against a directional bias
 *
 * An engine that is silent and an engine that is broken are not the same
 * thing: a quiet pattern scan genuinely means "nothing reads the other way",
 * while a failed one means nobody looked. Claiming ALIGNED off a single
 * surviving read would turn an outage into false agreement.
 */
function classifyContext({ directionalBias, extremes, patterns }) {
  const unavailable = [];
  if (directionalBias.error) unavailable.push("directional bias");
  if (extremes.error) unavailable.push("local extremes");
  if (patterns.error) unavailable.push("the pattern scan");
  const opinions = [];
  const biasDirection = directionalBias.bias ? BIAS_DIRECTION[directionalBias.signal] : null;
  if (biasDirection) opinions.push({ source: "bias", engine: "directional bias", direction: biasDirection });

  const extremeDirection = extremes.dominant ? EXTREME_DIRECTION[extremes.dominant] : null;
  const extremeIsStrong = STRONG_EXTREME_STATES.has(extremes.state);
  if (extremeDirection && extremes.state && extremes.state !== "NONE") {
    opinions.push({ source: "extreme", engine: "local extremes", direction: extremeDirection, strong: extremeIsStrong });
  }
  // A pattern and a divergence both come from the pattern scan, so they are
  // two observations from one engine, not two independent confirmations.
  if (patterns.patternBias) opinions.push({ source: "pattern", engine: "the pattern scan", direction: patterns.patternBias });
  if (patterns.divergenceBias) opinions.push({ source: "divergence", engine: "the pattern scan", direction: patterns.divergenceBias });

  if (!opinions.length) {
    return {
      state: unavailable.length ? "PARTIAL" : "QUIET",
      summary: unavailable.length
        ? `Nothing to compare — ${unavailable.join(" and ")} unavailable.`
        : "No directional read on any engine right now.",
    };
  }

  // One engine left standing because the others broke is not agreement, no
  // matter how many observations that single engine reports.
  const enginesWithRead = new Set(opinions.map((o) => o.engine));
  if (unavailable.length && enginesWithRead.size < 2) {
    const directions = Array.from(new Set(opinions.map((o) => o.direction))).join(" and ");
    return {
      state: "PARTIAL",
      summary: `Only ${opinions[0].engine} has a read (${directions}) — ${unavailable.join(" and ")} unavailable.`,
    };
  }

  const bullish = opinions.filter((o) => o.direction === "bullish");
  const bearish = opinions.filter((o) => o.direction === "bearish");

  if (!bullish.length || !bearish.length) {
    const side = bullish.length ? "bullish" : "bearish";
    return {
      state: "ALIGNED",
      summary: `${titleCase(side)} across ${opinions.map((o) => o.source).join(", ")} — nothing currently reads the other way.`,
    };
  }

  // A confirmed or confirming extreme against the bias is the disagreement
  // worth stopping for: price is stretched and has begun to turn, inside a
  // trend still pointing the other way.
  const hardExtreme = opinions.find((o) => o.source === "extreme" && o.strong);
  const conflicting = hardExtreme && biasDirection && hardExtreme.direction !== biasDirection;
  const counter = (hardExtreme && hardExtreme.direction === "bullish" ? bullish : bearish)
    .concat([])
    .map((o) => o.source);

  if (conflicting) {
    return {
      state: "CONFLICT",
      summary: `${titleCase(biasDirection)} directional structure, but a ${extremes.dominant}-side extreme is ${String(extremes.state).toLowerCase()}${counter.length > 1 ? ` (${counter.join(", ")})` : ""}.`,
    };
  }

  return {
    state: "MIXED",
    summary: `${bullish.map((o) => o.source).join(", ")} lean bullish while ${bearish.map((o) => o.source).join(", ")} lean bearish.`,
  };
}

/**
 * How current the evidence on this card is, per engine.
 *
 * The bias and the extremes are two readings of one screener row, so they
 * share one clock; the pattern scan keeps its own. Freshness is reported
 * beside the context state and never folded into it — whether the engines
 * agree and whether they are looking at current data are separate questions,
 * and a stale ALIGNED card must not read as a weaker ALIGNED.
 */
function buildFreshness({ item, screenerRow, patternRow, now }) {
  return assessFreshness({
    interval: item.interval,
    sources: [
      {
        key: "screener",
        label: "Bias & extremes",
        candleCloseTime: screenerRow ? screenerRow.candleCloseTime : null,
        computedAt: screenerRow ? screenerRow.computedAt : null,
        error: !screenerRow || Boolean(screenerRow.error),
      },
      {
        key: "patterns",
        label: "Pattern scan",
        candleCloseTime: patternRow ? patternRow.candleCloseTime : null,
        computedAt: patternRow ? patternRow.scannedAt : null,
        error: !patternRow || Boolean(patternRow.error),
      },
    ],
  }, now);
}

function buildCard({ item, screenerRow, patternRow, now = Date.now() }) {
  const directionalBias = buildDirectionalBias(screenerRow);
  const extremes = buildExtremes(screenerRow);
  const patterns = buildPatterns(patternRow);
  // One upstream failure surfaces through both the bias and the extremes
  // sections, so the card would otherwise print the same message twice.
  const errors = Array.from(new Set([directionalBias.error, extremes.error, patterns.error].filter(Boolean)));
  return {
    symbol: item.symbol,
    label: item.label || (patternRow && patternRow.label) || item.symbol,
    interval: item.interval,
    price: screenerRow && !screenerRow.error && Number.isFinite(screenerRow.price) ? screenerRow.price : null,
    addedAt: item.addedAt || null,
    directionalBias,
    extremes,
    patterns,
    evidence: buildEvidence({ directionalBias, extremes, patterns }),
    context: classifyContext({ directionalBias, extremes, patterns }),
    freshness: buildFreshness({ item, screenerRow, patternRow, now }),
    // A card renders on whatever came back; a dead engine is reported here
    // rather than blanking the pair.
    errors,
    chart: patternRow && patternRow.chart ? patternRow.chart : null,
  };
}

class TradeContextService {
  constructor({ watchlistService, signalScreenerService, patternScannerService } = {}) {
    this._watchlist = watchlistService;
    this._screener = signalScreenerService;
    this._patterns = patternScannerService;
  }

  /**
   * One card per watchlist entry, each on that entry's own timeframe. Both
   * engines are asked per symbol so nothing scans the full universe, and a
   * rejection from either one degrades that section of the card instead of
   * failing the request.
   */
  async list({ force = false } = {}) {
    const items = this._watchlist.list();
    if (!items.length) return { items: [], cards: [] };

    // One clock for the whole request, so two cards that were computed at the
    // same moment never report ages a second apart.
    const now = Date.now();
    const cards = await Promise.all(items.map(async (item) => {
      const [screener, pattern] = await Promise.allSettled([
        this._screener.scanToken(item.symbol, item.interval, undefined, { force }),
        this._patterns.scanToken(item.symbol, item.interval, { force }),
      ]);
      return buildCard({
        item,
        now,
        screenerRow: screener.status === "fulfilled" ? screener.value : { error: screener.reason?.message || "Directional engine failed" },
        patternRow: pattern.status === "fulfilled" ? pattern.value : { error: pattern.reason?.message || "Pattern engine failed" },
      });
    }));

    return { items, cards };
  }
}

module.exports = {
  TradeContextService,
  buildCard,
  buildFreshness,
  classifyContext,
  buildEvidence,
  BIAS_LABELS,
};
