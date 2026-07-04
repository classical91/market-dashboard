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
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";

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

const DEFAULTS = {
  window: 36,
  impulseWindow: 20,
  pivotOrder: 3,
  minR2: 0.35,
  impulseMin: 0.04,
  breakoutBuffer: 0.002,
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
  constructor({ cache, cacheMs, options } = {}) {
    this._cache = cache;
    this._cacheMs = cacheMs || 5 * 60 * 1000;
    this._options = { ...DEFAULTS, ...(options || {}) };
  }

  async _fetchKlines(pair, binanceInterval) {
    const limit = this._options.window + this._options.impulseWindow + this._options.pivotOrder * 2 + 5;
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
   * Scans one symbol/interval preset. `preset.symbol` is TradingView-style
   * (e.g. "BINANCE:BTCUSDT"); only Binance-tradeable pairs are supported —
   * dominance/macro presets (CRYPTOCAP:, TVC:, etc.) have no Binance data
   * and are filtered out by the caller before this is reached.
   */
  async scanPreset(preset, { force } = {}) {
    const pair = preset.symbol.replace(/^BINANCE:/, "");
    const binanceInterval = BINANCE_INTERVAL[preset.interval];
    if (!binanceInterval) {
      return { ...preset, pattern: null, error: `Unsupported interval "${preset.interval}"` };
    }
    const key = `pattern-scan:${pair}:${binanceInterval}`;
    const load = async () => {
      const candles = await this._fetchKlines(pair, binanceInterval);
      const windowed = candles.slice(-this._options.window);
      const detection = classifyWindow(windowed, this._options);
      return { detection, scannedAt: new Date().toISOString(), candleCount: candles.length };
    };
    try {
      const result = force ? await this._cache.set(key, await load(), this._cacheMs) : await this._cache.getOrLoad(key, this._cacheMs, load);
      return { ...preset, pattern: result.detection, scannedAt: result.scannedAt };
    } catch (err) {
      return { ...preset, pattern: null, error: err.message };
    }
  }

  binanceSupportedPresets(presets) {
    return (presets || []).filter((p) => p.symbol.startsWith("BINANCE:") && BINANCE_INTERVAL[p.interval]);
  }

  async scanAll(presets, { force } = {}) {
    const scannable = this.binanceSupportedPresets(presets);
    return Promise.all(scannable.map((preset) => this.scanPreset(preset, { force })));
  }
}

module.exports = { PatternScannerService, classifyWindow, findPivots, linearRegression };
