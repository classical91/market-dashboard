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
  "You are the lead editor of a fast, trusted markets newsroom, writing the daily briefing traders read first. " +
  "You find the news with web search, then write it with energy and precision: concrete numbers, named actors, " +
  "active verbs, and a clear answer to \"so what?\" in every story. " +
  "Follow the requested format exactly, since pages and Telegram parse it: the bold numbered headings, hyphen bullets and labels. " +
  "Accuracy beats color: never invent a figure, quote or source.";

/**
 * The model's own training data ends before the date it is asked about, and
 * left alone it can decide a current date is "the future" and refuse rather
 * than search. This pins the date as real and the search tool as the source.
 */
function groundingInstructions(dateStr) {
  return (
    `Today is ${dateStr}. That is the real current date, later than your training data, ` +
    "so use the web_search tool for everything recent and trust dated search results over your own memory. " +
    "If a search comes back thin, search again with broader or different queries (by country, institution, or " +
    "indicator) and widen the window to the last 72 hours. If you still cannot verify every requested item, " +
    "publish the items you can verify in the requested format and add one closing line saying how many are missing. " +
    "Never reply with only an apology, a refusal, or a list of options."
  );
}

const REFUSAL_RETRY_NOTE =
  "Your previous attempt returned no briefing. Run several web searches now (for example: central bank decisions " +
  "this week, latest CPI / GDP / PMI releases, major market moves today) and write the briefing from what you find. " +
  "Partial coverage is acceptable; an apology or a menu of options is not.";

/**
 * Whether a generation is a refusal rather than a briefing: nothing at all,
 * or an uncited answer that opens by apologising or saying it can't. A real
 * briefing cites its searches and never opens like that, and custom prompts
 * in any format pass, since only the opening is read.
 */
function looksLikeRefusal(content, sources) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return true;
  if (Array.isArray(sources) && sources.length) return false;
  const opening = text.slice(0, 300);
  return /\b(?:I['’]m sorry|I am sorry|I apologi[sz]e|I can(?:not|['’]t)|I(?:['’]m| am) (?:unable|not able)|unable to (?:reliably )?(?:produce|provide|generate|verify|access|find|compile))\b/i.test(
    opening
  );
}

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

function midnightFromDateKey(dateKey) {
  const parts = String(dateKey || "").split("-").map((part) => parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whole calendar days between two YYYY-MM-DD keys, in the server's own
 * timezone — which is the timezone formatDateKey() writes them in. Rounding
 * absorbs the hour a DST change adds to or removes from a day.
 */
function calendarDaysBetween(fromKey, toKey) {
  const from = midnightFromDateKey(fromKey);
  const to = midnightFromDateKey(toKey);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function addCalendarDays(dateKey, days) {
  const from = midnightFromDateKey(dateKey);
  if (!from) return formatDateKey(new Date(Date.now() + msUntilNextDay()));
  return formatDateKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
}

/**
 * The requested refresh frequency, expressed as whole calendar days between
 * two generations of the same desk.
 *
 * The gate is deliberately a calendar-day one rather than a rolling window:
 * "Daily" has to mean a briefing made at 11pm can be remade the next morning,
 * which a rolling 24 hours would refuse. A sub-day TTL floors at one day, so
 * shortening the TTL can never open up repeat spending on the same desk.
 */
function cooldownDays(ttlMs) {
  const days = Math.round((ttlMs || DEFAULT_TTL_MS) / (24 * 60 * 60 * 1000));
  return Math.max(days, 1);
}

/**
 * Whether a stored generation still holds its desk's slot.
 *
 * `days` is the cooldown: 1 means "generated today", 2 means "generated today
 * or yesterday", and so on. This is what makes the Every 2 Days setting mean
 * something — the gate used to be hardcoded to the calendar day, so every
 * refresh frequency collapsed to the same once-a-day behaviour and a 48-hour
 * setting regenerated (and paid) daily anyway.
 *
 * An entry dated in the future (a clock that moved backwards) does not hold
 * the slot, matching the old check, which only ever recognised today.
 */
function isWithinCooldown(entry, days) {
  if (!entry) return false;
  const dayKey = logEntryDayKey(entry);
  if (!dayKey) return false;
  const elapsed = calendarDaysBetween(dayKey, formatDateKey());
  if (elapsed === null || elapsed < 0) return false;
  return elapsed < Math.max(days, 1);
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

/**
 * The house style every generation is written in, sent with the instructions
 * so the four desks and any custom prompt (the website's crypto-news prompt,
 * the prompt library) sound like one newsroom. The desk prompts below only
 * say what to cover. Their `**#N … — …**` heading is load-bearing: Today's
 * Top 10 and the desk pages split stories on it (splitStories in
 * daily-top-news.js).
 */
const HOUSE_STYLE = `House style (where a request sets its own format or tone, the request wins):
- Write like a sharp wire-desk editor briefing traders before the open: fast, specific, alive.
- Rank by impact: #1 is the story a reader most needs today.
- Headlines carry the news itself, with the number, name or move in them.
  Good: "Fed holds at 4.25%, Powell keeps December cut on the table". Bad: "Fed decision announced".
- Lead each first bullet with the hardest fact: a figure, a name, a change versus before.
- Active verbs. No filler ("amid", "in a move that", "it remains to be seen", "investors will be watching").
- One idea per bullet, one line per bullet, 20 words at most.
- Facts are what sources reported; label anything else as analysis. Never invent a figure; drop it instead.
- Plain hyphen bullets only, no tables.
- Keep the whole brief under 3,000 characters, not counting source links: it is posted to Telegram as one message.`;

function cryptoPrompt(dateStr) {
  return `🗓️ ${dateStr}
🚀 TOP 10 EMERGING / TRENDING CRYPTO TOKENS

Find the 10 crypto tokens with the most real momentum right now: fresh listings, volume spikes, a live narrative, or a catalyst people are talking about. Skip the mega-caps unless something new is moving them.

Open with one line before #1: **The tape:** what is driving the rotation today, in one sentence.

Then exactly 10 items:
**#[N] [EMOJI] [TOKEN] ([TICKER]) — [CHAIN / SECTOR]: [what is happening, with the number]**
- 🔥 Why now: the catalyst, with a figure (volume, % move, listing, TVL)
- 👀 Signal: the on-chain, social or market data behind it
- ⚠️ Risk: the honest catch (thin liquidity, unlocks, hype only), or "none flagged"

Pick an [EMOJI] that fits the sector (🤖 AI, 🎮 gaming, 🐸 meme, 🏦 DeFi, ⛓️ L1/L2, 💵 stablecoin, 🖼️ NFT).
This is a radar, not advice: no buy/sell calls, no price targets.`;
}

function economicsPrompt(dateStr) {
  return `🗓️🌍 ${dateStr}
💹 TOP 10 GLOBAL ECONOMIC DEVELOPMENTS (LAST 24-48 HOURS)

Search for the economic news that moved or will move markets in the last 24-48 hours: central bank decisions and speeches, official data releases, big moves in bonds, FX and commodities, trade and tariff shifts, and forecast revisions from the IMF, World Bank, OECD and similar.

Make it global: cover the US, Eurozone, China, UK and Japan, plus at least one from India, Brazil, Korea or another emerging economy. No more than 3 items on any one country. When more than 10 compete, central banks beat data, data beats market moves, and market moves beat forecasts.

Open with one line before #1: **The big picture:** the single thread running through today's economy, in one sentence.

Then exactly 10 items:
**#[N] [EMOJI] [COUNTRY/REGION] — [headline with the number in it]**
- The fact: for data, actual vs. expected (and prior); for policy, the decision and the vote or wording that changed
- Why it matters: who feels it (borrowers, exporters, the currency, the next rate decision)
- Next: the date or event that settles it, if known · Tone: 🟢 supportive / 🔴 restrictive / ⚪ neutral for growth

Pick an [EMOJI] for the kind of story (🏦 central bank, 📊 data release, 💱 FX, 🛢️ energy/commodities, 🚢 trade, 📉 markets, 🧾 fiscal).`;
}

function geopoliticsPrompt(dateStr) {
  return `🗓️🌍 ${dateStr}
🛰️ TOP 10 GEOPOLITICAL DEVELOPMENTS (LAST 24-48 HOURS)

Search for verified geopolitical developments from the last 24-48 hours and rank the 10 that matter most: active conflicts and ceasefires, sanctions and export controls, diplomacy and summits, alliance and defense moves, energy-security and shipping disruptions, and elections or government decisions with consequences beyond their borders.

Keep it globally balanced: no region gets more than 3 items, and one event appears once however many outlets covered it.

Open with one line before #1: **The world today:** the development that changes the most, in one sentence.

Then exactly 10 items:
**#[N] [EMOJI] [REGION] — [headline that says what changed]**
- What happened: who did what, where, with numbers (casualties, troops, tariffs, barrels, votes) where reported
- Why it matters: the consequence beyond the headline (supply chains, energy, alliances, the next escalation step)
- Watch: the next deadline, meeting, vote or red line

Pick an [EMOJI] for the kind of story (⚔️ conflict, 🕊️ ceasefire/talks, 🚫 sanctions, 🛡️ defense, ⚡ energy, 🚢 shipping, 🗳️ election, 🤝 diplomacy).
Report, don't predict: no market calls, and mark analysis as analysis.`;
}

function marketsPrompt(dateStr) {
  return `🗓️ ${dateStr}
📈 TOP 10 GLOBAL MARKETS BRIEF (LAST 24-48 HOURS)

Search for the market stories of the last 24-48 hours that a trader needs before the open. Mix asset classes: stocks and indices, single-name movers on earnings or news, FX, commodities, bonds and rates, and the central-bank or macro news that moved them. At least 4 stories must be about stocks or indices.

Open with one line before #1: **The tape:** risk-on or risk-off today and the one reason why, in one sentence.

Then exactly 10 items:
**#[N] [EMOJI] [ASSET/TICKER] — [headline with the move in it, e.g. "NVDA +6% on record data-center sales"]**
- The move: price or % change and the reason, as reported
- Why it matters: what it says about the market, a sector, or the next trade
- Assets: the tickers, pairs, indices or contracts affected · Sentiment: 🟢 Bullish / 🔴 Bearish / ⚪ Neutral

Pick an [EMOJI] for the asset class (📈 equities, 💱 FX, 🛢️ energy, 🥇 metals, 🏛️ bonds/rates, 🏦 central banks, 💻 tech).
No buy/sell advice or price targets.`;
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
    // Make every generation call web_search at least once. Cleared for the
    // process if the model refuses a forced tool call.
    this._forceSearch = true;
  }

  /**
   * The in-flight/per-day key a generation loads under.
   *
   * Keyed by calendar day rather than by an epoch-aligned `now / ttlMs`
   * bucket, so it lines up with the cooldown gate in generateReport(). Those
   * buckets did not: a report made at 11pm and a regeneration at 1am the next
   * day fall in the same bucket, so a request the gate had just allowed was
   * served the previous entry instead — no new content, no new log entry, and
   * nothing saying why. Sharing the day keeps the two answers identical, and
   * still collapses the duplicate requests a cycle fan-out makes.
   *
   * `ttlMs` no longer appears in the key: how far apart two generations have
   * to be is the gate's job, not the cache's.
   */
  _cacheKey(ttlMs, section, promptKey = "default") {
    return `reporter:v4:${section}:${promptKey}:${formatDateKey()}`;
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

  async _requestGeneration(input) {
    const request = {
      model: this._model,
      instructions: `${SYSTEM_PROMPT}\n\n${HOUSE_STYLE}\n\n${groundingInstructions(formatDate())}`,
      tools: [{ type: "web_search" }],
      input,
    };
    if (this._forceSearch) request.tool_choice = "required";
    let res;
    try {
      res = await this._client.responses.create(request);
    } catch (err) {
      // Only a model that rejects a forced tool call is worth retrying
      // without one; every other failure is the caller's to handle.
      const status = err?.status || err?.statusCode;
      if (!request.tool_choice || status !== 400 || !/tool_choice/i.test(err?.message || "")) throw err;
      this._forceSearch = false;
      delete request.tool_choice;
      res = await this._client.responses.create(request);
    }
    return { content: res.output_text || "", sources: extractSources(res) };
  }

  /**
   * One generation, made to search, and never a stored refusal.
   *
   * A desk that answered with an apology instead of a briefing used to be
   * saved as that day's report, which also held the desk's daily slot, so the
   * refusal stayed on screen until tomorrow. A refusal is asked again once
   * with a firmer instruction; if it refuses again the call fails, nothing is
   * cached or logged, and the desk can be run again straight away.
   */
  async _generate(prompt) {
    const first = await this._requestGeneration(prompt);
    if (!looksLikeRefusal(first.content, first.sources)) return first;
    const second = await this._requestGeneration(`${prompt}\n\n${REFUSAL_RETRY_NOTE}`);
    if (!looksLikeRefusal(second.content, second.sources)) return second;
    throw Object.assign(
      new Error(
        "The model answered without a briefing (it reported no usable live search results). " +
          "Nothing was saved; run the desk again in a few minutes."
      ),
      { status: 502, expose: true, code: "unusable_generation" }
    );
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
    // How far apart two generations of this desk have to be. It comes from the
    // caller's ttlHours, which is the dashboard's Refresh Frequency setting.
    const cooldown = cooldownDays(resolvedTtl);
    const existingReport = this._buildReport(resolvedTtl);
    const existingGeneratedAt = existingReport.generatedAtBySection && existingReport.generatedAtBySection[section];
    // A stored refusal never holds the desk's slot: the desk page flags it and
    // offers a rerun, and that rerun has to actually run.
    const loggedRecently = this._readLog().find(
      (entry) =>
        entry &&
        entry.section === section &&
        isWithinCooldown(entry, cooldown) &&
        !looksLikeRefusal(entry.content, entry.sources)
    );
    const existingHolds =
      existingReport[section] &&
      !looksLikeRefusal(existingReport[section], []) &&
      isWithinCooldown({ generatedAt: existingGeneratedAt }, cooldown);
    if (existingHolds || loggedRecently) {
      const fallback = loggedRecently
        ? { ...existingReport, [section]: existingReport[section] || loggedRecently.content }
        : existingReport;
      const heldSince = (loggedRecently && logEntryDayKey(loggedRecently))
        || logEntryDayKey({ generatedAt: existingGeneratedAt })
        || formatDateKey();
      return {
        ...fallback,
        generatedSection: section,
        generationSkipped: true,
        generationSkippedReason: cooldown === 1 ? "already-generated-today" : "within-refresh-window",
        refreshCooldownDays: cooldown,
        // The section already exists, so a cycle that lands here reuses it
        // rather than paying to remake it. These describe the entry being
        // reused — including the cycle that first produced it, when there was
        // one — so the reuse stays traceable.
        reusedGeneratedAt: (loggedRecently && loggedRecently.generatedAt) || existingGeneratedAt || null,
        reusedCycleId: (loggedRecently && loggedRecently.cycleId) || null,
        reusedModel: (loggedRecently && loggedRecently.model) || null,
        nextGenerationDate: addCalendarDays(heldSince, cooldown),
      };
    }

    const existingCooldown = this._rateLimitedUntil.get(section) || 0;
    if (existingCooldown > Date.now()) {
      return this._withRateLimit(this._buildReport(resolvedTtl), section, existingCooldown);
    }

    // Today's slot may still cache a refusal saved before refusals were
    // rejected; drop it so this run makes a new generation instead of
    // returning the same apology.
    const slotted = this._cache.get(key);
    if (slotted && looksLikeRefusal(slotted.content, slotted.sources)) this._cache.delete(key);

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
  cooldownDays,
  isWithinCooldown,
  SECTION_LABELS,
  extractSources,
  looksLikeRefusal,
  GENERATION_REFERENCE_MISSING,
  GENERATION_REFERENCE_AMBIGUOUS,
  GENERATION_REFERENCE_INVALID,
};
