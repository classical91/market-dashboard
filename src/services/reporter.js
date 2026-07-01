const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const REPORT_SECTIONS = ["crypto", "economics", "markets"];
const SECTION_LABELS = {
  crypto: "Emerging Small Cap",
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

function normalizeSection(section) {
  return REPORT_SECTIONS.includes(section) ? section : "crypto";
}

function cryptoPrompt(dateStr) {
  return `🗓️ ${dateStr}
🚨 TOP 10 EMERGING CRYPTO TOKENS REPORTER 🚨
Search the web for crypto tokens showing early momentum in the last 24-72 hours. Focus on tokens that are beginning to gain traction before they become obvious mainstream trends.
PRIORITIZE TOKENS WITH:
- Rising trading volume
- Fresh Dexscreener / DEXTools / CoinGecko / CoinMarketCap activity
- New CEX or DEX listings
- Whale or smart-money accumulation
- Fast holder growth
- Liquidity additions
- Strong social momentum on X, Telegram, Discord, Reddit, or crypto news
- Strong current narratives such as AI, RWA, DePIN, gaming, memecoins, Solana, Base, ETH L2s, Bitcoin ecosystem, or new chain launches
FILTER OUT:
- Obvious old large caps unless there is a fresh catalyst
- Tokens with no reliable source trail
- Pure hype with no volume, liquidity, or catalyst
- Suspicious contracts, fake volume, extreme insider concentration, or rug-risk patterns
FORMAT RULES:
- Output EXACTLY 10 tokens.
- Each item must begin with a bold numbered heading:
  **#[N] [TOKEN NAME] ([TICKER]) — [CHAIN / NARRATIVE]**
- Use only simple hyphen bullets.
- Keep each item max 6 lines total including heading.
- No long paragraphs.
- Do not give financial advice or buy/sell instructions.
FOR EACH TOKEN INCLUDE:
- Why it is emerging now
- Key traction signal: volume, listing, holders, social momentum, whale activity, or catalyst
- Risk check: liquidity, contract risk, insider supply, fake volume, unlocks, or hype-only risk
- Watch status: Watchlist Only / High Risk / Medium Conviction / Strong Emerging Candidate
STYLE:
Make it dashboard-ready, concise, useful for traders, and focused on early signals rather than tokens that are already everywhere.`;
}

function economicsPrompt(dateStr) {
  return `🗓️🌏 ${dateStr}
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
  if (section === "economics") return economicsPrompt(dateStr);
  if (section === "markets") return marketsPrompt(dateStr);
  return cryptoPrompt(dateStr);
}

class ReporterService {
  constructor({ cache, apiKey, telegramService }) {
    this._cache = cache;
    this._apiKey = apiKey;
    this._client = apiKey ? new OpenAI({ apiKey }) : null;
    this._telegram = telegramService || null;
    this._logFile = path.join(process.cwd(), "data", "reporter-generation-log.json");
  }

  _cacheKey(ttlMs, section) {
    const period = Math.floor(Date.now() / ttlMs);
    return `reporter:v2:${section}:${ttlMs}:${period}`;
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

  _buildReport(ttlMs) {
    const report = {
      configured: true,
      generated: false,
      sections: REPORT_SECTIONS,
      generationLog: this._readLog(),
    };

    REPORT_SECTIONS.forEach((section) => {
      const cached = this._cache.get(this._cacheKey(ttlMs, section));
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
      model: "gpt-5.5",
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
  async generateReport(ttlMs, requestedSection) {
    if (!this._client) {
      return { configured: false };
    }

    const resolvedTtl = ttlMs || DEFAULT_TTL_MS;
    const section = normalizeSection(requestedSection);
    const key = this._cacheKey(resolvedTtl, section);
    let created = false;

    await this._cache.getOrLoad(key, resolvedTtl, async () => {
      created = true;
      const dateStr = formatDate();
      const generatedAt = new Date().toISOString();
      const content = await this._generate(promptForSection(section, dateStr));
      return {
        section,
        label: SECTION_LABELS[section],
        generatedAt,
        dateStr,
        content,
      };
    });

    const report = this._buildReport(resolvedTtl);
    report.generatedSection = section;

    if (created) {
      this._logGeneration({
        section,
        label: SECTION_LABELS[section],
        generatedAt: report.generatedAtBySection && report.generatedAtBySection[section],
        dateStr: report.dateStr,
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
