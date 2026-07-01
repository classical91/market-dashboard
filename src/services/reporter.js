const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const OpenAI = require("openai");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const REPORT_SECTIONS = ["crypto", "economics", "markets"];
const SECTION_LABELS = {
  crypto: "Emerging Markets",
  economics: "Economics Top 10",
  markets: "Markets Top 10",
};

const SYSTEM_PROMPT =
  "You are a professional financial journalist producing concise, structured daily market briefings. " +
  "Follow the exact format requested: numbered items, hyphen bullets, sentiment labels. " +
  "Be factual, precise, and keep each story within the specified line limit.";

function formatDate() {
  return new Date()
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function msUntilNextDay(date = new Date()) {
  const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return Math.max(nextDay.getTime() - date.getTime(), 60 * 1000);
}

function isGeneratedToday(entry) {
  if (!entry) return false;
  if (entry.generatedDateKey) return entry.generatedDateKey === formatDateKey();
  if (!entry.generatedAt) return false;
  const generatedAt = new Date(entry.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) return false;
  return formatDateKey(generatedAt) === formatDateKey();
}

function normalizeSection(section) {
  return REPORT_SECTIONS.includes(section) ? section : "crypto";
}

function cryptoPrompt(dateStr) {
  return `${dateStr}
TOP 10 EMERGING / TRENDING CRYPTO TOKENS

Find 10 crypto tokens that are trending or starting to emerge right now. Keep this lightweight: use recent web results and market/news mentions, but do not perform a deep risk audit.

Rules:
- Output exactly 10 tokens.
- Prefer tokens with recent momentum, fresh listings, rising volume, social buzz, or a clear narrative.
- Avoid obvious mega-caps unless there is a fresh reason they are trending.
- Use simple hyphen bullets only.
- Keep each item short: heading plus 2-3 bullets.
- Do not give financial advice or buy/sell instructions.

Format each item:
**#[N] [TOKEN NAME] ([TICKER]) - [CHAIN / CATEGORY]**
- Why it is trending
- Main catalyst or signal
- Quick caution if relevant`;

}

function economicsPrompt(dateStr) {
  return `ðŸ—“ï¸ðŸŒ ${dateStr}
ðŸ’¹ TOP 10 GLOBAL ECONOMIC DEVELOPMENTS BRIEF (LAST 24-48 HOURS) ðŸ’¹

Search for current and verified economic events, indicators, policy moves, market data, or macro developments from the last 24-48 hours and produce a TOP 10 report.

GEOGRAPHIC SCOPE (REQUIRED):
Cover a globally balanced mix across major economies. Prioritize:
- United States
- Eurozone / EU
- China
- United Kingdom
- Japan
- India, Brazil, Korea, or other emerging / major economies (at least 1-2 items)

Do not cluster more than 3 items on any single country.

PRIORITY ORDER (when more than 10 items compete):
1. Central bank decisions or policy shifts
2. Official government data releases
3. Major market moves (equities, FX, commodities, bonds)
4. Trade, tariff, or geopolitical macro developments
5. Forecasts or revisions from credible institutions (IMF, World Bank, OECD, etc.)

FORMAT RULES (STRICT):
- Output EXACTLY 10 items (no more, no less)
- Each item must begin with a bold numbered heading on its own line, structured as:
  **#[N] [COUNTRY/REGION] â€” [HEADLINE TITLE]**
- Use only simple hyphen bullets (-) for sub-details beneath each heading
- Keep each item short and structured (max 6 lines total including heading)
- For data releases, include: DATA + actual vs. expected where relevant
- If uncertain of a specific data point, omit it rather than approximate

GOAL: concise, globally balanced daily economics snapshot.`;
}

function marketsPrompt(dateStr) {
  return `ðŸ—“ï¸ ${dateStr}

Create a TOP 10 global markets news brief from the past 24-48 hours.

Coverage should include a mix of:
- Stocks / indices
- Forex
- Commodities
- Bonds / rates
- Macro / central banks

Rules:
- Output exactly 10 stories.
- For each story include:
  1. Title (short)
  2. Why it matters (1-2 bullets)
  3. Assets affected (tickers / pairs / indices / contracts)
  4. Sentiment: Bullish / Bearish / Neutral
- Keep each story to max 4 lines total.
- No long paragraphs.
- Use hyphen bullets only.`;
}

function promptForSection(section, dateStr) {
  if (section === "economics") return economicsPrompt(dateStr);
  if (section === "markets") return marketsPrompt(dateStr);
  return cryptoPrompt(dateStr);
}

function normalizeCustomPrompt(prompt) {
  if (typeof prompt !== "string") return "";
  return prompt.trim().slice(0, 12000);
}

function customPromptForDate(prompt, dateStr) {
  const normalized = normalizeCustomPrompt(prompt);
  if (!normalized) return "";
  if (/\{date\}/i.test(normalized)) {
    return normalized.replace(/\{date\}/gi, dateStr);
  }
  return `${dateStr}\n${normalized}`;
}

function promptCacheKey(prompt) {
  const normalized = normalizeCustomPrompt(prompt);
  if (!normalized) return "default";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

class ReporterService {
  constructor({ cache, apiKey, model, telegramService }) {
    this._cache = cache;
    this._apiKey = apiKey;
    this._client = apiKey ? new OpenAI({ apiKey }) : null;
    this._model = model || "gpt-5.4-mini";
    this._telegram = telegramService || null;
    this._logFile = path.join(process.cwd(), "data", "reporter-generation-log.json");
    this._rateLimitedUntil = new Map();
  }

  _cacheKey(ttlMs, section, promptKey = "default") {
    const period = Math.floor(Date.now() / ttlMs);
    return `reporter:v3:${section}:${promptKey}:${ttlMs}:${period}`;
  }

  _latestCacheKey(section) {
    return `reporter:latest:${section}`;
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
      fs.writeFileSync(this._logFile, JSON.stringify(entries.slice(0, 100), null, 2), "utf8");
    } catch (err) {
      console.error("[Reporter] Failed to write generation log:", err.message);
    }
  }

  _logGeneration(entry) {
    const log = this._readLog();
    log.unshift(entry);
    this._writeLog(log);
  }

  _isRateLimitError(err) {
    const status = err?.status || err?.statusCode || err?.response?.status;
    return status === 429 || /rate limit|429/i.test(err?.message || "");
  }

  _withRateLimit(report, section, untilMs) {
    return {
      ...report,
      rateLimited: true,
      rateLimitedSection: section,
      rateLimitedUntil: new Date(untilMs).toISOString(),
      reporterModel: this._model,
      error: "OpenAI is rate-limited. Showing any saved report instead of retrying immediately.",
    };
  }

  _buildReport(ttlMs) {
    const report = {
      configured: true,
      generated: false,
      reporterModel: this._model,
      sections: REPORT_SECTIONS,
      generationLog: this._readLog(),
    };

    REPORT_SECTIONS.forEach((section) => {
      const cached = this._cache.get(this._latestCacheKey(section)) || this._cache.get(this._cacheKey(ttlMs, section));
      if (!cached) return;
      report.generated = true;
      report.dateStr = report.dateStr || cached.dateStr;
      report[section] = cached.content;
      report.generatedAtBySection = report.generatedAtBySection || {};
      report.generatedAtBySection[section] = cached.generatedAt;
      if (!report.generatedAt || cached.generatedAt > report.generatedAt) {
        report.generatedAt = cached.generatedAt;
        report.latestSection = section;
      }
    });

    return report;
  }

  async _generate(prompt) {
    const res = await this._client.responses.create({
      model: this._model,
      instructions: SYSTEM_PROMPT,
      tools: [{ type: "web_search" }],
      input: prompt,
    });
    return res.output_text;
  }

  /**
   * Read-only: return cached section reports if they exist. Never triggers
   * generation, so simply viewing the page can't spend API calls.
   */
  peekReport(ttlMs) {
    if (!this._client) {
      return { configured: false };
    }
    return this._buildReport(ttlMs || DEFAULT_TTL_MS);
  }

  /**
   * Generate only the requested reporter section, then return the current
   * aggregate cached report so the UI can keep already-generated tabs visible.
   */
  async generateReport(ttlMs, requestedSection, customPrompt) {
    if (!this._client) {
      return { configured: false };
    }

    const resolvedTtl = ttlMs || DEFAULT_TTL_MS;
    const section = normalizeSection(requestedSection);
    const promptOverride = normalizeCustomPrompt(customPrompt);
    const key = this._cacheKey(resolvedTtl, section, promptCacheKey(promptOverride));
    const existingReport = this._buildReport(resolvedTtl);
    const existingGeneratedAt = existingReport.generatedAtBySection && existingReport.generatedAtBySection[section];
    const loggedToday = this._readLog().find(
      (entry) => entry && entry.section === section && isGeneratedToday(entry)
    );
    if ((existingReport[section] && isGeneratedToday({ generatedAt: existingGeneratedAt })) || loggedToday) {
      const fallback = loggedToday
        ? { ...existingReport, [section]: existingReport[section] || loggedToday.content }
        : existingReport;
      return {
        ...fallback,
        generatedSection: section,
        generationSkipped: true,
        generationSkippedReason: "already-generated-today",
        nextGenerationDate: formatDateKey(new Date(Date.now() + msUntilNextDay())),
      };
    }

    const existingCooldown = this._rateLimitedUntil.get(section) || 0;
    if (existingCooldown > Date.now()) {
      return this._withRateLimit(this._buildReport(resolvedTtl), section, existingCooldown);
    }

    let created = false;
    let generatedEntry = null;
    let loadedEntry = null;

    try {
      loadedEntry = await this._cache.getOrLoad(key, resolvedTtl, async () => {
        created = true;
        const dateStr = formatDate();
        const generatedAt = new Date().toISOString();
        const prompt = customPromptForDate(promptOverride, dateStr) || promptForSection(section, dateStr);
        const content = await this._generate(prompt);
        generatedEntry = {
          section,
          label: SECTION_LABELS[section],
          generatedAt,
          generatedDateKey: formatDateKey(),
          dateStr,
          content,
          prompt: promptOverride || null,
        };
        return generatedEntry;
      });
    } catch (err) {
      if (!this._isRateLimitError(err)) throw err;
      const untilMs = Date.now() + 5 * 60 * 1000;
      this._rateLimitedUntil.set(section, untilMs);
      return this._withRateLimit(this._buildReport(resolvedTtl), section, untilMs);
    }

    if (loadedEntry) {
      this._cache.set(this._latestCacheKey(section), loadedEntry, Math.max(resolvedTtl, msUntilNextDay()));
    }

    const report = this._buildReport(resolvedTtl);
    report.generatedSection = section;

    if (created) {
      this._logGeneration({
        section,
        label: SECTION_LABELS[section],
        generatedAt: report.generatedAtBySection && report.generatedAtBySection[section],
        generatedDateKey: formatDateKey(),
        dateStr: report.dateStr,
        model: this._model,
        content: generatedEntry ? generatedEntry.content : report[section],
        prompt: generatedEntry ? generatedEntry.prompt : null,
      });
      report.generationLog = this._readLog();
    }

    if (created && this._telegram && report.crypto && report.economics && report.markets) {
      this._telegram.postReport(report).catch((err) => {
        console.error("[Telegram] Failed to post report:", err.message);
      });
    }

    return report;
  }
}

module.exports = { ReporterService };
