// Geometric (non-ML) chart-pattern scanner: pulls OHLCV candles from
// Binance's public REST API (free, no key) and detects bull/bear flags and
// rising/falling wedges via pivot detection + trendline regression, the same
// approach a "starter Python scanner" would use — ported to JS so this app
// stays single-runtime instead of adding a Python process/dependency chain.
//
// This is a scanner, not a signal generator: it flags geometric candidates
// for a human (or a further confirmation layer — breakout candle, volume,
// higher-timeframe trend, invalidation level) to evaluate, not something to
// trade on directly.
// api.binance.com geo-blocks several regions (HTTP 451) on its trading API,
// including US-hosted servers. data-api.binance.vision is Binance's own
// public-data-only mirror — no auth, market data only, not geo-restricted —
// meant for exactly this read-only use case.
const BINANCE_KLINES_URL = "https://data-api.binance.vision/api/v3/klines";

const { rsi } = require("./signal-screener");

// Our preset intervals (shared with the AI Analysis page) use TradingView's
// spelling; Binance's klines endpoint wants its own enum.
const BINANCE_INTERVAL = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1D": "1d",
  "1W": "1w",
  "1M": "1M",
};

// Every Binance-tradeable preset symbol is scanned across all of these, so
// a setup forming on one timeframe isn't missed just because the preset's
// display interval is another.
const SCAN_INTERVALS = ["1h", "4h", "1D"];

const DEFAULTS = {
  window: 36,
  impulseWindow: 20,
  pivotOrder: 3,
  minR2: 0.35,
  impulseMin: 0.04,
  breakoutBuffer: 0.002,
  rsiLen: 14,
  // Ignore divergences whose second pivot is older than this many bars —
  // a divergence that resolved 30 bars ago is history, not a setup.
  divergenceMaxAge: 12,
  // Minimum RSI-points and price-percent separation between the two pivots,
  // so near-equal pivots don't read as divergence.
  divergenceMinRsiDelta: 1.5,
  divergenceMinPriceDeltaPct: 0.1,
};

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const [x, y] of points) {
    const predicted = slope * x + intercept;
    ssRes += (y - predicted) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

// A candle is a pivot high/low if its high/low is the extreme within `order`
// bars on each side — the standard "fractal" pivot definition.
function findPivots(candles, order) {
  const highs = [];
  const lows = [];
  for (let i = order; i < candles.length - order; i++) {
    const windowSlice = candles.slice(i - order, i + order + 1);
    const isHigh = windowSlice.every((c) => c.high <= candles[i].high);
    const isLow = windowSlice.every((c) => c.low >= candles[i].low);
    if (isHigh) highs.push([i, candles[i].high]);
    if (isLow) lows.push([i, candles[i].low]);
  }
  return { highs, lows };
}

function priceAt(line, x) {
  return line.slope * x + line.intercept;
}

/**
 * Classifies the geometry of the last `window` candles into a wedge, a flag,
 * or no pattern. Returns null when there isn't enough pivot data to fit both
 * trendlines with an acceptable R^2.
 */
function classifyWindow(candles, opts) {
  const { highs, lows } = findPivots(candles, opts.pivotOrder);
  if (highs.length < 3 || lows.length < 3) return null;

  const upper = linearRegression(highs);
  const lower = linearRegression(lows);
  if (!upper || !lower) return null;
  if (upper.r2 < opts.minR2 || lower.r2 < opts.minR2) return null;

  const firstX = 0;
  const lastX = candles.length - 1;
  const startWidth = priceAt(upper, firstX) - priceAt(lower, firstX);
  const endWidth = priceAt(upper, lastX) - priceAt(lower, lastX);
  if (startWidth <= 0 || endWidth <= 0) return null;
  const widthRatio = endWidth / startWidth;
  const isCompressing = widthRatio < 0.85;

  const lastClose = candles[candles.length - 1].close;
  const upperNow = priceAt(upper, lastX);
  const lowerNow = priceAt(lower, lastX);
  const breakoutUp = lastClose > upperNow * (1 + opts.breakoutBuffer);
  const breakoutDown = lastClose < lowerNow * (1 - opts.breakoutBuffer);
  const status = breakoutUp || breakoutDown ? "breakout" : "forming";

  const preWindowStart = Math.max(0, candles.length - opts.window - opts.impulseWindow);
  const impulseCandles = candles.slice(preWindowStart, candles.length - opts.window);
  const impulseReturn = impulseCandles.length
    ? (impulseCandles[impulseCandles.length - 1].close - impulseCandles[0].close) / impulseCandles[0].close
    : 0;

  const consolidationVolume = avg(candles.map((c) => c.volume));
  const impulseVolume = impulseCandles.length ? avg(impulseCandles.map((c) => c.volume)) : consolidationVolume;
  const volumeRatio = impulseVolume > 0 ? consolidationVolume / impulseVolume : 1;

  const r2 = Math.min(upper.r2, lower.r2);

  // Wedges: both trendlines slope the same direction and converge.
  if (upper.slope > 0 && lower.slope > 0 && lower.slope > upper.slope && isCompressing) {
    return build("Rising Wedge", "bearish", status, r2, widthRatio, impulseReturn, volumeRatio);
  }
  if (upper.slope < 0 && lower.slope < 0 && Math.abs(upper.slope) > Math.abs(lower.slope) && isCompressing) {
    return build("Falling Wedge", "bullish", status, r2, widthRatio, impulseReturn, volumeRatio);
  }

  // Flags: a strong directional pole, then a roughly parallel, opposite (or
  // sideways) consolidation channel.
  const isParallel = Math.abs(upper.slope - lower.slope) < Math.abs(upper.slope + lower.slope || 1) * 0.6 + 1e-9;
  if (impulseReturn >= opts.impulseMin && upper.slope <= 0 && lower.slope <= 0 && isParallel) {
    return build("Bull Flag", "bullish", status, r2, widthRatio, impulseReturn, volumeRatio);
  }
  if (impulseReturn <= -opts.impulseMin && upper.slope >= 0 && lower.slope >= 0 && isParallel) {
    return build("Bear Flag", "bearish", status, r2, widthRatio, impulseReturn, volumeRatio);
  }

  return null;
}

function avg(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

/**
 * RSI divergence against price, using the same fractal pivots as the
 * pattern detector. Compares the last two pivot lows (bullish variants) and
 * the last two pivot highs (bearish variants):
 *   price LL + RSI HL -> Regular Bullish   (reversal warning in a downtrend)
 *   price HL + RSI LL -> Hidden Bullish    (continuation signal in an uptrend)
 *   price HH + RSI LH -> Regular Bearish   (reversal warning in an uptrend)
 *   price LH + RSI HH -> Hidden Bearish    (continuation signal in a downtrend)
 * Returns the freshest qualifying divergence, or null.
 */
function detectDivergence(candles, opts) {
  const closes = candles.map((c) => c.close);
  const rsiSeries = rsi(closes, opts.rsiLen);
  const { highs, lows } = findPivots(candles, opts.pivotOrder);
  const lastIndex = candles.length - 1;
  const candidates = [];

  function compare(pivots, kind) {
    if (pivots.length < 2) return;
    const [i1, p1] = pivots[pivots.length - 2];
    const [i2, p2] = pivots[pivots.length - 1];
    const r1 = rsiSeries[i1];
    const r2 = rsiSeries[i2];
    if (r1 == null || r2 == null) return;
    const barsAgo = lastIndex - i2;
    if (barsAgo > opts.divergenceMaxAge) return;
    const priceDeltaPct = ((p2 - p1) / p1) * 100;
    const rsiDelta = r2 - r1;
    if (Math.abs(priceDeltaPct) < opts.divergenceMinPriceDeltaPct) return;
    if (Math.abs(rsiDelta) < opts.divergenceMinRsiDelta) return;

    let type = null;
    if (kind === "low" && priceDeltaPct < 0 && rsiDelta > 0) type = "Regular Bullish";
    if (kind === "low" && priceDeltaPct > 0 && rsiDelta < 0) type = "Hidden Bullish";
    if (kind === "high" && priceDeltaPct > 0 && rsiDelta < 0) type = "Regular Bearish";
    if (kind === "high" && priceDeltaPct < 0 && rsiDelta > 0) type = "Hidden Bearish";
    if (!type) return;

    candidates.push({
      type,
      bias: type.endsWith("Bullish") ? "bullish" : "bearish",
      indicator: "RSI",
      priceDeltaPct: Number(priceDeltaPct.toFixed(2)),
      rsiDelta: Number(rsiDelta.toFixed(1)),
      barsAgo,
    });
  }

  compare(lows, "low");
  compare(highs, "high");
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.barsAgo - b.barsAgo);
  return candidates[0];
}

function build(pattern, bias, status, r2, widthRatio, impulseReturn, volumeRatio) {
  // Simple composite score, 0-100: fit quality, compression, impulse
  // strength, and a declining-volume-into-consolidation bonus all push it up.
  const compressionScore = Math.max(0, 1 - widthRatio) * 100;
  const impulseScore = Math.min(1, Math.abs(impulseReturn) / 0.1) * 100;
  const volumeScore = volumeRatio < 1 ? (1 - volumeRatio) * 100 : 0;
  const score = Math.round(r2 * 40 + compressionScore * 0.25 + impulseScore * 0.2 + volumeScore * 0.15);
  return {
    pattern,
    bias,
    status,
    score: Math.max(0, Math.min(100, score)),
    widthRatio: Number(widthRatio.toFixed(3)),
    impulseReturnPct: Number((impulseReturn * 100).toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
  };
}

class PatternScannerService {
  constructor({ cache, cacheMs, tokens, options } = {}) {
    this._cache = cache;
    this._cacheMs = cacheMs || 5 * 60 * 1000;
    this._tokens = tokens || [];
    this._options = { ...DEFAULTS, ...(options || {}) };
  }

  async _fetchKlines(pair, binanceInterval) {
    // The extra rsiLen covers RSI warm-up so divergence pivots near the start
    // of the pattern window still have valid RSI values to compare.
    const limit = this._options.window + this._options.impulseWindow + this._options.pivotOrder * 2 + this._options.rsiLen + 5;
    const url = `${BINANCE_KLINES_URL}?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(binanceInterval)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance klines HTTP ${res.status} for ${pair} ${binanceInterval}`);
    }
    const rows = await res.json();
    return rows.map((row) => ({
      openTime: row[0],
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }

  /**
   * Scans one Binance spot pair (e.g. "BTCUSDT") on one interval for both a
   * flag/wedge pattern and an RSI divergence.
   */
  async scanToken(pair, interval, { force } = {}) {
    const label = pair.replace(/USDT$/, "");
    const binanceInterval = BINANCE_INTERVAL[interval];
    if (!binanceInterval) {
      return { symbol: pair, label, interval, pattern: null, divergence: null, error: `Unsupported interval "${interval}"` };
    }
    const key = `pattern-scan:${pair}:${binanceInterval}`;
    const load = async () => {
      const candles = await this._fetchKlines(pair, binanceInterval);
      const windowed = candles.slice(-this._options.window);
      const detection = classifyWindow(windowed, this._options);
      const divergence = detectDivergence(candles, this._options);
      return { detection, divergence, scannedAt: new Date().toISOString(), candleCount: candles.length };
    };
    try {
      const result = force ? await this._cache.set(key, await load(), this._cacheMs) : await this._cache.getOrLoad(key, this._cacheMs, load);
      return { symbol: pair, label, interval, pattern: result.detection, divergence: result.divergence, scannedAt: result.scannedAt };
    } catch (err) {
      return { symbol: pair, label, interval, pattern: null, divergence: null, error: err.message };
    }
  }

  get scanIntervals() {
    return SCAN_INTERVALS;
  }

  async scanAll({ force } = {}) {
    const jobs = [];
    for (const pair of this._tokens) {
      for (const interval of SCAN_INTERVALS) {
        jobs.push(this.scanToken(pair, interval, { force }));
      }
    }
    return Promise.all(jobs);
  }
}

module.exports = { PatternScannerService, classifyWindow, detectDivergence, findPivots, linearRegression, SCAN_INTERVALS };
