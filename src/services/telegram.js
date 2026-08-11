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

// Safety net for the rare case the model ignores its length instruction —
// cuts at the last word boundary within budget instead of mid-word, so an
// overflow reads as an intentionally shortened message rather than a broken
// one (e.g. "...bullish for crypto m" -> "...bullish for crypto…").
function truncate(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[.,;:!?-]+$/, "") + "…";
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

function formatNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function patternLabel(transition) {
  const direction = transition.to;
  const trend = transition.trendRegime || "MIXED";
  const indicators = transition.indicators || {};
  const checks = direction === "LONG" ? indicators.bullishChecks : indicators.bearishChecks;
  const rsiValue = Number(indicators.rsi);
  const adxValue = Number(indicators.adx);
  const strongTrend = Number.isFinite(adxValue) && adxValue >= 25;
  const resetLong = direction === "LONG" && Number.isFinite(rsiValue) && rsiValue >= 50 && rsiValue <= 62;
  const resetShort = direction === "SHORT" && Number.isFinite(rsiValue) && rsiValue <= 50 && rsiValue >= 38;

  if ((trend === "TREND_UP" && resetLong) || (trend === "TREND_DOWN" && resetShort)) return "trend_pullback";
  if (checks >= 5 && strongTrend) return "momentum_continuation";
  if (indicators.aboveVwap === (direction === "LONG") && indicators.volumeAboveAverage) return "vwap_volume_break";
  return direction === "LONG" ? "bullish_confluence" : direction === "SHORT" ? "bearish_confluence" : "signal_flip";
}

function evidenceLines(transition) {
  const direction = transition.to;
  const i = transition.indicators || {};
  const rows = [];
  const rsiValue = formatNumber(i.rsi, 1);
  const adxValue = formatNumber(i.adx, 1);
  const checks = direction === "LONG" ? i.bullishChecks : i.bearishChecks;

  if (checks != null) rows.push(`${direction === "LONG" ? "Bullish" : "Bearish"} checks ${checks}/6`);
  if (rsiValue) rows.push(`RSI ${rsiValue} ${direction === "LONG" ? "above" : "below"} 50`);
  if (i.macdBullish != null) rows.push(`MACD ${i.macdBullish ? "bullish" : "bearish"}`);
  if (i.aboveVwap != null) rows.push(`Price ${i.aboveVwap ? "above" : "below"} VWAP`);
  if (i.ema20AboveEma50 != null) rows.push(`EMA20 ${i.ema20AboveEma50 ? "above" : "below"} EMA50`);
  if (i.priceAboveEma200 != null) rows.push(`Price ${i.priceAboveEma200 ? "above" : "below"} EMA200`);
  if (i.volumeAboveAverage != null) rows.push(`Volume ${i.volumeAboveAverage ? "above" : "not above"} average`);
  if (adxValue) rows.push(`ADX ${adxValue}`);
  return rows.slice(0, 5);
}

function actionForTransition(actions, transition) {
  return (actions || []).find((action) => (
    action
    && action.symbol === transition.symbol
    && action.interval === transition.interval
    && action.direction === transition.to
  )) || null;
}

function groupSafeReason(reason) {
  return String(reason || "Trading Lab reviewed")
    .replace(/\s*\(paper trading disabled\)/gi, "")
    .replace(/\bwould\s+open\b/gi, "Setup passed review")
    .replace(/\bdry[- ]run\b/gi, "review")
    .replace(/\bpaper\s+trading\b/gi, "trading")
    .replace(/\bpaper\s+trade\b/gi, "tracked setup")
    .replace(/\bpaper\b/gi, "tracked");
}

function groupSafeStatus(status) {
  const normalized = String(status || "checked").toLowerCase();
  if (normalized === "dry-run") return "REVIEW";
  if (normalized === "opened") return "TRACKED";
  return normalized.toUpperCase();
}

function dashboardLink(baseUrl, path) {
  if (!baseUrl) return null;
  return `${String(baseUrl).replace(/\/+$/, "")}${path}?view=alpha`;
}

function formatSignalAlert(transition, actions, dashboardUrl = "") {
  const action = actionForTransition(actions, transition);
  const pattern = patternLabel(transition);
  const price = formatPrice(transition.price);
  const score = transition.score != null ? `${transition.score}%` : "n/a";
  const trend = transition.trendRegime || "MIXED";
  const evidence = evidenceLines(transition).join("; ") || "Confluence flip";
  const verdict = action
    ? `${groupSafeStatus(action.status)}: ${groupSafeReason(action.reason)}`
    : "WATCH: Trading Lab verdict pending";
  const decision = action && action.decision ? `Checklist: ${action.decision}` : null;
  const confidence = action && action.confidenceScore != null ? `Confidence: ${action.confidenceScore}` : null;
  const view = dashboardLink(dashboardUrl, "/signal-screener.html");

  return [
    `<b>SIGNAL</b> | <b>${escapeHtml(transition.symbol)}</b> ${escapeHtml(transition.interval)} | ${escapeHtml(pattern)}`,
    `Bias: <b>${escapeHtml(transition.to)}</b>${price ? ` near ${escapeHtml(price)}` : ""} (${escapeHtml(score)})`,
    `Regime: ${escapeHtml(trend)}`,
    `Evidence: ${escapeHtml(evidence)}`,
    decision || confidence ? [decision, confidence].filter(Boolean).join(" | ") : null,
    `Verdict: ${escapeHtml(verdict)}`,
    view ? `Visit: ${escapeHtml(view)}` : null,
  ].filter(Boolean).join("\n");
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
  constructor({ botToken, chatIds, dashboardUrl = "" }) {
    this._botToken = sanitizeBotToken(botToken);
    this._chatIds = (chatIds || []).map(normalizeTarget);
    this._dashboardUrl = String(dashboardUrl || "").replace(/\/+$/, "");
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
   * One batched message per scan cycle listing every screener signal flip,
   * e.g. "🟢 BTCUSDT · 4h: FLAT → LONG (83%)". Batched because a volatile
   * scan can flip a dozen tokens at once and one message reads far better
   * than a burst of twelve.
   */
  async postSignalAlerts(transitions, tradeActions = []) {
    if (!this.configured || !transitions.length) return;
    const rows = transitions.map((t) => formatSignalAlert(t, tradeActions, this._dashboardUrl));
    const header = "⚡ <b>ALPHA TEAM SIGNALS</b>\n\n";
    await this._sendToAll(truncate(header + rows.join("\n\n"), MAX_MSG_LEN));
  }

  /**
   * One batched message per Pattern Scanner cycle listing new breakouts and
   * fresh divergences, e.g. "⚡ BTCUSDT · 4h: Falling Wedge → Breakout (62)"
   * or "🔀 ETHUSDT · 1D: Regular Bullish Divergence (RSI)".
   */
  async postPatternAlerts(events) {
    if (!this.configured || !events.length) return;
    const view = dashboardLink(this._dashboardUrl, "/pattern-scanner.html");
    const rows = events.map((e) => {
      const biasEmoji = e.bias === "bullish" ? "🟢" : "🔴";
      if (e.kind === "breakout") {
        const bias = e.bias === "bullish" ? "LONG watch" : "SHORT watch";
        return [
          `${biasEmoji} <b>WATCH</b> | <b>${escapeHtml(e.symbol)}</b> ${escapeHtml(e.interval)} | ${escapeHtml(e.name)} breakout`,
          `Bias: ${escapeHtml(bias)} (${escapeHtml(String(e.score ?? "n/a"))})`,
          "Evidence: pattern moved from forming to breakout",
          "Verdict: watch for confirmation; act only after checklist/edge gate",
          view ? `Visit: ${escapeHtml(view)}` : null,
        ].filter(Boolean).join("\n");
      }
      const bias = e.bias === "bullish" ? "bullish reversal watch" : "bearish reversal watch";
      return [
        `${biasEmoji} <b>WATCH</b> | <b>${escapeHtml(e.symbol)}</b> ${escapeHtml(e.interval)} | ${escapeHtml(e.name)} divergence`,
        `Bias: ${escapeHtml(bias)}`,
        "Evidence: fresh divergence state detected",
        "Verdict: watch for structure confirmation; no automatic action",
        view ? `Visit: ${escapeHtml(view)}` : null,
      ].filter(Boolean).join("\n");
    });
    const header = "📈 <b>PATTERN SCANNER</b>\n\n";
    await this._sendToAll(truncate(header + rows.join("\n\n"), MAX_MSG_LEN));
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
