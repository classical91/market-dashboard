const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { resolveDataDir } = require("../utils/data-dir");
const { ANALYSIS_PROMPT, MAX_ANALYSIS_WORDS, PERSIST_TTL_MS, extractVerdict, truncateWords } = require("./analysis-prompt");

// Selectable timeframes for the per-card dropdown, roughly low-to-high.
const AVAILABLE_INTERVALS = ["15m", "1h", "4h", "1D", "1W", "1M"];
const TV_INTERVALS = { "15m": "15", "1h": "60", "4h": "240", "1D": "D", "1W": "W", "1M": "M" };
// The Advanced Chart widget includes Volume by default; add MACD and RSI panes.
const DEFAULT_STUDIES = ["STD;MACD", "STD;RSI"];
const INDEX_STUDIES = ["STD;MACD", "STD;RSI"];
const NO_VOLUME_SYMBOL_PREFIXES = ["CRYPTOCAP:", "TVC:", "SP:", "CBOE:", "FX:", "OANDA:"];

const { DOMINANCE_PRESETS } = require("../config/market-symbols");

const DEFAULT_PRESETS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTCUSDT", interval: "4h" },
  { symbol: "BINANCE:ETHUSDT", label: "ETHUSDT", interval: "4h" },
  { symbol: "BINANCE:SOLUSDT", label: "SOLUSDT", interval: "4h" },
  ...DOMINANCE_PRESETS,
  { symbol: "TVC:DXY", label: "DXY", interval: "4h" },
  { symbol: "SP:SPX", label: "S&P 500", interval: "4h" },
  { symbol: "OANDA:XAUUSD", label: "Gold", interval: "4h" },
  { symbol: "TVC:US02Y", label: "US 2Y", interval: "4h" },
  { symbol: "CBOE:VIX", label: "VIX", interval: "4h" },
  { symbol: "FX:EURUSD", label: "EUR/USD", interval: "4h" },
];

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

function presetKey(symbol, interval) {
  return `${symbol}::${interval}`;
}

class AIAnalysisService {
  constructor({ cache, dataDir, openaiApiKey, model, presets, captureService, screenshotDir, screenshotUrlPrefix }) {
    this._cache = cache;
    this._client = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
    this._model = model || "gpt-5.4-mini";
    this._presets = normalizePresets(presets);
    this._logFile = path.join(dataDir || resolveDataDir(), "ai-analysis-log.json");
    this._captureService = captureService;
    this._screenshotDir = screenshotDir;
    this._screenshotUrlPrefix = screenshotUrlPrefix || "/ai-analysis-screenshots";
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
    return Boolean(this._client && this._captureService);
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

  _studiesForSymbol(symbol) {
    return NO_VOLUME_SYMBOL_PREFIXES.some((prefix) => symbol.startsWith(prefix)) ? INDEX_STUDIES : DEFAULT_STUDIES;
  }

  async _saveScreenshot(symbol, interval, buffer, publicBaseUrl) {
    if (!fs.existsSync(this._screenshotDir)) fs.mkdirSync(this._screenshotDir, { recursive: true });
    const safeName = `${symbol}-${interval}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const filename = `${safeName}-${Date.now()}.png`;
    const filePath = path.join(this._screenshotDir, filename);
    fs.writeFileSync(filePath, buffer);
    return { filePath, chartUrl: `${publicBaseUrl}${this._screenshotUrlPrefix}/${filename}` };
  }

  _deleteScreenshot(filePath) {
    if (filePath) fs.unlink(filePath, () => {});
  }

  async _analyzeChart(buffer) {
    const imageUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    const res = await this._client.responses.create({
      model: this._model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: imageUrl },
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
      const { screenshotPath, ...rest } = cached || {};
      return { ...preset, ...rest };
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
    if (!cached) return null;
    const { screenshotPath, ...rest } = cached;
    return { ...preset, ...rest };
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
  async generate(symbol, interval, ttlMs, publicBaseUrl) {
    if (!this._client) {
      return { configured: false, reason: "OPENAI_API_KEY is not set" };
    }

    const preset = this._presets.find((p) => p.symbol === symbol && p.interval === interval) || {
      symbol,
      interval,
      label: this._labelForSymbol(symbol),
    };
    const key = this._latestCacheKey(symbol, interval);
    const cached = this._cache.get(key);
    if (cached && cached.generatedAt && Date.now() - new Date(cached.generatedAt).getTime() < ttlMs) {
      const { screenshotPath, ...rest } = cached;
      return { ...preset, ...rest, generationSkipped: true, generationSkippedReason: "cached" };
    }

    const cooldown = this._rateLimitedUntil.get(key) || 0;
    if (cooldown > Date.now()) {
      const { screenshotPath, ...rest } = cached || {};
      return {
        ...preset,
        ...rest,
        rateLimited: true,
        rateLimitedUntil: new Date(cooldown).toISOString(),
        error: "Rate-limited. Showing the last saved analysis instead of retrying immediately.",
      };
    }

    try {
      const screenshot = await this._captureService.captureTradingView({
        symbol,
        interval: TV_INTERVALS[interval] || "D",
        studies: this._studiesForSymbol(symbol),
      });
      const { filePath, chartUrl } = await this._saveScreenshot(symbol, interval, screenshot, publicBaseUrl);
      const rawAnalysis = await this._analyzeChart(screenshot);
      const verdict = extractVerdict(rawAnalysis);
      const analysis = truncateWords(rawAnalysis, MAX_ANALYSIS_WORDS);
      const generatedAt = new Date().toISOString();
      const result = { chartUrl, analysis, verdict, model: this._model, generatedAt, screenshotPath: filePath };
      this._deleteScreenshot(cached && cached.screenshotPath);
      this._cache.set(key, result, PERSIST_TTL_MS);
      const { screenshotPath, ...publicResult } = result;
      this._logGeneration({ symbol, interval, label: preset.label, ...publicResult });
      return { ...preset, ...publicResult };
    } catch (err) {
      if (this._isRateLimitError(err)) {
        const untilMs = Date.now() + 5 * 60 * 1000;
        this._rateLimitedUntil.set(key, untilMs);
        const { screenshotPath, ...rest } = cached || {};
        return {
          ...preset,
          ...rest,
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
