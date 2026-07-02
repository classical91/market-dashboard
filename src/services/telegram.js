const TELEGRAM_API = "https://api.telegram.org";
const MAX_MSG_LEN = 4096;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatForTelegram(raw) {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

class TelegramService {
  constructor({ botToken, chatIds }) {
    this._botToken = botToken;
    this._chatIds = chatIds; // string[]
  }

  get configured() {
    return !!(this._botToken && this._chatIds.length);
  }

  async _send(chatId, text) {
    const url = `${TELEGRAM_API}/bot${this._botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncate(text, MAX_MSG_LEN),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram ${res.status}: ${body}`);
    }
    return res.json();
  }

  async _sendToAll(text) {
    for (const chatId of this._chatIds) {
      await this._send(chatId, text);
    }
  }

  async _sendPhoto(chatId, photoUrl, caption) {
    const url = `${TELEGRAM_API}/bot${this._botToken}/sendPhoto`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram ${res.status}: ${body}`);
    }
    return res.json();
  }

  async _sendPhotoToAll(photoUrl, caption) {
    for (const chatId of this._chatIds) {
      await this._sendPhoto(chatId, photoUrl, caption);
    }
  }

  async postReport(report) {
    if (!this.configured) return;

    const date = report.dateStr || "";
    const sections = [
      { emoji: "₿", title: "CRYPTO TOP 10", key: "crypto" },
      { emoji: "🌍", title: "ECONOMICS TOP 10", key: "economics" },
      { emoji: "📊", title: "MARKETS TOP 10", key: "markets" },
    ];

    for (const s of sections) {
      const body = formatForTelegram(report[s.key] || "");
      const header = `<b>${s.emoji} ${s.title}</b>\n🗓️ ${escapeHtml(date)}\n\n`;
      await this._sendToAll(header + body);
    }
  }

  async postAIAnalysis(result) {
    if (!this.configured) return;

    const verdictEmoji = { BUY: "🟢", SELL: "🔴", HOLD: "🟡" }[result.verdict] || "⚪";
    const header = `${verdictEmoji} <b>${escapeHtml(result.label || result.symbol || "")}</b> · ${escapeHtml(
      result.interval || "",
    )} — <b>${escapeHtml(result.verdict || "NO CALL")}</b>\n\n`;
    const body = formatForTelegram(result.analysis || "");
    // Telegram photo captions are capped at 1024 chars (vs 4096 for text messages).
    const caption = truncate(header + body, 1024);

    if (result.chartUrl) {
      await this._sendPhotoToAll(result.chartUrl, caption);
    } else {
      await this._sendToAll(truncate(header + body, MAX_MSG_LEN));
    }
  }

  async sendTest(chatId) {
    await this._send(chatId, "✅ <b>Market Command</b> — Telegram connection test successful.");
  }

  async testAll() {
    for (const chatId of this._chatIds) {
      await this.sendTest(chatId);
    }
  }
}

module.exports = { TelegramService };
