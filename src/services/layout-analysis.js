const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { ANALYSIS_PROMPT, MAX_ANALYSIS_WORDS, PERSIST_TTL_MS, extractVerdict, truncateWords } = require("./analysis-prompt");

function normalizeLayouts(layouts) {
  if (!Array.isArray(layouts)) return [];
  return layouts
    .map((layout) => ({
      id: String(layout.id || layout.label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: String(layout.label || layout.id || "").trim(),
      url: String(layout.url || "").trim(),
    }))
    .filter((layout) => layout.id && layout.url);
}

class LayoutAnalysisService {
  constructor({ cache, dataDir, openaiApiKey, model, layouts, captureService, screenshotDir, screenshotUrlPrefix }) {
    this._cache = cache;
    this._client = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
    this._model = model || "gpt-5.4-mini";
    this._layouts = normalizeLayouts(layouts);
    this._captureService = captureService;
    this._screenshotDir = screenshotDir;
    this._screenshotUrlPrefix = screenshotUrlPrefix || "/layout-screenshots";
    this._logFile = path.join(dataDir, "layout-analysis-log.json");
    this._rateLimitedUntil = new Map();
  }

  get layouts() {
    return this._layouts;
  }

  isConfigured() {
    return Boolean(this._client) && this._layouts.length > 0;
  }

  _findLayout(id) {
    return this._layouts.find((layout) => layout.id === id) || null;
  }

  _cacheKey(id) {
    return `layout-analysis:latest:${id}`;
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
      console.error("[LayoutAnalysis] Failed to write generation log:", err.message);
    }
  }

  _logGeneration(entry) {
    const log = this._readLog();
    log.unshift(entry);
    this._writeLog(log);
  }

  async _saveScreenshot(id, buffer, publicBaseUrl) {
    if (!fs.existsSync(this._screenshotDir)) fs.mkdirSync(this._screenshotDir, { recursive: true });
    const filename = `${id}-${Date.now()}.png`;
    const filePath = path.join(this._screenshotDir, filename);
    fs.writeFileSync(filePath, buffer);
    return { filePath, chartUrl: `${publicBaseUrl}${this._screenshotUrlPrefix}/${filename}` };
  }

  // Screenshots pile up on disk otherwise — only the most recent one per
  // layout is ever displayed or broadcast, so the previous file is dead
  // weight the moment a new generation replaces it.
  _deleteScreenshot(filePath) {
    if (!filePath) return;
    fs.unlink(filePath, () => {});
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
   * Read-only: return cached analyses for every configured layout. Never
   * triggers capture/generation.
   */
  peekAll() {
    return this._layouts.map((layout) => {
      const cached = this._cache.get(this._cacheKey(layout.id));
      const { screenshotPath, ...rest } = cached || {};
      return { ...layout, ...rest };
    });
  }

  markBroadcasted(id) {
    const key = this._cacheKey(id);
    const cached = this._cache.get(key);
    if (!cached) return null;
    const updated = { ...cached, broadcastAt: new Date().toISOString() };
    this._cache.set(key, updated, PERSIST_TTL_MS);
    const { screenshotPath, ...rest } = updated;
    return rest;
  }

  getCached(id) {
    const layout = this._findLayout(id);
    if (!layout) return null;
    const cached = this._cache.get(this._cacheKey(id));
    const { screenshotPath, ...rest } = cached || {};
    return { ...layout, ...rest };
  }

  getLog(limit) {
    return this._readLog().slice(0, limit || 100);
  }

  /**
   * Capture (or reuse a cached) analysis for one saved layout.
   */
  async generate(id, ttlMs, publicBaseUrl) {
    if (!this._client) {
      return { configured: false, reason: "OPENAI_API_KEY is not set" };
    }
    const layout = this._findLayout(id);
    if (!layout) {
      return { configured: false, reason: `Unknown layout id "${id}"` };
    }

    const key = this._cacheKey(id);
    const cached = this._cache.get(key);
    if (cached && cached.generatedAt && Date.now() - new Date(cached.generatedAt).getTime() < ttlMs) {
      const { screenshotPath, ...rest } = cached;
      return { ...layout, ...rest, generationSkipped: true, generationSkippedReason: "cached" };
    }

    const cooldown = this._rateLimitedUntil.get(key) || 0;
    if (cooldown > Date.now()) {
      const { screenshotPath, ...rest } = cached || {};
      return {
        ...layout,
        ...rest,
        rateLimited: true,
        rateLimitedUntil: new Date(cooldown).toISOString(),
        error: "Rate-limited. Showing the last saved analysis instead of retrying immediately.",
      };
    }

    try {
      const screenshot = await this._captureService.capture(layout.url);
      const { filePath, chartUrl } = await this._saveScreenshot(id, screenshot, publicBaseUrl);
      const rawAnalysis = await this._analyzeChart(chartUrl);
      const verdict = extractVerdict(rawAnalysis);
      const analysis = truncateWords(rawAnalysis, MAX_ANALYSIS_WORDS);
      const generatedAt = new Date().toISOString();
      const result = { chartUrl, analysis, verdict, model: this._model, generatedAt, screenshotPath: filePath };
      this._deleteScreenshot(cached && cached.screenshotPath);
      this._cache.set(key, result, PERSIST_TTL_MS);
      const { screenshotPath, ...logResult } = result;
      this._logGeneration({ layoutId: id, label: layout.label, ...logResult });
      return { ...layout, ...logResult };
    } catch (err) {
      if (this._isRateLimitError(err)) {
        const untilMs = Date.now() + 5 * 60 * 1000;
        this._rateLimitedUntil.set(key, untilMs);
        const { screenshotPath, ...rest } = cached || {};
        return {
          ...layout,
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

module.exports = { LayoutAnalysisService };
