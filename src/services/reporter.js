const OpenAI = require("openai");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

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

function cryptoPrompt(dateStr) {
  return `🗓️ ${dateStr}

Create a TOP 10 crypto news brief from the past 24–48 hours.

Rules:
- Output exactly 10 stories.
- For each story include:
  1. Title (short)
  2. Why it matters (1–2 bullets)
  3. Assets affected (tickers)
  4. Sentiment: 🟢 Bullish / 🔴 Bearish / 🟡 Neutral
- Keep each story to max 4 lines total. No long paragraphs.
- Use hyphen bullets only.`;
}

function economicsPrompt(dateStr) {
  return `🗓️🌏 ${dateStr}
💹 TOP 10 GLOBAL ECONOMIC DEVELOPMENTS BRIEF (LAST 24–48 HOURS) 💹

Search for current and verified economic events, indicators, policy moves, market data, or macro developments from the last 24–48 hours and produce a TOP 10 report.

GEOGRAPHIC SCOPE (REQUIRED):
Cover a globally balanced mix across major economies. Prioritize:
- 🇺🇸 United States
- 🇪🇺 Eurozone / EU
- 🇨🇳 China
- 🇬🇧 United Kingdom
- 🇯🇵 Japan
- 🇮🇳 🇧🇷 🇰🇷 or other emerging / major economies (at least 1–2 items)

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
  **#[N] 🏳️ [COUNTRY/REGION] — [HEADLINE TITLE]**
- Use only simple hyphen bullets (-) for sub-details beneath each heading
- Keep each item short and structured (max 6 lines total including heading)
- For data releases, include: DATA + actual vs. expected where relevant
- If uncertain of a specific data point, omit it rather than approximate

GOAL: concise, globally balanced daily economics snapshot.`;
}

function marketsPrompt(dateStr) {
  return `🗓️ ${dateStr}

Create a TOP 10 global markets news brief from the past 24–48 hours.

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
  2. Why it matters (1–2 bullets)
  3. Assets affected (tickers / pairs / indices / contracts)
  4. Sentiment: 🟢 Bullish / 🔴 Bearish / 🟡 Neutral
- Keep each story to max 4 lines total.
- No long paragraphs.
- Use hyphen bullets only.`;
}

class ReporterService {
  constructor({ cache, apiKey, telegramService }) {
    this._cache = cache;
    this._apiKey = apiKey;
    this._client = apiKey ? new OpenAI({ apiKey }) : null;
    this._telegram = telegramService || null;
  }

  _cacheKey(ttlMs) {
    const period = Math.floor(Date.now() / ttlMs);
    return `reporter:v1:${ttlMs}:${period}`;
  }

  async _generate(prompt) {
    const res = await this._client.chat.completions.create({
      model: "gpt-4.5-preview",
      max_tokens: 2048,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    return res.choices[0].message.content;
  }

  async getReport(ttlMs) {
    if (!this._client) {
      return { configured: false };
    }

    const resolvedTtl = ttlMs || DEFAULT_TTL_MS;
    const key = this._cacheKey(resolvedTtl);
    return this._cache.getOrLoad(key, resolvedTtl, async () => {
      const dateStr = formatDate();
      const [crypto, economics, markets] = await Promise.all([
        this._generate(cryptoPrompt(dateStr)),
        this._generate(economicsPrompt(dateStr)),
        this._generate(marketsPrompt(dateStr)),
      ]);
      const report = {
        configured: true,
        generatedAt: new Date().toISOString(),
        dateStr,
        crypto,
        economics,
        markets,
      };
      if (this._telegram) {
        this._telegram.postReport(report).catch((err) => {
          console.error("[Telegram] Failed to post report:", err.message);
        });
      }
      return report;
    });
  }
}

module.exports = { ReporterService };
