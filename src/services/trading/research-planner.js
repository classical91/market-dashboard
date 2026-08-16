"use strict";

// Research planning — the first stage of the Trading Lab workflow.
//
//   Market Research  →  Backtest  →  Demo Account  →  Promotion Decision
//   ^^^^^^^^^^^^^^^
//
// Research has exactly three jobs, and this module is all three:
//
//   1. Market discovery      which pairs are worth testing right now
//   2. Regime discovery      what environment each of them is in
//   3. Experiment generation which strategy × symbol × timeframe backtests
//                            those two facts justify running
//
// ── What this deliberately does not do ──────────────────────────────────────
//
// It produces BACKTEST candidates. Nothing here opens a position, touches a
// strategy ledger, changes a lifecycle status, or feeds the live scanner. A
// generated candidate is a question ("does SMC work on ETHUSDT 1h?"), and the
// answer comes from a replay on a disposable ledger.
//
// It also cannot create forward-paper evidence on a new pair: Live Research is
// single-symbol (LIVE_RESEARCH_SYMBOL, BTCUSDT by default), so a candidate on
// SOLUSDT is a backtest question and the UI says so rather than implying a
// fifth demo account is about to appear.

const { classifyRegime } = require("./regime");
const { listStrategies } = require("./strategies");
const { TOP_TOKENS } = require("../../config/market-symbols");

// The strategies a generated candidate may name. Backtest capability is the
// bar because a candidate IS a backtest — a strategy that cannot be replayed on
// candles (shadow_bananagun_v1) has nothing to answer here.
function backtestableStrategies() {
  return listStrategies({ supportsBacktest: true });
}

/**
 * Which strategy families suit which environment.
 *
 * This is a PRIOR, not a finding. It exists to decide what is worth spending a
 * backtest on when there is no evidence yet — the regime router answers the
 * same question from measured results once results exist, and it is the one to
 * believe. Keeping the two apart matters: a prior that quietly became the
 * answer would let the lab confirm its own assumptions.
 *
 * A strategy declares its own mode through `tradesCounterTrend`, so this reads
 * the registry rather than hard-coding a list that would drift.
 */
function suitsRegime(strategy, regime) {
  const meanReversion = strategy.tradesCounterTrend === true;
  switch (regime) {
    case "TREND_UP":
    case "TREND_DOWN":
      return !meanReversion;
    case "RANGE":
    case "ACCUMULATION":
    case "DISTRIBUTION":
      return meanReversion;
    // Nothing is obviously suited to an expansion, a coil, or an unreadable
    // market — so everything is a fair question rather than nothing being one.
    default:
      return true;
  }
}

/**
 * Market discovery: which pairs look worth testing.
 *
 * Ranked by the screener's own confluence score, which is the measurement it
 * already makes for the Signal Screener page. Reused rather than reinvented —
 * a second definition of "interesting pair" would drift from the first.
 *
 * A FLAT pair is not excluded. "Nothing is happening on SOLUSDT right now" is a
 * fine reason to backtest a range strategy there, and filtering to directional
 * signals only would bias the whole research pipeline toward trends.
 */
async function discoverMarkets(screener, { interval = "1h", limit = 5, symbols = null } = {}) {
  if (!screener || typeof screener.scanToken !== "function") {
    throw Object.assign(new Error("Market discovery needs a signal screener"), {
      statusCode: 503,
      expose: true,
    });
  }

  const universe = (symbols && symbols.length ? symbols : TOP_TOKENS).map((s) => String(s).toUpperCase());
  const scanned = await Promise.all(
    universe.map(async (symbol) => {
      try {
        return await screener.scanToken(symbol, interval);
      } catch (err) {
        return { symbol, error: err.message };
      }
    }),
  );

  const usable = scanned.filter((row) => row && !row.error && Number.isFinite(Number(row.score)));
  usable.sort((a, b) => Number(b.score) - Number(a.score));

  return {
    interval,
    scanned: scanned.length,
    unavailable: scanned.filter((row) => row && row.error).map((row) => ({ symbol: row.symbol, error: row.error })),
    markets: usable.slice(0, Math.max(1, Number(limit) || 5)).map((row) => ({
      symbol: row.symbol,
      score: row.score,
      signal: row.signal,
      adx: row.adx ?? null,
      trendRegime: row.trendRegime ?? null,
    })),
  };
}

/**
 * Regime discovery: the environment each discovered pair is in.
 *
 * Uses the shared regime engine rather than the screener's coarser
 * `trendRegime`, so a candidate's recorded environment means the same thing as
 * every other regime reading in the lab.
 *
 * A pair whose candles cannot be read gets `UNKNOWN` and is still returned:
 * dropping it would silently shrink the research universe whenever a feed
 * hiccuped, and an unreadable pair is a fact worth seeing.
 */
async function discoverRegimes(screener, markets, { interval = "1h" } = {}) {
  return Promise.all(
    markets.map(async (market) => {
      try {
        const candles = await screener.getCandles(market.symbol, interval);
        const read = classifyRegime(candles || []);
        return {
          ...market,
          regime: read.regime,
          regimeConfidence: read.confidence,
          regimeActionable: read.actionable,
          preferredMode: read.preferredMode,
        };
      } catch (err) {
        return {
          ...market,
          regime: "UNKNOWN",
          regimeConfidence: 0,
          regimeActionable: false,
          preferredMode: "NONE",
          regimeError: err.message,
        };
      }
    }),
  );
}

/**
 * Experiment generation: the candidates the first two jobs justify.
 *
 * One candidate per strategy × symbol × timeframe, with the rationale and the
 * regime recorded at the moment it was proposed — a candidate raised in a range
 * and run months later in a trend is not the same question, and without the
 * recorded environment that difference is invisible.
 *
 * `includeMismatched` widens generation to strategies the regime prior does not
 * favour. Off by default because the point is to spend backtests where they are
 * most likely to teach something; on when the question is deliberately "does
 * VWAP really fail in trends?", which is a finding worth having rather than
 * assuming.
 */
function generateExperiments(regimeMarkets, { timeframes = ["1h"], includeMismatched = false, strategies = null } = {}) {
  const available = backtestableStrategies();
  const chosen = strategies && strategies.length
    ? available.filter((meta) => strategies.map(String).includes(meta.id))
    : available;

  const candidates = [];
  for (const market of regimeMarkets) {
    for (const strategy of chosen) {
      const suited = suitsRegime(strategy, market.regime);
      if (!suited && !includeMismatched) continue;
      for (const timeframe of timeframes) {
        candidates.push({
          strategy: strategy.id,
          symbol: market.symbol,
          timeframe: String(timeframe),
          origin: market.origin || "market-discovery",
          rationale: suited
            ? `${market.symbol} reads ${market.regime} (${market.regimeConfidence}% confidence); ${strategy.name} is a ${strategy.tradesCounterTrend ? "mean-reversion" : "trend-following"} strategy suited to it`
            : `${market.symbol} reads ${market.regime}; testing ${strategy.name} against an environment it is not expected to suit`,
          regime: {
            regime: market.regime,
            confidence: market.regimeConfidence,
            actionable: market.regimeActionable,
          },
          // Whether the regime prior favoured this pairing, so a later reader
          // can tell a confirmation from a deliberate challenge.
          suitedToRegime: suited,
        });
      }
    }
  }
  return candidates;
}

/**
 * A Decision Engine execution plan as an experiment seed.
 *
 * The plans are already `symbol + interval + direction` — the shape of a
 * backtest question — and until now they were scored, displayed, and fed
 * nothing. This turns them into research input.
 *
 * The plan's DIRECTION is deliberately dropped. A backtest asks "does this
 * strategy work on this pair?", not "was this one long correct?", and carrying
 * a single directional call into a replay would answer a question nobody asked.
 * The plan contributes the pair and the timeframe; the strategy comes from the
 * registry, as it does for every other candidate.
 */
function experimentsFromDecisionPlans(candidates, { timeframes = ["1h"], strategies = null, regimeBySymbol = {} } = {}) {
  const markets = (candidates || [])
    .filter((row) => row && row.symbol)
    .map((row) => {
      const read = regimeBySymbol[String(row.symbol).toUpperCase()] || {};
      return {
        symbol: String(row.symbol).toUpperCase(),
        regime: read.regime || "UNKNOWN",
        regimeConfidence: read.confidence ?? 0,
        regimeActionable: read.actionable ?? false,
        origin: "decision-engine",
      };
    });

  // Everything is generated for a decision-engine seed: the plan is evidence
  // the pair is interesting, not evidence about which strategy suits it.
  return generateExperiments(markets, { timeframes, strategies, includeMismatched: true });
}

/**
 * The whole first stage, end to end: discover pairs, read their environments,
 * and produce the candidates those two facts justify.
 */
async function planResearch(screener, {
  interval = "1h",
  limit = 5,
  timeframes = ["1h"],
  symbols = null,
  strategies = null,
  includeMismatched = false,
} = {}) {
  const discovery = await discoverMarkets(screener, { interval, limit, symbols });
  const withRegimes = await discoverRegimes(screener, discovery.markets, { interval });
  const candidates = generateExperiments(withRegimes, { timeframes, strategies, includeMismatched });

  return {
    generatedAt: new Date().toISOString(),
    interval,
    timeframes,
    scanned: discovery.scanned,
    unavailable: discovery.unavailable,
    markets: withRegimes,
    candidates,
  };
}

module.exports = {
  discoverMarkets,
  discoverRegimes,
  generateExperiments,
  experimentsFromDecisionPlans,
  planResearch,
  suitsRegime,
  backtestableStrategies,
};
