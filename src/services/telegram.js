const { createServiceError } = require("../utils/errors");

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MSG_LEN = 4096;
const MAX_CAPTION_LEN = 1024;
// Leaves headroom below Telegram's hard caption cap for HTML-entity escaping
// (e.g. "&" -> "&amp;") to expand the string a little without tipping it over.
const CAPTION_SAFETY_MARGIN = 100;

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

// A chat target is either a plain chat id ("-1001841650798") or a chat id
// plus a forum "topic" thread within it ("-1001841650798:6297"). Accepting
// both a raw string and an already-parsed {chatId, threadId} object keeps
// this tolerant of how config/env.js hands the list over.
function normalizeTarget(entry) {
  if (entry && typeof entry === "object") return entry;
  const [chatId, threadId] = String(entry || "").split(":").map((part) => part.trim());
  return threadId ? { chatId, threadId } : { chatId };
}

class TelegramService {
  constructor({ botToken, chatIds }) {
    this._botToken = botToken;
    this._chatIds = (chatIds || []).map(normalizeTarget);
  }

  get configured() {
    return !!(this._botToken && this._chatIds.length);
  }

  async _send(target, text) {
    const url = `${TELEGRAM_API}/bot${this._botToken}/sendMessage`;
    const body = {
      chat_id: target.chatId,
      text: truncate(text, MAX_MSG_LEN),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (target.threadId) body.message_thread_id = Number(target.threadId);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const responseBody = await res.text();
      throw createServiceError(`Telegram sendMessage failed (${res.status}): ${responseBody.slice(0, 300)}`, 502);
    }
    return res.json();
  }

  async _sendToAll(text) {
    for (const target of this._chatIds) {
      await this._send(target, text);
    }
  }

  async _sendPhoto(target, photoUrl, caption) {
    const url = `${TELEGRAM_API}/bot${this._botToken}/sendPhoto`;
    const body = {
      chat_id: target.chatId,
      photo: photoUrl,
      caption,
      parse_mode: "HTML",
    };
    if (target.threadId) body.message_thread_id = Number(target.threadId);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const responseBody = await res.text();
      throw createServiceError(`Telegram sendPhoto failed (${res.status}): ${responseBody.slice(0, 300)}`, 502);
    }
    return res.json();
  }

  async _sendPhotoToAll(photoUrl, caption) {
    for (const target of this._chatIds) {
      await this._sendPhoto(target, photoUrl, caption);
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

    // Truncate the *raw* analysis text before converting it to HTML, not
    // after: slicing an already-tagged string (e.g. "...<b>Vol") can cut a
    // tag in half, which makes Telegram's parse_mode=HTML reject the whole
    // message with "can't parse entities" and silently drop the broadcast.
    const maxLen = result.chartUrl ? MAX_CAPTION_LEN : MAX_MSG_LEN;
    const budget = Math.max(0, maxLen - CAPTION_SAFETY_MARGIN - header.length);
    const body = formatForTelegram(truncate(result.analysis || "", budget));
    const message = header + body;

    if (result.chartUrl) {
      await this._sendPhotoToAll(result.chartUrl, message);
    } else {
      await this._sendToAll(message);
    }
  }

  async sendTest(target) {
    await this._send(target, "✅ <b>Market Command</b> — Telegram connection test successful.");
  }

  async testAll() {
    for (const target of this._chatIds) {
      await this.sendTest(target);
    }
  }
}

module.exports = { TelegramService };
