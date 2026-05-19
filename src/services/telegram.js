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
