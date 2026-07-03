const { createServiceError } = require("../utils/errors");

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MSG_LEN = 4096;
const MAX_CAPTION_LEN = 1024;
const AI_ANALYSIS_TELEGRAM_WORD_LIMIT = 150;
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

function visibleTextForWordCount(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\*\*/g, "");
}

function countWords(text) {
  const trimmed = visibleTextForWordCount(text).trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function truncateWords(text, maxWords) {
  const source = String(text || "");
  if (maxWords <= 0) return "";
  let count = 0;
  let end = 0;
  const wordPattern = /\S+/g;
  let match;
  while ((match = wordPattern.exec(source))) {
    count += 1;
    if (count === maxWords) {
      end = wordPattern.lastIndex;
      break;
    }
  }
  if (count < maxWords || !wordPattern.exec(source)) return source;
  return source.slice(0, end).trimEnd();
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

// Repair the common paste mistakes that produce a 404 from Telegram: a
// leading "bot" copied from the API URL path, surrounding quotes, and stray
// whitespace/newlines. A real token always starts with the numeric bot id,
// so stripping a "bot" prefix can never break a valid token.
function sanitizeBotToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^bot/i, "")
    .trim();
}

class TelegramService {
  constructor({ botToken, chatIds }) {
    this._botToken = sanitizeBotToken(botToken);
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
    const headerWordCount = countWords(header);
    const bodyWordLimit = Math.max(0, AI_ANALYSIS_TELEGRAM_WORD_LIMIT - headerWordCount);
    const body = formatForTelegram(truncate(truncateWords(result.analysis || "", bodyWordLimit), budget));
    const message = header + body;

    if (result.chartUrl) {
      await this._sendPhotoToAll(result.chartUrl, message);
    } else {
      await this._sendToAll(message);
    }
  }

  /**
   * Read-only health report: verifies the token against getMe and each
   * configured chat against getChat, so a misconfigured deploy can be
   * debugged from /api/telegram/diagnose without reading server logs.
   * Never sends a message and never reveals the token secret — only the
   * public bot-id prefix and length, enough to spot a paste error.
   */
  async diagnose() {
    const report = {
      tokenPresent: Boolean(this._botToken),
      // The part before ":" is the public bot id (visible in getMe anyway);
      // exposing it plus the total length helps spot truncation or swaps.
      tokenBotId: this._botToken.split(":")[0] || null,
      tokenLength: this._botToken.length,
      targets: [],
    };

    if (!this._botToken) {
      report.tokenValid = false;
      report.tokenError = "TELEGRAM_BOT_TOKEN is not set";
      return report;
    }

    try {
      const res = await fetch(`${TELEGRAM_API}/bot${this._botToken}/getMe`);
      const data = await res.json().catch(() => null);
      report.tokenValid = Boolean(res.ok && data?.ok);
      if (report.tokenValid) {
        report.bot = { id: data.result.id, username: data.result.username };
      } else {
        report.tokenError = data?.description || `getMe HTTP ${res.status}`;
      }
    } catch (err) {
      report.tokenValid = false;
      report.tokenError = err.message;
    }

    for (const target of this._chatIds) {
      const info = { chatId: target.chatId, threadId: target.threadId || null };
      if (report.tokenValid) {
        try {
          const res = await fetch(
            `${TELEGRAM_API}/bot${this._botToken}/getChat?chat_id=${encodeURIComponent(target.chatId)}`,
          );
          const data = await res.json().catch(() => null);
          info.ok = Boolean(res.ok && data?.ok);
          if (info.ok) {
            info.title = data.result?.title || null;
            info.isForum = Boolean(data.result?.is_forum);
          } else {
            info.error = data?.description || `getChat HTTP ${res.status}`;
          }
        } catch (err) {
          info.ok = false;
          info.error = err.message;
        }
      } else {
        info.ok = false;
        info.error = "skipped: token invalid";
      }
      report.targets.push(info);
    }

    return report;
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

module.exports = { TelegramService, AI_ANALYSIS_TELEGRAM_WORD_LIMIT, countWords };
