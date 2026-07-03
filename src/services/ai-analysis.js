const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { resolveDataDir } = require("../utils/data-dir");

const DEFAULT_STUDIES = [
  { name: "Volume", forceOverlay: true },
  { name: "MACD" },
  { name: "Relative Strength Index" },
];

// Dominance/market-cap indices (CRYPTOCAP:*) have no volume series, so
// requesting the Volume study on them just renders an empty pane.
const INDEX_STUDIES = [{ name: "MACD" }, { name: "Relative Strength Index" }];
const NO_VOLUME_SYMBOL_PREFIXES = ["CRYPTOCAP:", "TVC:", "SP:", "CBOE:", "FX:", "OANDA:"];

const ANALYSIS_PROMPT =
  "Analyze this chart for a Telegram broadcast in 120 words max. Use short bullets only: Trend, Levels, Momentum, Risk, Final call. End exactly BUY, SELL, or HOLD. Be direct and avoid long explanations.";
const MAX_ANALYSIS_WORDS = 150;

// The last generated result for each symbol/interval is kept in the
// persistent cache indefinitely (until a fresh generation overwrites it), so
// it survives page refreshes and server restarts. `ttlMs` only controls how
// long a generation is considered "fresh enough" to skip re-generating (see
// the manual generatedAt check below) — it does not expire the display copy.
const PERSIST_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// Selectable timeframes for the per-card dropdown, roughly low-to-high.
const AVAILABLE_INTERVALS = ["15m", "1h", "4h", "1D", "1W", "1M"];

const DEFAULT_PRESETS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTCUSDT", interval: "4h" },
  { symbol: "BINANCE:ETHUSDT", label: "ETHUSDT", interval: "4h" },
  { symbol: "BINANCE:SOLUSDT", label: "SOLUSDT", interval: "4h" },
  { symbol: "CRYPTOCAP:BTC.D", label: "BTC.D", interval: "4h" },
  { symbol: "CRYPTOCAP:ETH.D", label: "ETH.D", interval: "4h" },
  { symbol: "CRYPTOCAP:USDT.D", label: "USDT.D", interval: "4h" },
  { symbol: "CRYPTOCAP:TOTAL", label: "TOTAL", interval: "4h" },
  { symbol: "TVC:DXY", label: "DXY", interval: "4h" },
  { symbol: "SP:SPX", label: "S&P 500", interval: "4h" },
  { symbol: "OANDA:XAUUSD", label: "Gold", interval: "4h" },
  { symbol: "TVC:US02Y", label: "US 2Y", interval: "4h" },
  { symbol: "CBOE:VIX", label: "VIX", interval: "4h" },
  { symbol: "FX:EURUSD", label: "EUR/USD", interval: "4h" },
];

function studiesForSymbol(symbol) {
  return NO_VOLUME_SYMBOL_PREFIXES.some((prefix) => symbol.startsWith(prefix)) ? INDEX_STUDIES : DEFAULT_STUDIES;
}

function normalizePresets(presets) {
  if (!Array.isArray(presets) || !presets.length) return DEFAULT_PRESETS;
  const normalized = presets
    .map((preset) => ({
      symbol: String(preset.symbol || "").trim(),
      label: String(preset.label || preset.symbol || "").trim(),
      interval: String(preset.interval || "4h").trim(),
    }))
    .filter((preset) => preset.symbol);
  return normalized.length ? normalized : DEFAULT_PRESETS;
}

function extractVerdict(text) {
  if (!text) return null;
  const matches = text.match(/\b(BUY|SELL|HOLD)\b/gi);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1].toUpperCase();
}

function truncateWords(text, maxWords) {
  const source = String(text || "");
  if (maxWords <= 0) return "";
  let count = 0;
  let end = 0;
  const wordPattern = /\S+/g;
  let match;
  while ((match = wordPattern.exec(source))) {
    count += 1;
    if (count === maxWords) {
      end = wordPattern.lastIndex;
      break;
    }
  }
  if (count < maxWords || !wordPattern.exec(source)) return source;
  return source.slice(0, end).trimEnd();
}

function presetKey(symbol, interval) {
  return `${symbol}::${interval}`;
}

class AIAnalysisService {
  constructor({ cache, dataDir, openaiApiKey, chartImgApiKey, chartImgBaseUrl, model, presets }) {
    this._cache = cache;
    this._chartImgApiKey = chartImgApiKey || "";
    this._chartImgBaseUrl = chartImgBaseUrl || "https://api.chart-img.com/v2/tradingview/advanced-chart/storage";
    this._client = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
    this._model = model || "gpt-5.4-mini";
    this._presets = normalizePresets(presets);
    this._logFile = path.join(dataDir || resolveDataDir(), "ai-analysis-log.json");
    this._rateLimitedUntil = new Map();
  }

  get presets() {
    return this._presets;
  }

  get availableIntervals() {
    return AVAILABLE_INTERVALS;
  }

  /**
   * Labels are defined per default preset (e.g. "BINANCE:BTCUSDT" -> "BTCUSDT").
   * A symbol analyzed at a timeframe outside its default preset still deserves
   * the same friendly label, so look it up by symbol alone before falling
   * back to the raw symbol string.
   */
  _labelForSymbol(symbol) {
    const match = this._presets.find((p) => p.symbol === symbol);
    if (match) return match.label;
    const idx = symbol.indexOf(":");
    return idx === -1 ? symbol : symbol.slice(idx + 1);
  }

  isConfigured() {
    return Boolean(this._client && this._chartImgApiKey);
  }

  _latestCacheKey(symbol, interval) {
    return `ai-analysis:latest:${presetKey(symbol, interval)}`;
  }

  _readLog() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._logFile, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _writeLog(entries) {
    try {
      const dir = path.dirname(this._logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._logFile, JSON.stringify(entries.slice(0, 200), null, 2), "utf8");
    } catch (err) {
      console.error("[AIAnalysis] Failed to write generation log:", err.message);
    }
  }

  _logGeneration(entry) {
    const log = this._readLog();
    log.unshift(entry);
    this._writeLog(log);
  }

  async _fetchChartUrl(symbol, interval) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(this._chartImgBaseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this._chartImgApiKey,
        },
        body: JSON.stringify({
          theme: "dark",
          interval,
          symbol,
          studies: studiesForSymbol(symbol),
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const detail = payload?.message || payload?.error || text.slice(0, 200) || response.statusText;
        const error = new Error(`chart-img HTTP ${response.status} ${detail}`);
        error.statusCode = response.status;
        throw error;
      }
      if (!payload?.url) {
        throw new Error("chart-img response did not include an image url");
      }
      return payload.url;
    } finally {
      clearTimeout(timer);
    }
  }

  async _analyzeChart(chartUrl) {
    const res = await this._client.responses.create({
      model: this._model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: chartUrl },
            { type: "input_text", text: ANALYSIS_PROMPT },
          ],
        },
      ],
    });
    return res.output_text;
  }

  _isRateLimitError(err) {
    const status = err?.status || err?.statusCode || err?.response?.status;
    return status === 429 || /rate limit|429/i.test(err?.message || "");
  }

  /**
   * Read-only: return cached analyses for every configured preset. Never
   * triggers generation, so simply viewing the page can't spend API calls.
   */
  peekAll() {
    return this._presets.map((preset) => {
      const cached = this._cache.get(this._latestCacheKey(preset.symbol, preset.interval));
      return { ...preset, ...(cached || {}) };
    });
  }

  /**
   * Record that the current generation for this symbol/interval has been
   * broadcast, so the same generation can't be sent twice. A fresh generate()
   * overwrites the entry without broadcastAt, re-arming the broadcast.
   */
  markBroadcasted(symbol, interval) {
    const key = this._latestCacheKey(symbol, interval);
    const cached = this._cache.get(key);
    if (!cached) return null;
    const updated = { ...cached, broadcastAt: new Date().toISOString() };
    this._cache.set(key, updated, PERSIST_TTL_MS);
    return updated;
  }

  /**
   * Read-only: return the preset info merged with its last generated result
   * (if any), for broadcasting an already-generated analysis.
   */
  getCached(symbol, interval) {
    const preset = this._presets.find((p) => p.symbol === symbol && p.interval === interval) || {
      symbol,
      interval,
      label: this._labelForSymbol(symbol),
    };
    const cached = this._cache.get(this._latestCacheKey(symbol, interval));
    return cached ? { ...preset, ...cached } : null;
  }

  /**
   * Read-only: the most recent generation events (any symbol/interval),
   * newest first, for the page's generation log.
   */
  getLog(limit) {
    return this._readLog().slice(0, limit || 100);
  }

  /**
   * Generate (or reuse a cached) analysis for one symbol/interval preset.
   */
  async generate(symbol, interval, ttlMs) {
    if (!this._client) {
      return { configured: false, reason: "OPENAI_API_KEY is not set" };
    }
    if (!this._chartImgApiKey) {
      return { configured: false, reason: "CHART_IMG_API_KEY is not set" };
    }

    const preset = this._presets.find((p) => p.symbol === symbol && p.interval === interval) || {
      symbol,
      interval,
      label: this._labelForSymbol(symbol),
    };
    const key = this._latestCacheKey(symbol, interval);
    const cached = this._cache.get(key);
    if (cached && cached.generatedAt && Date.now() - new Date(cached.generatedAt).getTime() < ttlMs) {
      return { ...preset, ...cached, generationSkipped: true, generationSkippedReason: "cached" };
    }

    const cooldown = this._rateLimitedUntil.get(key) || 0;
    if (cooldown > Date.now()) {
      return {
        ...preset,
        ...(cached || {}),
        rateLimited: true,
        rateLimitedUntil: new Date(cooldown).toISOString(),
        error: "Rate-limited. Showing the last saved analysis instead of retrying immediately.",
      };
    }

    try {
      const chartUrl = await this._fetchChartUrl(symbol, interval);
      const rawAnalysis = await this._analyzeChart(chartUrl);
      const verdict = extractVerdict(rawAnalysis);
      const analysis = truncateWords(rawAnalysis, MAX_ANALYSIS_WORDS);
      const generatedAt = new Date().toISOString();
      const result = { chartUrl, analysis, verdict, model: this._model, generatedAt };
      this._cache.set(key, result, PERSIST_TTL_MS);
      this._logGeneration({ symbol, interval, label: preset.label, ...result });
      return { ...preset, ...result };
    } catch (err) {
      if (this._isRateLimitError(err)) {
        const untilMs = Date.now() + 5 * 60 * 1000;
        this._rateLimitedUntil.set(key, untilMs);
        return {
          ...preset,
          ...(cached || {}),
          rateLimited: true,
          rateLimitedUntil: new Date(untilMs).toISOString(),
          error: "Rate-limited. Showing any saved analysis instead of retrying immediately.",
        };
      }
      throw err;
    }
  }
}

module.exports = { AIAnalysisService };
