// Decision engine: turns the dashboard's raw market feeds into a trading
// decision layer — "what environment am I in, and which setup has the best
// risk-adjusted odds right now?"
//
// Four modules, composed by getDecision():
//   1. Regime score  — BTC, crypto breadth, SPY, QQQ, DXY, VIX, gold, oil and
//      (when the macro feed carries it) US10Y voted together into one
//      Risk-On / Risk-Off / Defensive / Volatile / Choppy / Trend Mode label,
//      instead of the overview's crypto-only average.
//   2. Rotation board — where money is flowing across asset classes, with
//      per-class strength thresholds (a 0.5% DXY move matters as much as a
//      3% crypto move).
//   3. Setup quality — a second scoring layer over the signal screener's
//      confluence output: regime alignment + trend strength (ADX) + news
//      risk, producing a ranked 0–100 score and an action.
//   4. Execution plans — trigger / invalidation / target / RR levels from
//      recent swing structure and ATR, plus explicit "do not trade" reasons.
//
// Everything degrades gracefully: components are only voted when their feed
// has data, and dataQuality reports which inputs were live vs fallback.

const { dropUnclosedCandle } = require("./signal-screener");

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// Normalize a % change into a -1..+1 vote, saturating at `scale` percent.
function vote(changePercent, scale) {
  const n = Number(changePercent);
  if (!Number.isFinite(n)) return 0;
  return clamp(n / scale, -1, 1);
}

function findRow(rows, symbol) {
  return (rows || []).find((row) => row && row.symbol === symbol) || null;
}

function avgChange(rows) {
  const values = (rows || [])
    .map((row) => Number(row?.changePercent))
    .filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function round1(value) {
  return Number((Number(value) || 0).toFixed(1));
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function formatPercent(value) {
  const n = Number(value || 0);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// 1. Regime score
// ---------------------------------------------------------------------------

// Each component votes -1..+1 on risk appetite; weights reflect how much a
// multi-asset trader leans on each input. Only components whose feed returned
// a row are voted, so a missing macro board narrows — not breaks — the score.
function buildRegime({ crypto = [], equities = [], macro = [] } = {}) {
  const components = [];
  const add = (name, symbol, weight, voteValue, detail) => {
    components.push({
      name,
      symbol,
      weight,
      vote: round2(voteValue),
      detail,
    });
  };

  const btc = findRow(crypto, "BTC");
  if (btc) add("Bitcoin", "BTC", 2, vote(btc.changePercent, 4), `${formatPercent(btc.changePercent)} 24h`);

  const breadth = avgChange(crypto);
  if (breadth != null && crypto.length > 1) {
    add("Crypto breadth", "AVG", 1, vote(breadth, 3), `${formatPercent(breadth)} avg across ${crypto.length} majors`);
  }

  const spy = findRow(equities, "SPY");
  if (spy) add("S&P 500", "SPY", 2, vote(spy.changePercent, 1.5), `${formatPercent(spy.changePercent)}`);

  const qqq = findRow(equities, "QQQ");
  if (qqq) add("Nasdaq 100", "QQQ", 1.5, vote(qqq.changePercent, 2), `${formatPercent(qqq.changePercent)}`);

  const dxy = findRow(macro, "DXY");
  if (dxy) {
    // Dollar strength drains risk assets — invert the vote.
    add("Dollar (DXY)", "DXY", 1.5, vote(-dxy.changePercent, 0.6), `${formatPercent(dxy.changePercent)} — strong USD pressures risk`);
  }

  const vix = findRow(macro, "VIX");
  let vixLevel = null;
  if (vix) {
    const changeVote = vote(-(vix.changePercent || 0), 8);
    let combined = changeVote;
    let detail = `${formatPercent(vix.changePercent)} change`;
    if (!vix.proxy && Number(vix.price) > 0) {
      // A real VIX level is more informative than its daily change: calm
      // (<18) supports risk, stressed (>26) kills it.
      vixLevel = Number(vix.price);
      const levelVote = clamp((18 - vixLevel) / 8, -1, 1);
      combined = (levelVote + changeVote) / 2;
      detail = `level ${vixLevel.toFixed(1)}, ${formatPercent(vix.changePercent)} change`;
    }
    add("Volatility (VIX)", "VIX", 2, combined, detail);
  }

  const gold = findRow(macro, "XAU");
  if (gold) {
    // A strong gold bid is a defensive rotation, mildly risk-negative.
    add("Gold", "XAU", 1, vote(-gold.changePercent, 1.5), `${formatPercent(gold.changePercent)} — gold bid = defensive flow`);
  }

  const oil = findRow(macro, "WTI");
  if (oil) {
    add("Oil (WTI)", "WTI", 0.75, vote(-oil.changePercent, 3), `${formatPercent(oil.changePercent)} — energy/inflation pressure`);
  }

  const yields = findRow(macro, "US10Y") || findRow(macro, "TNX");
  if (yields) {
    add("US 10Y yield", yields.symbol, 1.5, vote(-yields.changePercent, 2), `${formatPercent(yields.changePercent)} — rising yields pressure risk`);
  }

  if (!components.length) {
    return {
      label: "Unknown",
      score: 50,
      weighted: 0,
      volatility: "Unknown",
      modifiers: [],
      components: [],
      inputsUsed: 0,
      summary: "No regime inputs available.",
    };
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const weighted = components.reduce((sum, c) => sum + c.vote * c.weight, 0) / totalWeight;
  const score = Math.round(clamp(50 + weighted * 50, 0, 100));

  // Volatility read: real VIX level when available, otherwise the size of the
  // largest crypto move stands in.
  const maxAbsCrypto = crypto.reduce((max, row) => Math.max(max, Math.abs(Number(row?.changePercent) || 0)), 0);
  const absVixChange = vix ? Math.abs(Number(vix.changePercent) || 0) : 0;
  const volatile = (vixLevel != null && vixLevel >= 24) || maxAbsCrypto >= 6 || absVixChange >= 8;
  const elevated = (vixLevel != null && vixLevel >= 18) || maxAbsCrypto >= 2.5 || absVixChange >= 4;
  const volatility = volatile ? "High" : elevated ? "Moderate" : "Low";

  // Agreement: are the inputs that have an opinion pointing the same way?
  const significant = components.filter((c) => Math.abs(c.vote) >= 0.25);
  const aligned = significant.filter((c) => c.vote * weighted > 0);
  const agreement = significant.length ? aligned.length / significant.length : 0;
  const trending = Math.abs(weighted) >= 0.35 && significant.length >= 3 && agreement >= 0.7;
  const choppy = Math.abs(weighted) < 0.15 || (significant.length >= 2 && agreement <= 0.5);

  // Defensive: gold catching a bid while equities soften, without a full
  // risk-off score yet.
  const equityAvg = avgChange(equities);
  const defensive =
    gold != null &&
    Number(gold.changePercent) >= 0.4 &&
    equityAvg != null &&
    equityAvg <= -0.15;

  let label;
  if (score >= 62) label = "Risk-On";
  else if (score <= 38) label = "Risk-Off";
  else if (defensive) label = "Defensive";
  else if (volatile) label = "Volatile";
  else if (trending) label = "Trend Mode";
  else label = "Choppy";

  const modifiers = [];
  if (volatile && label !== "Volatile") modifiers.push("Volatile");
  if (trending && label !== "Trend Mode") modifiers.push("Trend Mode");
  if (choppy && label !== "Choppy" && !trending) modifiers.push("Choppy");

  const leanText = weighted > 0.05 ? "lean risk-on" : weighted < -0.05 ? "lean risk-off" : "are mixed";
  const summary =
    `Regime score ${score}/100 — ${label}. ` +
    `${aligned.length} of ${significant.length || components.length} active inputs ${leanText}; ` +
    `volatility ${volatility.toLowerCase()}${vixLevel != null ? ` (VIX ${vixLevel.toFixed(1)})` : ""}.`;

  return { label, score, weighted: round2(weighted), volatility, modifiers, components, inputsUsed: components.length, summary };
}

// ---------------------------------------------------------------------------
// 2. Rotation board
// ---------------------------------------------------------------------------

// Per-class move thresholds (in % change) — asset classes trade on very
// different daily ranges, so "strong" must be scaled per class.
const ROTATION_THRESHOLDS = {
  Crypto: { strong: 3, medium: 1.2, flat: 0.4 },
  Stocks: { strong: 1.2, medium: 0.5, flat: 0.15 },
  USD: { strong: 0.5, medium: 0.2, flat: 0.08 },
  Gold: { strong: 1.2, medium: 0.5, flat: 0.15 },
  Oil: { strong: 2, medium: 0.8, flat: 0.3 },
  "Bonds/Yields": { strong: 4, medium: 1.5, flat: 0.5 },
};

function rotationRow(assetClass, symbol, changePercent, note) {
  const thresholds = ROTATION_THRESHOLDS[assetClass];
  if (changePercent == null || !Number.isFinite(Number(changePercent))) {
    return { assetClass, symbol, changePercent: null, direction: "No data", strength: "-", momentum: 0, note: note || "" };
  }
  const change = Number(changePercent);
  const abs = Math.abs(change);
  const direction = abs < thresholds.flat ? "Flat" : change > 0 ? "Up" : "Down";
  const strength = abs >= thresholds.strong ? "Strong" : abs >= thresholds.medium ? "Medium" : "Weak";
  // Momentum normalizes the move against the class's own "strong" bar so
  // classes can be compared head-to-head for the leader call.
  const momentum = round2(change / thresholds.strong);
  return { assetClass, symbol, changePercent: round2(change), direction, strength, momentum, note: note || "" };
}

function buildRotation({ crypto = [], equities = [], macro = [] } = {}) {
  const btc = findRow(crypto, "BTC");
  const cryptoAvg = avgChange(crypto);
  const stocksAvg = avgChange([findRow(equities, "SPY"), findRow(equities, "QQQ")].filter(Boolean));
  const dxy = findRow(macro, "DXY");
  const gold = findRow(macro, "XAU");
  const oil = findRow(macro, "WTI");
  const yields = findRow(macro, "US10Y") || findRow(macro, "TNX");

  const rows = [
    rotationRow(
      "Crypto",
      "BTC+majors",
      cryptoAvg,
      btc ? `BTC ${formatPercent(btc.changePercent)}, breadth ${formatPercent(cryptoAvg || 0)}` : "",
    ),
    rotationRow("Stocks", "SPY/QQQ", stocksAvg, ""),
    rotationRow("USD", "DXY", dxy?.changePercent ?? null, dxy ? "Strong USD pressures risk assets" : ""),
    rotationRow("Gold", "XAU", gold?.changePercent ?? null, gold ? "Defensive / inflation hedge" : ""),
    rotationRow("Oil", "WTI", oil?.changePercent ?? null, oil ? "Energy & inflation pulse" : ""),
    yields
      ? {
          ...rotationRow("Bonds/Yields", yields.symbol, yields.changePercent),
          direction: Number(yields.changePercent) > 0 ? "Yields Up" : Number(yields.changePercent) < 0 ? "Yields Down" : "Flat",
          note: Number(yields.changePercent) > 0 ? "Risk pressure" : "Risk support",
        }
      : rotationRow("Bonds/Yields", "US10Y", null, "Add US10Y to MACRO_SYMBOLS or MACRO_DATA_URL for live yields"),
  ];

  const withData = rows.filter((row) => row.changePercent != null);
  const leader = withData.length
    ? withData.reduce((best, row) => (Math.abs(row.momentum) > Math.abs(best.momentum) ? row : best))
    : null;

  const summary = leader
    ? `Strongest flow: ${leader.assetClass} (${leader.direction.toLowerCase()}, ${String(leader.strength).toLowerCase()}).`
    : "No rotation data available.";

  return { rows, leader: leader ? leader.assetClass : null, summary };
}

// ---------------------------------------------------------------------------
// News risk from the macro calendar
// ---------------------------------------------------------------------------

// Calendar rows carry loose "HH:MM"-style labels rather than full timestamps,
// so this is deliberately conservative: an unparseable time on a high-impact
// event still counts as "events today" (medium), never silently low.
function assessNewsRisk(calendarItems = [], now = new Date()) {
  const highImpact = (calendarItems || []).filter((item) => item && item.impact === "High");
  if (!highImpact.length) {
    return { level: "low", reason: "No high-impact events on today's calendar.", nextHighImpact: null };
  }

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let imminent = null;
  let next = null;
  let nextMinutes = Infinity;
  for (const item of highImpact) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(item.time || ""));
    if (!match) continue;
    const eventMinutes = Number(match[1]) * 60 + Number(match[2]);
    const delta = eventMinutes - nowMinutes;
    // Inside the pre-event chop window or the immediate post-release whipsaw.
    if (delta >= -15 && delta <= 45 && !imminent) imminent = { ...item, minutesUntil: delta };
    if (delta > 45 && eventMinutes < nextMinutes) {
      next = item;
      nextMinutes = eventMinutes;
    }
  }

  if (imminent) {
    const when = imminent.minutesUntil >= 0 ? `in ${imminent.minutesUntil} min` : `${-imminent.minutesUntil} min ago`;
    return {
      level: "high",
      reason: `${imminent.title} ${when} (${imminent.time}).`,
      nextHighImpact: { time: imminent.time, title: imminent.title },
    };
  }

  const upcoming = next || highImpact[0];
  return {
    level: "medium",
    reason: `${highImpact.length} high-impact event${highImpact.length > 1 ? "s" : ""} today — next: ${upcoming.title} (${upcoming.time}).`,
    nextHighImpact: { time: upcoming.time, title: upcoming.title },
  };
}

// ---------------------------------------------------------------------------
// 3. Setup quality score
// ---------------------------------------------------------------------------

const NEWS_SAFETY = { low: 90, medium: 55, high: 10 };

function scoreSetup({ signal, screenerScore, adx, regime, newsRisk }) {
  if (signal !== "LONG" && signal !== "SHORT") {
    return { setupScore: null, action: "No setup", components: null };
  }

  let alignment = signal === "LONG" ? regime.score : 100 - regime.score;
  // A choppy or volatile regime shouldn't hand out directional credit either
  // way — pull the alignment component toward neutral.
  if (regime.label === "Choppy" || regime.label === "Volatile" || regime.modifiers?.includes("Choppy")) {
    alignment = 50 + (alignment - 50) * 0.5;
  }

  const trend = adx == null ? 50 : clamp(adx * 2.5, 0, 100);
  const newsSafety = NEWS_SAFETY[newsRisk?.level] ?? 55;
  const confluence = clamp(Number(screenerScore) || 0, 0, 100);

  const setupScore = Math.round(0.45 * confluence + 0.25 * alignment + 0.15 * trend + 0.15 * newsSafety);

  let action;
  if (newsRisk?.level === "high") action = "Stand down — news window";
  else if (setupScore >= 75) action = "Ready — watch for entry";
  else if (setupScore >= 60) action = "Watch";
  else if (setupScore >= 45) action = "Low edge";
  else action = "Skip";

  return {
    setupScore,
    action,
    components: {
      confluence: Math.round(confluence),
      regimeAlignment: Math.round(alignment),
      trendStrength: Math.round(trend),
      newsSafety,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Execution plans
// ---------------------------------------------------------------------------

// Wilder ATR over closed candles.
function atr(candles, length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }
  let value = trs.slice(0, length).reduce((sum, tr) => sum + tr, 0) / length;
  for (let i = length; i < trs.length; i++) {
    value = (value * (length - 1) + trs[i]) / length;
  }
  return value;
}

// Round a level to a precision that matches the instrument's price magnitude.
function roundPrice(value, price) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ref = Math.abs(Number(price) || n);
  const digits = ref >= 1000 ? 1 : ref >= 100 ? 2 : ref >= 1 ? 4 : 6;
  return Number(n.toFixed(digits));
}

function buildPlan({ symbol, signal, candles, price, regime, newsRisk, lookback = 20, atrLen = 14 }) {
  const closed = dropUnclosedCandle(candles || []);
  if (signal !== "LONG" && signal !== "SHORT") return null;
  if (closed.length < Math.max(lookback, atrLen + 1)) {
    return { symbol, signal, error: "Not enough candle history for levels" };
  }

  const recent = closed.slice(-lookback);
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const range = swingHigh - swingLow;
  const atrValue = atr(closed, atrLen);
  const last = Number(price) || closed[closed.length - 1].close;

  let trigger;
  let invalidation;
  let target;
  if (signal === "LONG") {
    trigger = swingHigh;
    // Structure stop at the swing low, but never further than 2.5 ATR from
    // the trigger — a huge range would otherwise make the position untradeable.
    invalidation = atrValue != null && trigger - swingLow > 2.5 * atrValue ? trigger - 1.5 * atrValue : swingLow;
    const risk = trigger - invalidation;
    target = trigger + Math.max(range, 1.5 * risk);
  } else {
    trigger = swingLow;
    invalidation = atrValue != null && swingHigh - trigger > 2.5 * atrValue ? trigger + 1.5 * atrValue : swingHigh;
    const risk = invalidation - trigger;
    target = trigger - Math.max(range, 1.5 * risk);
  }

  const risk = Math.abs(trigger - invalidation);
  const reward = Math.abs(target - trigger);
  const rr = risk > 0 ? round2(reward / risk) : null;

  const atrPercent = atrValue != null && last > 0 ? (atrValue / last) * 100 : null;
  const riskLabel = atrPercent == null ? "Unknown" : atrPercent < 1.5 ? "Low" : atrPercent < 3.5 ? "Medium" : "High";

  const doNotTrade = [];
  if (newsRisk?.level === "high") doNotTrade.push(`High-impact event window: ${newsRisk.reason}`);
  else if (newsRisk?.level === "medium" && newsRisk.nextHighImpact) {
    doNotTrade.push(`Check calendar first — ${newsRisk.nextHighImpact.title} at ${newsRisk.nextHighImpact.time}`);
  }
  if (signal === "LONG" && regime && regime.score <= 42) doNotTrade.push("Long signal conflicts with a risk-off regime");
  if (signal === "SHORT" && regime && regime.score >= 58) doNotTrade.push("Short signal conflicts with a risk-on regime");
  if (regime && (regime.label === "Volatile" || regime.modifiers?.includes("Volatile"))) {
    doNotTrade.push("Volatile regime — reduce size or skip");
  }
  if (rr != null && rr < 1.5) doNotTrade.push("Risk/reward below 1.5 at the marked levels");

  return {
    symbol,
    signal,
    bias: signal === "LONG" ? "Long" : "Short",
    price: roundPrice(last, last),
    trigger: roundPrice(trigger, last),
    invalidation: roundPrice(invalidation, last),
    target: roundPrice(target, last),
    riskReward: rr,
    atr: roundPrice(atrValue, last),
    atrPercent: atrPercent != null ? round2(atrPercent) : null,
    riskLabel,
    doNotTrade,
    tradeable: doNotTrade.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const VALID_INTERVALS = ["1h", "4h", "1D"];

class DecisionEngineService {
  constructor({ marketDataService, signalScreenerService, cache, cacheTtlMs, maxPlans } = {}) {
    this.marketDataService = marketDataService;
    this.signalScreenerService = signalScreenerService;
    this.cache = cache;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? cacheTtlMs : 120_000;
    this.maxPlans = Number.isFinite(maxPlans) ? maxPlans : 6;
  }

  async getDecision(rawInterval) {
    const interval = VALID_INTERVALS.includes(rawInterval) ? rawInterval : "4h";
    return this.cache.getOrLoad(`decision:${interval}`, this.cacheTtlMs, () => this.buildPayload(interval));
  }

  async buildPayload(interval) {
    const [cryptoResult, equitiesResult, macroResult, calendarResult, screenResult] = await Promise.all([
      safe(() => this.marketDataService.getCryptoPrices()),
      safe(() => this.marketDataService.getEquities()),
      safe(() => this.marketDataService.getMacro()),
      safe(() => this.marketDataService.getCalendar()),
      safe(() => this.signalScreenerService.scanAll(interval)),
    ]);

    const crypto = unwrap(cryptoResult, { live: false, items: [] });
    const equities = unwrap(equitiesResult, { live: false, items: [] });
    const macro = unwrap(macroResult, { live: false, items: [] });
    const calendar = unwrap(calendarResult, { live: false, items: [] });
    const screenRows = Array.isArray(screenResult.value) ? screenResult.value : [];

    const regime = buildRegime({ crypto: crypto.items, equities: equities.items, macro: macro.items });
    const rotation = buildRotation({ crypto: crypto.items, equities: equities.items, macro: macro.items });
    const newsRisk = assessNewsRisk(calendar.items);

    const setups = screenRows
      .map((row) => {
        if (row.error) return { symbol: row.symbol, error: row.error };
        const quality = scoreSetup({
          signal: row.signal,
          screenerScore: row.score,
          adx: row.adx,
          regime,
          newsRisk,
        });
        return {
          symbol: row.symbol,
          signal: row.signal,
          price: row.price,
          screenerScore: row.score,
          rsi: row.rsi,
          adx: row.adx,
          ...quality,
        };
      })
      .sort((a, b) => (b.setupScore ?? -1) - (a.setupScore ?? -1));

    // Execution plans only for the highest-quality directional setups —
    // each needs its own candle fetch, so keep the fan-out bounded.
    const planCandidates = setups
      .filter((row) => !row.error && (row.signal === "LONG" || row.signal === "SHORT"))
      .slice(0, this.maxPlans);
    const execution = (
      await Promise.all(
        planCandidates.map(async (row) => {
          try {
            const candles = await this.signalScreenerService.getCandles(row.symbol, interval);
            const plan = buildPlan({
              symbol: row.symbol,
              signal: row.signal,
              candles,
              price: row.price,
              regime,
              newsRisk,
            });
            return plan ? { ...plan, setupScore: row.setupScore, action: row.action } : null;
          } catch (err) {
            return { symbol: row.symbol, signal: row.signal, error: err.message };
          }
        }),
      )
    ).filter(Boolean);

    const screenErrors = screenRows.filter((row) => row.error).length;
    return {
      status: "ok",
      updatedAt: new Date().toISOString(),
      interval,
      regime,
      rotation,
      newsRisk,
      setups,
      execution,
      dataQuality: {
        modules: {
          crypto: crypto.live ? "live" : crypto.stale ? "delayed" : "fallback",
          equities: equities.live ? "live" : "fallback",
          macro: macro.live ? "live" : macro.stale ? "delayed" : "fallback",
          calendar: calendar.live ? "live" : "fallback",
          signals: screenErrors === 0 ? "live" : screenErrors < screenRows.length ? "partial" : "unavailable",
        },
        warnings: [
          ...(crypto.live || crypto.stale ? [] : ["Crypto prices using fallback data — regime score is degraded"]),
          ...(equities.live ? [] : ["Equities using fallback data — regime score is degraded"]),
          ...(macro.live || macro.stale ? [] : ["Macro board using fallback data — regime score is degraded"]),
          ...(calendar.live ? [] : ["Calendar using fallback data — news risk may be inaccurate"]),
          ...(screenErrors ? [`${screenErrors} screener symbols failed to scan`] : []),
        ],
      },
    };
  }
}

function safe(fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error }));
}

function unwrap(result, fallback) {
  if (result.error || !result.value) return fallback;
  return result.value;
}

module.exports = {
  DecisionEngineService,
  buildRegime,
  buildRotation,
  assessNewsRisk,
  scoreSetup,
  buildPlan,
  atr,
};
