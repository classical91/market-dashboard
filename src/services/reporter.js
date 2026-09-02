const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const OpenAI = require("openai");
const { resolveDataDir } = require("../utils/data-dir");
const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// Keep `markets` as the stored/API key for backward compatibility, while the
// studio presents it as Stocks. Renaming the key would orphan saved reports.
const REPORT_SECTIONS = ["geopolitics", "economics", "markets", "crypto"];

// Why a cycle delivery can refuse to send. These are error codes on a stored
// failure, so they are part of the operational contract and are exported for
// the newsroom service and its tests rather than retyped as string literals.
const GENERATION_REFERENCE_MISSING = "generation_reference_missing";
const GENERATION_REFERENCE_AMBIGUOUS = "generation_reference_ambiguous";
const GENERATION_REFERENCE_INVALID = "generation_reference_invalid";
const SECTION_LABELS = {
  geopolitics: "Geopolitics Top 10",
  economics: "Economics Top 10",
  markets: "Stocks Top 10",
  crypto: "Crypto Top 10",
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
  const normalized = section === "stocks" ? "markets" : section;
  return REPORT_SECTIONS.includes(normalized) ? normalized : "crypto";
}

function logEntryDayKey(entry) {
  if (entry.generatedDateKey) return entry.generatedDateKey;
  if (entry.generatedAt) {
    const d = new Date(entry.generatedAt);
    if (!Number.isNaN(d.getTime())) return formatDateKey(d);
  }
  return null;
}

/**
 * Collapse multiple log entries for the same section on the same day down to
 * the most recently generated one, so pre-existing duplicates (e.g. saved
 * before the same-day dedupe check existed) get cleaned up on next read.
 */
function dedupeLog(entries) {
  const bestByKey = new Map();
  const undated = [];
  entries.forEach((entry) => {
    if (!entry || !entry.section) return;
    const day = logEntryDayKey(entry);
    if (!day) {
      undated.push(entry);
      return;
    }
    const key = `${entry.section}:${day}`;
    const existing = bestByKey.get(key);
    if (!existing || new Date(entry.generatedAt || 0) > new Date(existing.generatedAt || 0)) {
      bestByKey.set(key, entry);
    }
  });
  return [...bestByKey.values(), ...undated].sort(
    (a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0)
  );
}

/**
 * Source/evidence a generation actually returned.
 *
 * The Responses API attaches `url_citation` annotations to the output text
 * when the web_search tool contributed to it. When it attaches none, this
 * returns an empty list: a report with no citations is recorded as having no
 * citations, never as having invented ones. See docs/newsroom-cycles.md for
 * what that means operationally.
 */
function extractSources(response) {
  const seen = new Map();
  const output = Array.isArray(response?.output) ? response.output : [];
  output.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part) => {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      annotations.forEach((annotation) => {
        if (!annotation || (annotation.type && annotation.type !== "url_citation")) return;
        const url = typeof annotation.url === "string" ? annotation.url.trim() : "";
        if (!url || seen.has(url)) return;
        seen.set(url, {
          url: url.slice(0, 2000),
          title: typeof annotation.title === "string" ? annotation.title.trim().slice(0, 300) : null,
        });
      });
    });
  });
  return [...seen.values()];
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((source) => ({
      url: typeof source?.url === "string" ? source.url.trim().slice(0, 2000) : null,
      title: typeof source?.title === "string" ? source.title.trim().slice(0, 300) : null,
    }))
    .filter((source) => source.url || source.title)
    .slice(0, 50);
}

function normalizeImportedLogEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const section = normalizeSection(entry.section);
  const content = typeof entry.content === "string" ? entry.content.trim().slice(0, 50000) : "";
  const generatedAt = typeof entry.generatedAt === "string" ? entry.generatedAt : "";
  const generatedDate = generatedAt ? new Date(generatedAt) : null;
  if (!content || !generatedAt || Number.isNaN(generatedDate.getTime())) return null;
  return {
    section,
    label: SECTION_LABELS[section],
    generatedAt: generatedDate.toISOString(),
    generatedDateKey: entry.generatedDateKey || formatDateKey(generatedDate),
    dateStr: typeof entry.dateStr === "string" ? entry.dateStr.slice(0, 120) : formatDate(),
    model: typeof entry.model === "string" ? entry.model.slice(0, 80) : null,
    content,
    prompt: typeof entry.prompt === "string" ? entry.prompt.slice(0, 12000) : null,
    // Both are optional and absent from every entry written before newsroom
    // cycles existed. They are carried through import rather than required,
    // so a historical export still round-trips.
    cycleId: typeof entry.cycleId === "string" ? entry.cycleId.slice(0, 120) : null,
    sources: normalizeSources(entry.sources),
  };
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
  return `🗓️🌍 ${dateStr}
💹 TOP 10 GLOBAL ECONOMIC DEVELOPMENTS BRIEF (LAST 24-48 HOURS) 💹

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
  **#[N] [COUNTRY/REGION] — [HEADLINE TITLE]**
- Use only simple hyphen bullets (-) for sub-details beneath each heading
- Keep each item short and structured (max 6 lines total including heading)
- For data releases, include: DATA + actual vs. expected where relevant
- If uncertain of a specific data point, omit it rather than approximate

GOAL: concise, globally balanced daily economics snapshot.`;
}

function geopoliticsPrompt(dateStr) {
  return `🗓️🌍 ${dateStr}
TOP 10 GEOPOLITICAL DEVELOPMENTS BRIEF (LAST 24-48 HOURS)

Search for current, verified geopolitical developments from the last 24-48 hours and produce a globally balanced TOP 10 report.

PRIORITIZE:
- Active conflicts, ceasefires, sanctions, and diplomatic negotiations
- Material changes in alliances, defense posture, or security policy
- Trade restrictions, energy-security events, and shipping disruptions
- Elections or government decisions with international consequences

RULES:
- Output exactly 10 stories.
- Use a bold numbered heading: **#[N] [REGION] — [HEADLINE]**
- Add 2-3 short hyphen bullets: what happened, why it matters, and what to watch.
- Separate confirmed facts from analysis; do not speculate or make market calls.
- Avoid duplicating the same event from multiple sources.`;
}

function marketsPrompt(dateStr) {
  return `🗓️ ${dateStr}

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
  if (section === "geopolitics") return geopoliticsPrompt(dateStr);
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
  constructor({ cache, apiKey, model, dataDir }) {
    this._cache = cache;
    this._apiKey = apiKey;
    this._client = apiKey ? new OpenAI({ apiKey }) : null;
    this._model = model || "gpt-5.4-mini";
    this._logFile = path.join(dataDir || resolveDataDir(), "reporter-generation-log.json");
    this._lockState = { depth: 0 };
    this._rateLimitedUntil = new Map();
  }

  _cacheKey(ttlMs, section, promptKey = "default") {
    const period = Math.floor(Date.now() / ttlMs);
    return `reporter:v3:${section}:${promptKey}:${ttlMs}:${period}`;
  }

  _latestCacheKey(section) {
    return `reporter:latest:${section}`;
  }

  _broadcastKey() {
    return "reporter:broadcastAt";
  }

  /**
   * Read-only: the ISO timestamp the aggregate report was last broadcast to
   * Telegram, or null if it never has been (or the guard expired).
   */
  getBroadcastAt() {
    return this._cache.get(this._broadcastKey()) || null;
  }

  /**
   * Record that the current aggregate report has been broadcast, so the same
   * generation can't be sent twice. A fresh generateReport() call for any
   * section advances the report's generatedAt past this timestamp, which
   * re-arms the broadcast gate in the route.
   */
  markBroadcasted() {
    const broadcastAt = new Date().toISOString();
    this._cache.set(this._broadcastKey(), broadcastAt, 7 * 24 * 60 * 60 * 1000);
    return broadcastAt;
  }

  _readLog() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._logFile, "utf8"));
      const entries = Array.isArray(parsed) ? parsed : [];
      const deduped = dedupeLog(entries);
      if (deduped.length !== entries.length) this._writeLog(deduped);
      return deduped;
    } catch {
      return [];
    }
  }

  _writeLog(entries) {
    writeJsonAtomic(this._logFile, entries.slice(0, 100), console, "[Reporter]");
  }

  /**
   * Serialize a read-modify-write of the generation log.
   *
   * Two sections generating at once — which is the normal case, since a cycle
   * fans out across the newsroom desks — would otherwise each read
   * the same log, prepend their own entry, and write back, so whichever
   * finished last silently dropped the other's entry.
   */
  _updateLog(mutate) {
    return withExclusiveLock(
      this._logFile,
      this._lockState,
      () => {
        const log = this._readLog();
        const next = mutate(log);
        this._writeLog(next);
        return next;
      },
      { busyMessage: "Reporter generation log is busy; retry the request." },
    );
  }

  _logGeneration(entry) {
    this._updateLog((log) => {
      log.unshift(entry);
      return log;
    });
  }

  importLogEntries(entries, ttlMs) {
    const incoming = Array.isArray(entries) ? entries.map(normalizeImportedLogEntry).filter(Boolean) : [];
    if (!incoming.length) return this._buildReport(ttlMs || DEFAULT_TTL_MS);

    const merged = this._updateLog((log) => dedupeLog([...incoming, ...log]));

    const resolvedTtl = ttlMs || DEFAULT_TTL_MS;
    REPORT_SECTIONS.forEach((section) => {
      const latest = merged.find((entry) => entry.section === section && entry.content);
      if (!latest) return;
      this._cache.set(
        this._latestCacheKey(section),
        {
          dateStr: latest.dateStr,
          content: latest.content,
          generatedAt: latest.generatedAt,
          generatedDateKey: latest.generatedDateKey,
        },
        Math.max(resolvedTtl, msUntilNextDay()),
      );
    });

    return this._buildReport(resolvedTtl);
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
    const log = this._readLog();
    const report = {
      configured: true,
      generated: false,
      reporterModel: this._model,
      sections: REPORT_SECTIONS,
      generationLog: log,
    };

    REPORT_SECTIONS.forEach((section) => {
      const cached = this._cache.get(this._latestCacheKey(section)) || this._cache.get(this._cacheKey(ttlMs, section));
      // The log persists to disk separately from the cache, so if the cache
      // ever loses an entry (e.g. a process restart), fall back to the most
      // recent logged entry for the section instead of showing no report.
      const loggedEntry = !cached && log.find((entry) => entry && entry.section === section && entry.content);
      const resolved = cached || (loggedEntry
        ? { dateStr: loggedEntry.dateStr, content: loggedEntry.content, generatedAt: loggedEntry.generatedAt }
        : null);
      if (!resolved) return;
      if (!cached) this._cache.set(this._latestCacheKey(section), resolved, Math.max(ttlMs, msUntilNextDay()));
      report.generated = true;
      report.dateStr = report.dateStr || resolved.dateStr;
      report[section] = resolved.content;
      report.generatedAtBySection = report.generatedAtBySection || {};
      report.generatedAtBySection[section] = resolved.generatedAt;
      if (!report.generatedAt || resolved.generatedAt > report.generatedAt) {
        report.generatedAt = resolved.generatedAt;
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
    return { content: res.output_text, sources: extractSources(res) };
  }

  /** Whether an API key is present. Used by the newsroom preflight. */
  get configured() {
    return Boolean(this._client);
  }

  get model() {
    return this._model;
  }

  get sections() {
    return [...REPORT_SECTIONS];
  }

  /**
   * Query the durable generation log.
   *
   * The log is the historical record — it holds every section's content, not
   * just the latest — so a cycle's report stays readable long after the cache
   * that served the page has expired.
   */
  listGenerations({ cycleId, section, since, limit = 50 } = {}) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const sinceMs = since && !Number.isNaN(new Date(since).getTime()) ? new Date(since).getTime() : null;
    return this._readLog()
      .filter((entry) => (cycleId ? entry.cycleId === cycleId : true))
      .filter((entry) => (section ? entry.section === section : true))
      .filter((entry) => {
        if (!sinceMs) return true;
        const at = new Date(entry.generatedAt || 0).getTime();
        return Number.isFinite(at) && at >= sinceMs;
      })
      .slice(0, cap);
  }

  /**
   * Resolve the one historical generation a cycle's section reference names.
   *
   * This is the read that makes a newsroom delivery retry safe. `peekReport()`
   * answers "what is the latest content for this section", which is the right
   * question for the Daily Reporter page and the wrong one for a cycle: a
   * cycle retried after a newer cycle generated the same section would pick up
   * the newer text and publish it under the older cycle's receipts. So a cycle
   * asks for an exact generation instead, and this either finds exactly one or
   * refuses.
   *
   * Identity rules:
   *   - `section` is always required.
   *   - `generatedAt` is matched on the exact instant, never a nearest match.
   *   - `cycleId`, when the reference carries one, must match the log entry's.
   *     A reference with `cycleId: null` describes a generation that was made
   *     outside a cycle (a manual studio run, or history written before cycles
   *     existed), and is identified by section plus exact timestamp alone.
   *
   * Anything other than a single match fails: nothing here falls back to
   * "latest", and an ambiguous history is refused rather than guessed at.
   *
   * @returns {{ok: true, generation: object} | {ok: false, code: string, detail: string}}
   */
  getGenerationForReference(reference = {}) {
    const section = typeof reference.section === "string" ? reference.section.trim() : "";
    if (!section || !REPORT_SECTIONS.includes(section)) {
      return {
        ok: false,
        code: GENERATION_REFERENCE_INVALID,
        detail: `The generation reference names no known report section (${section || "none"}).`,
      };
    }

    const at = reference.generatedAt ? new Date(reference.generatedAt) : null;
    if (!at || Number.isNaN(at.getTime())) {
      return {
        ok: false,
        code: GENERATION_REFERENCE_INVALID,
        detail: `The generation reference for "${section}" carries no usable generated timestamp.`,
      };
    }
    const atMs = at.getTime();

    const wantedCycleId = typeof reference.cycleId === "string" && reference.cycleId.trim()
      ? reference.cycleId.trim()
      : null;

    const matches = this._readLog().filter((entry) => {
      if (!entry || entry.section !== section || !entry.content) return false;
      const entryAt = new Date(entry.generatedAt || 0).getTime();
      if (!Number.isFinite(entryAt) || entryAt !== atMs) return false;
      if (wantedCycleId) return entry.cycleId === wantedCycleId;
      return true;
    });

    if (matches.length === 1) return { ok: true, generation: matches[0] };
    if (matches.length === 0) {
      return {
        ok: false,
        code: GENERATION_REFERENCE_MISSING,
        detail: `No stored generation matches ${section} @ ${at.toISOString()}${wantedCycleId ? ` for cycle ${wantedCycleId}` : ""}.`,
      };
    }
    return {
      ok: false,
      code: GENERATION_REFERENCE_AMBIGUOUS,
      detail: `${matches.length} stored generations match ${section} @ ${at.toISOString()}; the reference does not identify one.`,
    };
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
  async generateReport(ttlMs, requestedSection, customPrompt, { cycleId = null } = {}) {
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
        // The section already exists, so a cycle that lands here reuses it
        // rather than paying to remake it. These describe the entry being
        // reused — including the cycle that first produced it, when there was
        // one — so the reuse stays traceable.
        reusedGeneratedAt: (loggedToday && loggedToday.generatedAt) || existingGeneratedAt || null,
        reusedCycleId: (loggedToday && loggedToday.cycleId) || null,
        reusedModel: (loggedToday && loggedToday.model) || null,
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
        const { content, sources } = await this._generate(prompt);
        generatedEntry = {
          section,
          label: SECTION_LABELS[section],
          generatedAt,
          generatedDateKey: formatDateKey(),
          dateStr,
          content,
          prompt: promptOverride || null,
          cycleId,
          sources,
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
      const sources = generatedEntry ? normalizeSources(generatedEntry.sources) : [];
      this._logGeneration({
        section,
        label: SECTION_LABELS[section],
        generatedAt: report.generatedAtBySection && report.generatedAtBySection[section],
        generatedDateKey: formatDateKey(),
        dateStr: report.dateStr,
        model: this._model,
        content: generatedEntry ? generatedEntry.content : report[section],
        prompt: generatedEntry ? generatedEntry.prompt : null,
        // Null for every entry written outside a newsroom cycle — a manual
        // generation from the studio page still logs, it just has no cycle.
        cycleId: cycleId || null,
        sources,
      });
      report.generationLog = this._readLog();
      report.generatedSources = sources;
    }

    return report;
  }
}

module.exports = {
  ReporterService,
  REPORT_SECTIONS,
  SECTION_LABELS,
  extractSources,
  GENERATION_REFERENCE_MISSING,
  GENERATION_REFERENCE_AMBIGUOUS,
  GENERATION_REFERENCE_INVALID,
};
