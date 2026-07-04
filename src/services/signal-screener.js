// Ports the "Razor Phantom Screener" Pine Script's multi-check confluence
// signal (RSI / MACD / VWAP / volume / EMA20-50 / EMA200 vs price) to JS
// against Binance spot klines, since our capture pipeline is spot-only —
// the original script watches Binance USDT-margined perpetuals (the ".P"
// suffix), which need Binance's separate futures API and aren't wired up
// here. Spot price action for the same pairs is a close proxy.
const BINANCE_KLINES_URL = "https://data-api.binance.vision/api/v3/klines";

const INTERVAL_MAP = { "1h": "1h", "4h": "4h", "1D": "1d" };

// Spot equivalents of the screener's 20 USDT-perpetual tokens.
const DEFAULT_TOKENS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT",
  "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT", "ADAUSDT",
  "DOTUSDT", "NEARUSDT", "INJUSDT", "OPUSDT", "ARBUSDT",
  "PENDLEUSDT", "WIFUSDT", "FETUSDT", "PEPEUSDT", "LTCUSDT",
];

function sma(values, length, endIndex) {
  let sum = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

// Standard EMA, seeded with an SMA over the first `length` values.
function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  let prev = sma(values, length, length - 1);
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, length) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < length + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= length;
  avgLoss /= length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fastLen, slowLen, signalLen) {
  const fast = ema(closes, fastLen);
  const slow = ema(closes, slowLen);
  const macdLine = closes.map((_, i) => (fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null));
  const firstValid = macdLine.findIndex((v) => v != null);
  const compact = macdLine.slice(firstValid).map((v) => v ?? 0);
  const signalCompact = ema(compact, signalLen);
  const signalLine = new Array(closes.length).fill(null);
  for (let i = 0; i < signalCompact.length; i++) {
    if (signalCompact[i] != null) signalLine[firstValid + i] = signalCompact[i];
  }
  return { macdLine, signalLine };
}

// Anchored VWAP, resetting at each UTC day boundary (TradingView's default
// session anchor) rather than a true exchange session calendar.
function vwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  let currentDay = null;
  for (let i = 0; i < candles.length; i++) {
    const day = Math.floor(candles[i].openTime / 86400000);
    if (day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumV = 0;
    }
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumPV += typical * candles[i].volume;
    cumV += candles[i].volume;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

function adxSeries(candles, length) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }
  function wilderSmooth(values) {
    const out = new Array(n).fill(null);
    if (n <= length) return out;
    let sum = 0;
    for (let i = 1; i <= length; i++) sum += values[i];
    out[length] = sum;
    for (let i = length + 1; i < n; i++) {
      out[i] = out[i - 1] - out[i - 1] / length + values[i];
    }
    return out;
  }
  const smPlusDM = wilderSmooth(plusDM);
  const smMinusDM = wilderSmooth(minusDM);
  const smTR = wilderSmooth(tr);
  const dx = new Array(n).fill(null);
  for (let i = length; i < n; i++) {
    if (!smTR[i]) continue;
    const plusDI = (100 * smPlusDM[i]) / smTR[i];
    const minusDI = (100 * smMinusDM[i]) / smTR[i];
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }
  const adx = new Array(n).fill(null);
  const firstDx = dx.findIndex((v) => v != null);
  if (firstDx === -1 || firstDx + length > n) return adx;
  adx[firstDx + length - 1] = sma(dx, length, firstDx + length - 1);
  for (let i = firstDx + length; i < n; i++) {
    adx[i] = (adx[i - 1] * (length - 1) + dx[i]) / length;
  }
  return adx;
}

class SignalScreenerService {
  constructor({ cache, cacheMs, tokens, options } = {}) {
    this._cache = cache;
    this._cacheMs = cacheMs || 5 * 60 * 1000;
    this._tokens = tokens && tokens.length ? tokens : DEFAULT_TOKENS;
    this._options = {
      rsiLen: 14,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      adxLen: 14,
      volLen: 20,
      minChecks: 4,
      ...(options || {}),
    };
  }

  async _fetchKlines(symbol, binanceInterval) {
    const url = `${BINANCE_KLINES_URL}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(binanceInterval)}&limit=500`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance klines HTTP ${res.status} for ${symbol} ${binanceInterval}`);
    }
    const rows = await res.json();
    return rows.map((row) => ({
      openTime: row[0],
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }

  _computeSignal(candles, minChecks) {
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const last = candles.length - 1;

    const rsiSeries = rsi(closes, this._options.rsiLen);
    const { macdLine, signalLine } = macd(closes, this._options.macdFast, this._options.macdSlow, this._options.macdSignal);
    const vwap = vwapSeries(candles);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const ema200 = ema(closes, 200);
    const adx = adxSeries(candles, this._options.adxLen);
    const volSma = last >= this._options.volLen - 1 ? sma(volumes, this._options.volLen, last) : null;

    const r = rsiSeries[last];
    const macdBullish = macdLine[last] != null && signalLine[last] != null ? macdLine[last] > signalLine[last] : null;
    const aboveVwap = vwap[last] != null ? closes[last] > vwap[last] : null;
    const volAbove = volSma != null ? volumes[last] > volSma : null;
    const trendBullish = ema20[last] != null && ema50[last] != null ? ema20[last] > ema50[last] : null;
    const htfBullish = ema200[last] != null ? closes[last] > ema200[last] : null;

    if ([r, macdBullish, aboveVwap, volAbove, trendBullish, htfBullish].some((v) => v == null)) {
      return { error: "Not enough candle history for a stable signal yet" };
    }

    const bull = (r > 50 ? 1 : 0) + (macdBullish ? 1 : 0) + (aboveVwap ? 1 : 0) + (volAbove ? 1 : 0) + (trendBullish ? 1 : 0) + (htfBullish ? 1 : 0);
    const bear = (r < 50 ? 1 : 0) + (!macdBullish ? 1 : 0) + (!aboveVwap ? 1 : 0) + (volAbove ? 1 : 0) + (!trendBullish ? 1 : 0) + (!htfBullish ? 1 : 0);
    const isLong = bull >= minChecks && bull > bear;
    const isShort = bear >= minChecks && bear > bull;
    const signal = isLong ? "LONG" : isShort ? "SHORT" : "FLAT";
    const score = isLong ? Math.round((bull / 6) * 100) : isShort ? Math.round((bear / 6) * 100) : 50;

    return {
      signal,
      score,
      rsi: Number(r.toFixed(1)),
      adx: adx[last] != null ? Number(adx[last].toFixed(1)) : null,
      price: closes[last],
    };
  }

  async scanToken(symbol, interval, minChecks, { force } = {}) {
    const binanceInterval = INTERVAL_MAP[interval];
    if (!binanceInterval) return { symbol, error: `Unsupported interval "${interval}"` };
    const resolvedMinChecks = minChecks ?? this._options.minChecks;
    const key = `signal-screener:${symbol}:${binanceInterval}:${resolvedMinChecks}`;
    const load = async () => {
      const candles = await this._fetchKlines(symbol, binanceInterval);
      return this._computeSignal(candles, resolvedMinChecks);
    };
    try {
      const result = force ? await this._cache.set(key, await load(), this._cacheMs) : await this._cache.getOrLoad(key, this._cacheMs, load);
      return { symbol, ...result };
    } catch (err) {
      return { symbol, error: err.message };
    }
  }

  async scanAll(interval, minChecks, { force } = {}) {
    return Promise.all(this._tokens.map((symbol) => this.scanToken(symbol, interval, minChecks, { force })));
  }
}

module.exports = { SignalScreenerService, DEFAULT_TOKENS, rsi, ema, macd, vwapSeries, adxSeries };
