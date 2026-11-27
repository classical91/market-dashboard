"use strict";

// Offline walk-forward backtest for the Pattern Scanner.
//
// The live scanner (src/services/pattern-scanner.js) runs one fixed DEFAULTS
// set on every symbol and timeframe. A 4% "impulse" is a big move for BTC on
// 1h and noise for a meme coin on 1D, so this script measures how the current
// defaults actually score per pattern / timeframe / symbol, and compares them
// with variants whose impulseMin and breakoutBuffer scale with ATR. It only
// produces evidence: it never changes the live defaults.
//
//   node scripts/pattern-backtest.js [options]
//
//   --symbols BTCUSDT,ETHUSDT,...   Binance spot pairs (default: a BTC + alt mix)
//   --intervals 1h,4h,1D            timeframes (default: the live SCAN_INTERVALS)
//   --days 1h=730,4h=1460,1D=2920   history per timeframe, in days
//   --split 0.7                     in-sample share per series (tune), rest is out-of-sample
//   --min-samples 30                cells below this are flagged inconclusive
//   --out docs/pattern-backtest-report.md
//   --cache-dir data/pattern-backtest/klines
//   --events-json <file>            also dump every scored event
//   --offline                       use the kline cache only, never the network
//   --refresh                       ignore the cache and refetch everything
//
// Fidelity to the live pipeline:
// - Each bar sees exactly the closed-candle slice the live scanner would have
//   had at that bar's close (its kline request size minus the dropped open
//   candle), and nothing after it.
// - Events are what signal-bot.js logs into pattern-tracker.js: a pattern on
//   the bar its breakout crosses the trendline, and a divergence the first
//   time its second pivot is newer than the last one seen for that type.
// - Scoring copies pattern-tracker.js: entry at the detection close, exit at
//   the close exactly one horizon after it (24h / 4d / 10d), +/-2% hit /
//   miss / flat, hit rate = hits / (hits + misses). MFE/MAE use candle
//   highs/lows over the horizon, clamped to >= 0 / <= 0. An event whose
//   horizon candle is missing from the data stays unscored, as the tracker
//   would leave it pending.

const fs = require("fs");
const path = require("path");

const { classifyWindow, detectDivergence, DEFAULTS, SCAN_INTERVALS } = require("../src/services/pattern-scanner");
const { MOVE_THRESHOLD_PCT, RESOLVE_HORIZON_MS } = require("../src/services/pattern-tracker");

const BINANCE_KLINES_URL = "https://data-api.binance.vision/api/v3/klines";
const BINANCE_INTERVAL = { "1h": "1h", "4h": "4h", "1D": "1d" };
const INTERVAL_MS = { "1h": 3_600_000, "4h": 14_400_000, "1D": 86_400_000 };
const DAY_MS = 86_400_000;

const DEFAULT_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
  "AVAXUSDT", "LINKUSDT", "INJUSDT", "WIFUSDT", "PEPEUSDT",
];
const DEFAULT_DAYS = { "1h": 730, "4h": 1460, "1D": 2920 };
const ATR_LENGTH = 14;

// ATR multiples for the variant grid. "fixed" keeps the live constant for
// that parameter, so the grid also shows each scaling on its own.
const IMPULSE_K = ["fixed", 2, 3, 4, 6, 8];
const BUFFER_K = ["fixed", 0.1, 0.25, 0.5];

// The live scanner requests this many klines, then drops the still-open one,
// so its detectors see one less closed candle than it asks for.
function liveLookback(opts = DEFAULTS) {
  const limit = opts.window + opts.impulseWindow + opts.pivotOrder * 2 + opts.rsiLen + 5;
  return limit - 1;
}

// Wilder ATR. Each value depends only on bars at or before its index.
function atrSeries(candles, length = ATR_LENGTH) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= length) return out;
  const tr = candles.map((c, i) => (i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  let atr = 0;
  for (let i = 1; i <= length; i++) atr += tr[i];
  atr /= length;
  out[length] = atr;
  for (let i = length + 1; i < candles.length; i++) {
    atr = (atr * (length - 1) + tr[i]) / length;
    out[i] = atr;
  }
  return out;
}

function makeVariants({ impulseK = IMPULSE_K, bufferK = BUFFER_K } = {}) {
  const variants = [{ id: "default", paramsAt: null }];
  for (const imp of impulseK) {
    for (const buf of bufferK) {
      if (imp === "fixed" && buf === "fixed") continue;
      variants.push({
        id: `atr imp=${imp === "fixed" ? "fixed" : `${imp}x`} buf=${buf === "fixed" ? "fixed" : `${buf}x`}`,
        impulseK: imp,
        bufferK: buf,
        paramsAt: ({ atrPct }) => {
          if (!Number.isFinite(atrPct) || atrPct <= 0) return null;
          const params = {};
          if (imp !== "fixed") params.impulseMin = imp * atrPct;
          if (buf !== "fixed") params.breakoutBuffer = buf * atrPct;
          return params;
        },
      });
    }
  }
  return variants;
}

// Fails loudly if the slice handed to the detectors at bar t contains
// anything other than the closed bars [t - lookback + 1, t] in order.
function assertNoLookahead(view, candles, t, lookback) {
  if (view.length !== lookback) throw new Error(`look-ahead guard: view at ${t} has ${view.length} bars, expected ${lookback}`);
  if (view[view.length - 1] !== candles[t]) throw new Error(`look-ahead guard: view at ${t} does not end on bar ${t}`);
  for (let i = 1; i < view.length; i++) {
    if (!(view[i].openTime > view[i - 1].openTime)) throw new Error(`look-ahead guard: bars out of order at ${t}`);
  }
}

/**
 * Walks a closed-candle series bar by bar and returns the detection events
 * the live bot would have logged. Each variant only changes classifyWindow
 * options; divergence uses the base options and is variant-independent.
 */
function walkForward(candles, { opts = DEFAULTS, variants = [{ id: "default", paramsAt: null }], divergence = true, guard = true } = {}) {
  const lookback = liveLookback(opts);
  const needsAtr = variants.some((v) => v.paramsAt);
  const atr = needsAtr ? atrSeries(candles) : null;
  const divState = {};
  const events = [];
  const checks = { bars: 0, viewsChecked: 0, pivotsChecked: 0 };

  for (let t = lookback - 1; t < candles.length; t++) {
    const start = t - lookback + 1;
    const view = candles.slice(start, t + 1);
    if (guard) {
      assertNoLookahead(view, candles, t, lookback);
      checks.viewsChecked += 1;
    }
    checks.bars += 1;
    const windowed = view.slice(-opts.window);
    const impulse = view.slice(-opts.window - opts.impulseWindow, -opts.window);
    const atrPct = atr && atr[t] != null ? atr[t] / candles[t].close : null;

    for (const variant of variants) {
      let variantOpts = opts;
      if (variant.paramsAt) {
        const params = variant.paramsAt({ t, atrPct });
        if (!params) continue;
        variantOpts = { ...opts, ...params };
      }
      const detection = classifyWindow(windowed, variantOpts, impulse);
      if (detection && detection.breakoutCrossed) {
        events.push({
          kind: "breakout",
          variant: variant.id,
          name: detection.pattern,
          bias: detection.bias,
          index: t,
          atrPct,
        });
      }
    }

    if (divergence) {
      const found = detectDivergence(view, opts);
      if (found) {
        const pivotIndex = start + found.pivots[1].index;
        if (guard) {
          // A fractal pivot needs pivotOrder bars on its right, so the second
          // pivot can be at most bar t - pivotOrder when it is first reported.
          if (pivotIndex > t - opts.pivotOrder) {
            throw new Error(`look-ahead guard: pivot ${pivotIndex} reported at ${t}, before ${opts.pivotOrder} confirming bars`);
          }
          checks.pivotsChecked += 1;
        }
        const pivotTime = candles[pivotIndex].openTime;
        const prior = divState[found.type];
        if (prior == null || pivotTime > prior) {
          divState[found.type] = pivotTime;
          events.push({
            kind: "divergence",
            variant: null,
            name: found.type,
            bias: found.bias,
            index: t,
            pivotIndex,
            atrPct,
          });
        }
      }
    }
  }
  return { events, checks };
}

// Index of the bar whose close the tracker reads at resolve time: the bar
// that closes exactly at detection close + horizon. -1 while the series
// doesn't reach that far, or when that candle is missing from the data (the
// tracker leaves such an entry pending rather than score a different close).
function resolveIndex(candles, index, interval) {
  const horizonMs = RESOLVE_HORIZON_MS[interval];
  if (!horizonMs) throw new Error(`No tracker horizon for interval "${interval}"`);
  const resolveAt = candles[index].closeTime + horizonMs;
  if (candles[candles.length - 1].closeTime < resolveAt) return -1;
  let j = index;
  while (j + 1 < candles.length && candles[j + 1].closeTime <= resolveAt) j++;
  return j > index && candles[j].closeTime === resolveAt ? j : -1;
}

function scoreEvent(candles, event, interval) {
  const exitIndex = resolveIndex(candles, event.index, interval);
  if (exitIndex < 0) return null;
  const entry = candles[event.index].close;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let k = event.index + 1; k <= exitIndex; k++) {
    if (candles[k].high > maxHigh) maxHigh = candles[k].high;
    if (candles[k].low < minLow) minLow = candles[k].low;
  }
  const exit = candles[exitIndex].close;
  const returnPct = (exit - entry) / entry;
  const bullish = event.bias === "bullish";
  const dirReturn = bullish ? returnPct : -returnPct;
  // Clamped like the tracker: MFE >= 0, MAE <= 0, in the call's direction.
  const mfe = Math.max(bullish ? (maxHigh - entry) / entry : (entry - minLow) / entry, 0);
  const mae = Math.min(bullish ? (minLow - entry) / entry : (entry - maxHigh) / entry, 0);
  const outcome = dirReturn >= MOVE_THRESHOLD_PCT ? "hit" : dirReturn <= -MOVE_THRESHOLD_PCT ? "miss" : "flat";
  return { ...event, exitIndex, entry, exit, returnPct, dirReturn, mfe, mae, outcome };
}

// Unconditional forward returns from every bar the walk visits, the drift a
// pattern has to beat to mean anything.
function baselineSamples(candles, interval, fromIndex) {
  const out = [];
  for (let i = fromIndex; i < candles.length; i++) {
    const scored = scoreEvent(candles, { index: i, bias: "bullish" }, interval);
    if (!scored) break;
    out.push(scored);
  }
  return out;
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(list) {
  const hits = list.filter((e) => e.outcome === "hit").length;
  const misses = list.filter((e) => e.outcome === "miss").length;
  const flats = list.length - hits - misses;
  const decisive = hits + misses;
  return {
    n: list.length,
    hits,
    misses,
    flats,
    hitRate: decisive ? hits / decisive : null,
    flatShare: list.length ? flats / list.length : null,
    avgDirReturn: mean(list.map((e) => e.dirReturn)),
    avgMfe: mean(list.map((e) => e.mfe)),
    avgMae: mean(list.map((e) => e.mae)),
  };
}

// Picks the ATR variant with the best in-sample average directional return,
// among those with at least minSamples in-sample events.
function selectVariant(inSampleByVariant, minSamples) {
  let best = null;
  for (const [id, list] of Object.entries(inSampleByVariant)) {
    if (id === "default" || list.length < minSamples) continue;
    const avg = mean(list.map((e) => e.dirReturn));
    if (!best || avg > best.avg) best = { id, avg, n: list.length };
  }
  return best;
}

function groupBy(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

/* ---------------------------------------------------------------- data -- */

function toCandle(row) {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  };
}

async function fetchJsonWithRetry(url, fetchImpl, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      lastError = err; // network error or timeout: retry
    }
    if (res) {
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      // Rate limits (429/418) and server errors are worth retrying; a bad
      // symbol or parameter (other 4xx) is not.
      if (res.status !== 429 && res.status !== 418 && res.status < 500) throw lastError;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw lastError;
}

async function fetchKlinesRange({ symbol, interval, startTime, endTime, fetchImpl = fetch }) {
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const url = `${BINANCE_KLINES_URL}?symbol=${encodeURIComponent(symbol)}&interval=${BINANCE_INTERVAL[interval]}`
      + `&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const page = await fetchJsonWithRetry(url, fetchImpl);
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    cursor = Number(page[page.length - 1][0]) + 1;
    if (page.length < 1000) break;
  }
  return rows;
}

/**
 * Loads closed candles for one series, from the on-disk cache where it
 * covers the requested range and from Binance for the rest.
 */
async function loadCandles({ symbol, interval, days, cacheDir, offline = false, refresh = false, now = Date.now(), fetchImpl = fetch, log = () => {} }) {
  const file = path.join(cacheDir, `${symbol}-${BINANCE_INTERVAL[interval]}.json`);
  let cache = null;
  if (!refresh && fs.existsSync(file)) {
    try {
      cache = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      cache = null;
    }
  }
  if (offline) {
    if (!cache) throw new Error(`--offline: no cached klines for ${symbol} ${interval} at ${file}`);
    // Measure the window from when the cache was fetched, so offline reruns
    // reproduce the same bars instead of sliding with the clock.
    const fetchedAt = Date.parse(cache.fetchedAt);
    if (Number.isFinite(fetchedAt)) now = fetchedAt;
  }
  const desiredStart = Math.floor((now - days * DAY_MS) / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
  if (!offline) {
    let rows = cache ? cache.rows : [];
    let requestedStart = cache ? cache.requestedStart : desiredStart;
    if (!cache) {
      log(`fetch ${symbol} ${interval} (${days}d)`);
      rows = await fetchKlinesRange({ symbol, interval, startTime: desiredStart, endTime: now, fetchImpl });
    } else {
      if (cache.requestedStart > desiredStart) {
        const firstOpen = rows.length ? rows[0][0] : now;
        log(`fetch ${symbol} ${interval} head`);
        rows = (await fetchKlinesRange({ symbol, interval, startTime: desiredStart, endTime: firstOpen - 1, fetchImpl })).concat(rows);
        requestedStart = desiredStart;
      }
      const lastOpen = rows.length ? rows[rows.length - 1][0] : desiredStart - 1;
      const tail = (await fetchKlinesRange({ symbol, interval, startTime: lastOpen + 1, endTime: now, fetchImpl }))
        .filter((row) => Number(row[6]) < now);
      if (tail.length) log(`fetch ${symbol} ${interval} +${tail.length} closed bars`);
      rows = rows.concat(tail);
    }
    // Only closed candles are cached; the live bar would change under us.
    const seen = new Set();
    rows = rows
      .filter((row) => Number(row[6]) < now)
      .filter((row) => (seen.has(row[0]) ? false : (seen.add(row[0]), true)))
      .sort((a, b) => a[0] - b[0]);
    cache = { symbol, interval, requestedStart, fetchedAt: new Date(now).toISOString(), rows };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  }
  return cache.rows
    .filter((row) => Number(row[0]) >= desiredStart && Number(row[6]) < now)
    .map(toCandle);
}

/* ------------------------------------------------------------ backtest -- */

/**
 * Runs the full study on already-loaded series and returns everything the
 * report needs. `series` is [{ symbol, interval, candles }].
 */
function runStudy(series, { variants = makeVariants(), split = 0.7, minSamples = 30, opts = DEFAULTS } = {}) {
  const scored = [];
  const baseline = [];
  const seriesInfo = [];
  const checks = { bars: 0, viewsChecked: 0, pivotsChecked: 0 };
  const lookback = liveLookback(opts);

  for (const { symbol, interval, candles } of series) {
    if (candles.length < lookback + 2) {
      seriesInfo.push({ symbol, interval, bars: candles.length, skipped: true });
      continue;
    }
    const splitIndex = Math.floor(candles.length * split);
    const { events, checks: c } = walkForward(candles, { opts, variants });
    checks.bars += c.bars;
    checks.viewsChecked += c.viewsChecked;
    checks.pivotsChecked += c.pivotsChecked;
    for (const event of events) {
      const s = scoreEvent(candles, event, interval);
      if (s) scored.push({ ...s, symbol, interval, sample: s.index >= splitIndex ? "oos" : (s.exitIndex < splitIndex ? "is" : "purged") });
    }
    for (const b of baselineSamples(candles, interval, lookback - 1)) {
      baseline.push({ ...b, symbol, interval, sample: b.index >= splitIndex ? "oos" : (b.exitIndex < splitIndex ? "is" : "purged") });
    }
    const atr = atrSeries(candles);
    const atrPcts = atr.map((a, i) => (a == null ? null : a / candles[i].close)).filter((v) => v != null);
    seriesInfo.push({
      symbol,
      interval,
      bars: candles.length,
      from: candles[0].openTime,
      to: candles[candles.length - 1].closeTime,
      splitTime: candles[splitIndex].openTime,
      medianAtrPct: median(atrPcts),
    });
  }

  const breakouts = scored.filter((e) => e.kind === "breakout");
  const divergences = scored.filter((e) => e.kind === "divergence");
  const intervals = [...new Set(series.map((s) => s.interval))];
  const selected = {};
  for (const interval of intervals) {
    const inSample = breakouts.filter((e) => e.interval === interval && e.sample === "is");
    const byVariant = Object.fromEntries(variants.map((v) => [v.id, []]));
    for (const e of inSample) byVariant[e.variant].push(e);
    selected[interval] = selectVariant(byVariant, minSamples);
  }
  return { scored, breakouts, divergences, baseline, seriesInfo, selected, checks, variants, split, minSamples, intervals, opts };
}

/* -------------------------------------------------------------- report -- */

function pct(value, digits = 2) {
  return value == null || !Number.isFinite(value) ? "–" : `${(value * 100).toFixed(digits)}%`;
}

function statCells(list, minSamples) {
  const s = summarize(list);
  const n = s.n < minSamples ? `${s.n} ⚠` : String(s.n);
  return [n, pct(s.hitRate, 1), pct(s.flatShare, 0), pct(s.avgDirReturn), pct(s.avgMfe), pct(s.avgMae)];
}

const STAT_HEAD = ["n", "Hit rate", "Flat", "Avg dir. return", "Avg MFE", "Avg MAE"];

function table(head, rows) {
  if (!rows.length) return "_No samples._\n";
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function intervalOrder(a, b) {
  return SCAN_INTERVALS.indexOf(a) - SCAN_INTERVALS.indexOf(b);
}

function buildReport(study, { generatedAt = new Date() } = {}) {
  const { breakouts, divergences, baseline, seriesInfo, selected, checks, variants, split, minSamples, opts } = study;
  const intervals = study.intervals.slice().sort(intervalOrder);
  const symbols = [...new Set(seriesInfo.map((s) => s.symbol))];
  const patterns = ["Bull Flag", "Bear Flag", "Rising Wedge", "Falling Wedge"];
  const divTypes = ["Regular Bullish", "Hidden Bullish", "Regular Bearish", "Hidden Bearish"];
  const oos = (list) => list.filter((e) => e.sample === "oos");
  const ins = (list) => list.filter((e) => e.sample === "is");
  const ofVariant = (list, id) => list.filter((e) => e.variant === id);
  const tunedId = (interval) => selected[interval]?.id || null;
  const out = [];
  const push = (text = "") => out.push(text);

  push("# Pattern Scanner backtest");
  push();
  push(`Generated ${generatedAt.toISOString()} by \`node scripts/pattern-backtest.js\`. Evidence only: the live \`DEFAULTS\` in \`src/services/pattern-scanner.js\` are unchanged.`);
  push();
  push("## Method");
  push();
  push(`- **Data:** Binance spot klines (\`data-api.binance.vision\`), closed candles only. ${symbols.length} symbols × ${intervals.join(" / ")}.`);
  push(`- **Walk-forward:** at every bar the detectors get the same ${liveLookback(opts)} closed candles the live scanner would have had at that close, and nothing later. Pattern window ${opts.window}, impulse window ${opts.impulseWindow}, pivot order ${opts.pivotOrder}, minR2 ${opts.minR2}.`);
  push(`- **Look-ahead checks:** ${checks.viewsChecked.toLocaleString("en-US")} bar views were checked to end on the current bar with ${liveLookback(opts)} ordered bars, and ${checks.pivotsChecked.toLocaleString("en-US")} divergence detections were checked to have a second pivot at least ${opts.pivotOrder} bars old (fully confirmed). None failed. The unit tests also check that changing future bars never changes past events.`);
  push("- **Events:** what `signal-bot.js` logs into the pattern tracker: a flag/wedge on the bar its close first crosses the trendline (`breakoutCrossed`), scored in the breakout direction; an RSI divergence the first time its second pivot is newer than the last one seen for that type.");
  push(`- **Scoring:** same as \`pattern-tracker.js\`. Entry at the detection close; exit at the candle closing exactly ${Object.entries(RESOLVE_HORIZON_MS).map(([k, v]) => `${v / 3_600_000}h after (${k})`).join(", ")}; hit ≥ +${MOVE_THRESHOLD_PCT * 100}%, miss ≤ −${MOVE_THRESHOLD_PCT * 100}% in the bias direction, otherwise flat. **Hit rate = hits / (hits + misses)**, as on the tracker page. MFE/MAE come from candle highs and lows over the horizon, signed in the bias direction and clamped at 0. An event whose horizon candle is missing from the data is left unscored, as the tracker leaves it pending.`);
  push(`- **Variants:** \`default\` is the live set (impulseMin ${opts.impulseMin}, breakoutBuffer ${opts.breakoutBuffer}). ATR variants set impulseMin = k × ATR${ATR_LENGTH}% and/or breakoutBuffer = k × ATR${ATR_LENGTH}% at each bar; \`fixed\` keeps that one parameter at its live value. Divergence ignores both parameters, so it has no variants.`);
  push(`- **Out-of-sample:** each series is split by bar at ${Math.round(split * 100)}%. The ATR variant is picked per timeframe (all symbols pooled) by the best in-sample average directional return with at least ${minSamples} in-sample events. In-sample events must also resolve before the split. All tables report the last ${Math.round((1 - split) * 100)}% unless they say otherwise.`);
  push(`- **Caveats:** cells marked ⚠ have fewer than ${minSamples} samples and are **inconclusive**. Events close together share forward bars, so samples are not independent and the effective sample size is lower than \`n\`. No fees or slippage.`);
  push();

  push("## Data coverage");
  push();
  push(table(["Symbol", "TF", "Bars", "From", "To", "OOS from", "Median ATR%", "4% impulse in ATRs", "0.2% buffer in ATRs"],
    seriesInfo.slice().sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol) || intervalOrder(a.interval, b.interval)).map((s) => (s.skipped
      ? [s.symbol, s.interval, String(s.bars), "–", "–", "–", "–", "–", "skipped: too short"]
      : [s.symbol, s.interval, String(s.bars), fmtDate(s.from), fmtDate(s.to), fmtDate(s.splitTime), pct(s.medianAtrPct),
        (opts.impulseMin / s.medianAtrPct).toFixed(1), (opts.breakoutBuffer / s.medianAtrPct).toFixed(2)]))));
  push("A fixed threshold means a different thing on every row: the last two columns show the live impulseMin and breakoutBuffer in units of each series' median ATR.");
  push();

  push("## Headline: defaults vs tuned ATR variant (out-of-sample)");
  push();
  const headRows = [];
  for (const interval of intervals) {
    const tf = oos(breakouts.filter((e) => e.interval === interval));
    headRows.push([interval, "default", ...statCells(ofVariant(tf, "default"), minSamples)]);
    if (tunedId(interval)) headRows.push([interval, `tuned: ${tunedId(interval)}`, ...statCells(ofVariant(tf, tunedId(interval)), minSamples)]);
    else headRows.push([interval, "tuned: none qualified", "–", "–", "–", "–", "–", "–"]);
    const base = oos(baseline.filter((e) => e.interval === interval));
    headRows.push([interval, "baseline: long every bar", ...statCells(base, minSamples)]);
    headRows.push([interval, "divergence (all types)", ...statCells(oos(divergences.filter((e) => e.interval === interval)), minSamples)]);
  }
  push(table(["TF", "Set", ...STAT_HEAD], headRows));
  for (const interval of intervals) {
    const isDefault = summarize(ins(ofVariant(breakouts.filter((e) => e.interval === interval), "default")));
    const pick = selected[interval];
    push(pick
      ? `- **${interval}:** selected \`${pick.id}\` on in-sample avg ${pct(pick.avg)} (n ${pick.n}) vs default ${pct(isDefault.avgDirReturn)} (n ${isDefault.n})${pick.avg <= isDefault.avgDirReturn ? ": **no ATR variant beat the defaults in-sample**" : ""}.`
      : `- **${interval}:** no ATR variant had ${minSamples} in-sample events.`);
  }
  push();
  push("Breakout rows pool every pattern and symbol. The baseline is the forward return from going long at every bar. Short-side drift is its negative, so a pattern needs to beat it in its own direction to show an edge.");
  push();

  push("## Variant grid (in-sample → out-of-sample)");
  push();
  for (const interval of intervals) {
    const tf = breakouts.filter((e) => e.interval === interval);
    push(`### ${interval}`);
    push();
    const rows = variants.map((v) => {
      const is = summarize(ins(ofVariant(tf, v.id)));
      const os = summarize(oos(ofVariant(tf, v.id)));
      const mark = v.id === tunedId(interval) ? " **← selected**" : "";
      const n = (k) => (k < minSamples ? `${k} ⚠` : String(k));
      return [`${v.id}${mark}`, n(is.n), pct(is.hitRate, 1), pct(is.avgDirReturn), n(os.n), pct(os.hitRate, 1), pct(os.avgDirReturn), pct(os.avgMfe), pct(os.avgMae)];
    });
    push(table(["Variant", "IS n", "IS hit", "IS avg", "OOS n", "OOS hit", "OOS avg", "OOS MFE", "OOS MAE"], rows));
  }
  push("The selection uses only the IS columns. The OOS columns for variants that were not selected are shown for transparency; picking the best of them afterwards would bring back the overfitting the split exists to avoid.");
  push();

  push("## By pattern × timeframe (out-of-sample)");
  push();
  push("A pattern can break either way (a Bull Flag can break down), and the event is scored in the breakout direction, so each pattern is split by breakout direction.");
  push();
  const patRows = [];
  for (const interval of intervals) {
    for (const pattern of patterns) {
      for (const bias of ["bullish", "bearish"]) {
        const cell = oos(breakouts.filter((e) => e.interval === interval && e.name === pattern && e.bias === bias));
        const label = `${pattern} ${bias === "bullish" ? "↑" : "↓"}`;
        patRows.push([interval, label, "default", ...statCells(ofVariant(cell, "default"), minSamples)]);
        if (tunedId(interval)) patRows.push([interval, label, "tuned", ...statCells(ofVariant(cell, tunedId(interval)), minSamples)]);
      }
    }
  }
  push(table(["TF", "Pattern / breakout", "Set", ...STAT_HEAD], patRows));

  push("## By symbol × timeframe, all patterns (out-of-sample)");
  push();
  const symRows = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      const cell = oos(breakouts.filter((e) => e.interval === interval && e.symbol === symbol));
      symRows.push([symbol, interval, "default", ...statCells(ofVariant(cell, "default"), minSamples)]);
      if (tunedId(interval)) symRows.push([symbol, interval, "tuned", ...statCells(ofVariant(cell, tunedId(interval)), minSamples)]);
    }
  }
  push(table(["Symbol", "TF", "Set", ...STAT_HEAD], symRows));

  push("## RSI divergence (out-of-sample)");
  push();
  const divRows = [];
  for (const interval of intervals) {
    for (const type of divTypes) {
      divRows.push([interval, type, ...statCells(oos(divergences.filter((e) => e.interval === interval && e.name === type)), minSamples)]);
    }
  }
  push(table(["TF", "Type", ...STAT_HEAD], divRows));
  const divSymRows = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      divSymRows.push([symbol, interval, ...statCells(oos(divergences.filter((e) => e.interval === interval && e.symbol === symbol)), minSamples)]);
    }
  }
  push("### By symbol × timeframe, all divergence types");
  push();
  push(table(["Symbol", "TF", ...STAT_HEAD], divSymRows));

  push("## Appendix: full period, live defaults, by pattern × timeframe × symbol");
  push();
  push("Covers all bars (in-sample + out-of-sample), so nothing here was tuned. Use it for sample sizes, not as an out-of-sample result.");
  push();
  const appRows = [];
  const defaults = ofVariant(breakouts, "default");
  const grouped = groupBy(defaults, (e) => `${e.interval}|${e.name}|${e.symbol}`);
  for (const interval of intervals) {
    for (const pattern of patterns) {
      for (const symbol of symbols) {
        const cell = grouped.get(`${interval}|${pattern}|${symbol}`) || [];
        appRows.push([interval, pattern, symbol, ...statCells(cell, minSamples)]);
      }
    }
  }
  push(table(["TF", "Pattern", "Symbol", ...STAT_HEAD], appRows));
  return out.join("\n");
}

/* ----------------------------------------------------------------- cli -- */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inline] = token.slice(2).split(/=(.*)/s);
    if (inline !== undefined) args[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

function parseDays(value) {
  const days = { ...DEFAULT_DAYS };
  if (typeof value !== "string") return days;
  for (const part of value.split(",")) {
    const [interval, n] = part.split("=");
    if (!INTERVAL_MS[interval] || !(Number(n) > 0)) throw new Error(`Bad --days entry "${part}"`);
    days[interval] = Number(n);
  }
  return days;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, "..");
  const symbols = typeof args.symbols === "string" ? args.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_SYMBOLS;
  const intervals = typeof args.intervals === "string" ? args.intervals.split(",").map((s) => s.trim()) : SCAN_INTERVALS;
  for (const interval of intervals) if (!BINANCE_INTERVAL[interval]) throw new Error(`Unsupported interval "${interval}"`);
  const days = parseDays(args.days);
  const split = args.split ? Number(args.split) : 0.7;
  if (!(split > 0 && split < 1)) throw new Error("--split must be between 0 and 1");
  const minSamples = args["min-samples"] ? Number(args["min-samples"]) : 30;
  const cacheDir = path.resolve(root, typeof args["cache-dir"] === "string" ? args["cache-dir"] : "data/pattern-backtest/klines");
  const outFile = path.resolve(root, typeof args.out === "string" ? args.out : "docs/pattern-backtest-report.md");
  const log = (msg) => console.error(`[pattern-backtest] ${msg}`);

  const now = Date.now();
  const series = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      try {
        const candles = await loadCandles({
          symbol, interval, days: days[interval], cacheDir, offline: Boolean(args.offline), refresh: Boolean(args.refresh), now, log,
        });
        series.push({ symbol, interval, candles });
      } catch (err) {
        log(`skip ${symbol} ${interval}: ${err.message}`);
      }
    }
  }
  if (!series.length) throw new Error("No series loaded");

  log(`walking ${series.length} series...`);
  const started = Date.now();
  const study = runStudy(series, { split, minSamples });
  log(`walk done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${study.scored.length} scored events`);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buildReport(study));
  log(`report written to ${path.relative(root, outFile)}`);
  if (typeof args["events-json"] === "string") {
    const eventsFile = path.resolve(root, args["events-json"]);
    fs.writeFileSync(eventsFile, JSON.stringify(study.scored));
    log(`events written to ${path.relative(root, eventsFile)}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[pattern-backtest] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  liveLookback,
  atrSeries,
  makeVariants,
  walkForward,
  resolveIndex,
  scoreEvent,
  baselineSamples,
  summarize,
  selectVariant,
  loadCandles,
  fetchKlinesRange,
  runStudy,
  buildReport,
  parseArgs,
};
