"use strict";

/**
 * BroadcastIngestService
 *
 * Watches the Telegram channels the dashboard's bot already posts to and
 * writes a broadcast receipt for the posts it can see.
 *
 * IMPORTANT — what it cannot see: Telegram never returns a bot's own outgoing
 * messages through getUpdates. Anything sent with THIS bot token is therefore
 * invisible to the watch no matter how it is configured. That covers the iOS
 * Shortcut and ShareBot67 whenever they send through this same bot, and it is
 * a protocol limit, not a misconfiguration.
 *
 * So the watch covers posts from OTHER senders — a human typing into the
 * channel, another bot, a different account. Anything going out through this
 * bot has to record itself, which is what POST /api/broadcast-ledger/broadcast
 * is for: it sends and writes the receipt in one call, from the real
 * sendMessage response.
 *
 * It does not replace the paths reporting for themselves. A receipt written
 * by the sender knows things a watcher cannot — the canonical source URL, a
 * pending state before the send, which destinations failed. The watcher is
 * the floor: whatever else happens, a story that reached the channel is on
 * the ledger.
 *
 * Two things keep it from creating duplicates:
 *   - A post whose (chat, message) is already recorded is skipped outright,
 *     which covers the dashboard's own broadcasts coming back as updates.
 *   - Otherwise the normal dedupe runs, and a post matching an existing
 *     receipt attaches its message ID to that receipt rather than forking it.
 *
 * Only one consumer may poll a given bot token: a second one gets 409 from
 * Telegram. That is fine here because the dashboard's bot is otherwise
 * send-only, but it is why a 409 is reported as a configuration problem
 * rather than retried.
 */

const STATE_KEY = "broadcastIngest:offset";
const WATCHLIST_STATE_KEY = "broadcastIngest:watchTargets";
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WATCHLIST_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const MAX_TITLE_LEN = 300;
const DEFAULT_INTERVAL_MS = 60 * 1000;

function normalizeWatchTarget(entry) {
  if (entry && typeof entry === "object") {
    const chatId = String(entry.chatId ?? "").trim();
    const threadId = entry.threadId == null || String(entry.threadId).trim() === ""
      ? null
      : String(entry.threadId).trim();
    return chatId ? { chatId, threadId } : null;
  }
  const [chatId, threadId] = String(entry || "").split(":").map((part) => part.trim());
  return chatId ? { chatId, threadId: threadId || null } : null;
}

function targetKey(target) {
  return `${target.chatId}:${target.threadId || ""}`;
}

// Telegram sends HTML/Markdown as literal text plus entity offsets. The
// title only needs to read like a headline, so strip the obvious markup
// rather than reconstructing entities.
function stripMarkup(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    .trim();
}

/**
 * A date/emoji banner — "🗓️ 19 AUG" — carries no headline, so a post that
 * opens with one has its real title on the next line. Detected by what is
 * left after dropping emoji, punctuation and digits: a banner has at most one
 * actual word, while even a terse headline ("Bitcoin crashes") has two.
 * Deliberately not a length test — plenty of real headlines are short.
 */
function looksLikeBanner(line) {
  const words = line.match(/\p{L}{2,}/gu) || [];
  return words.length < 2;
}

/** First line with real words in it — that is the headline in practice. */
function deriveTitle(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => stripMarkup(line))
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  if (!lines.length) return "";
  const headline = lines.find((line) => !looksLikeBanner(line)) || lines[0];
  return headline.slice(0, MAX_TITLE_LEN);
}

function firstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"')]+/);
  return match ? match[0] : "";
}

class BroadcastIngestService {
  constructor({
    telegramService,
    broadcastLedgerStore,
    stateCache,
    enabled = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    watchTargets = null,
    logger = console,
  } = {}) {
    this._telegram = telegramService;
    this._store = broadcastLedgerStore;
    this._stateCache = stateCache;
    this._enabledFlag = Boolean(enabled);
    this._intervalMs = Math.max(Number(intervalMs) || DEFAULT_INTERVAL_MS, 15_000);
    this._logger = logger;
    this._timer = null;
    this._conflictReported = false;
    // Diagnostics. A watch that is running but recording nothing is the hard
    // case to debug — the causes (wrong chat, a conflict, a bot that cannot
    // read the chat) are invisible from the ledger alone, so keep enough
    // state to tell them apart.
    this._startedAt = null;
    this._lastPollAt = null;
    this._lastSummary = null;
    this._lastError = null;
    // Chats posts actually arrived from that are NOT being recorded. If this
    // is non-empty while nothing is landing, TELEGRAM_CHAT_IDS points
    // somewhere other than where the news is going.
    this._unwatchedTargets = new Set();
    // Keep ingest selection independent from sending. Legacy configuration
    // inherits the exact send targets, including topic ids; it never widens a
    // topic destination to the whole supergroup.
    const sendTargets = telegramService && telegramService._chatIds ? telegramService._chatIds : [];
    const storedTargets = stateCache ? stateCache.get(WATCHLIST_STATE_KEY) : null;
    // An explicit environment watchlist is the operator's current source of
    // truth. Previously, an older UI-saved selection in the persistent cache
    // silently overrode later Railway configuration, leaving newly added
    // rooms unwatched after every deploy.
    const selected = watchTargets !== null
      ? watchTargets
      : Array.isArray(storedTargets)
        ? storedTargets
        : sendTargets;
    this._availableTargets = sendTargets.map(normalizeWatchTarget).filter(Boolean);
    this._watchTargets = selected.map(normalizeWatchTarget).filter(Boolean);
    this._watchedTargetKeys = new Set(this._watchTargets.map(targetKey));
  }

  get enabled() {
    return Boolean(this._enabledFlag && this._telegram && this._telegram.configured);
  }

  setWatchTargets(entries) {
    if (!Array.isArray(entries)) throw Object.assign(new Error("targets must be an array"), { statusCode: 400 });
    const normalized = entries.map(normalizeWatchTarget).filter(Boolean);
    const available = new Set(this._availableTargets.map(targetKey));
    const invalid = normalized.find((target) => !available.has(targetKey(target)));
    if (invalid) {
      throw Object.assign(new Error(`Unknown Telegram destination: ${targetKey(invalid)}`), { statusCode: 400 });
    }
    this._watchTargets = normalized;
    this._watchedTargetKeys = new Set(normalized.map(targetKey));
    if (this._stateCache) this._stateCache.set(WATCHLIST_STATE_KEY, normalized, WATCHLIST_TTL_MS);
    return this.describe();
  }

  start() {
    if (!this.enabled) {
      this._logger.log?.(
        this._enabledFlag
          ? "[BroadcastIngest] Telegram not configured — channel watch disabled"
          : "[BroadcastIngest] Disabled (set BROADCAST_LEDGER_INGEST_ENABLED=true to auto-record channel posts)",
      );
      return;
    }
    if (this._timer) return;
    this._logger.log?.(
      `[BroadcastIngest] Watching ${this._watchedTargetKeys.size} Telegram destination(s) every ${Math.round(
        this._intervalMs / 1000,
      )}s`,
    );
    this._timer = setInterval(() => {
      this.runOnce().catch((err) => this._logger.error?.(`[BroadcastIngest] Poll failed: ${err.message}`));
    }, this._intervalMs);
    if (this._timer.unref) this._timer.unref();
    this._startedAt = new Date().toISOString();
    this.runOnce().catch((err) => this._logger.error?.(`[BroadcastIngest] Initial poll failed: ${err.message}`));
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _offset() {
    const stored = this._stateCache ? this._stateCache.get(STATE_KEY) : null;
    return Number.isFinite(stored) ? stored : undefined;
  }

  _saveOffset(value) {
    if (this._stateCache && Number.isFinite(value)) {
      this._stateCache.set(STATE_KEY, value, STATE_TTL_MS);
    }
  }

  /**
   * Everything needed to answer "the watch is on, so why is nothing landing?"
   * without shell access to the box.
   */
  describe() {
    return {
      enabled: this.enabled,
      configured: Boolean(this._telegram && this._telegram.configured),
      availableTargets: this._availableTargets.map((target) => ({ ...target })),
      watchedTargets: this._watchTargets.map((target) => ({ ...target })),
      unwatchedTargetsSeen: [...this._unwatchedTargets],
      // Compatibility for existing diagnostics clients. Matching is always
      // done with watchedTargets above, never these chat-only summaries.
      watchedChatIds: [...new Set(this._watchTargets.map((target) => target.chatId))],
      unwatchedChatIdsSeen: [...new Set([...this._unwatchedTargets].map((key) => key.split(":")[0]))],
      startedAt: this._startedAt,
      lastPollAt: this._lastPollAt,
      lastSummary: this._lastSummary,
      lastError: this._lastError,
      conflict: this._conflictReported,
      intervalMs: this._intervalMs,
    };
  }

  async runOnce() {
    if (!this.enabled) return { polled: 0, recorded: 0, attached: 0, skipped: 0 };

    this._lastPollAt = new Date().toISOString();
    let updates;
    try {
      updates = await this._telegram.getUpdates({ offset: this._offset() });
    } catch (err) {
      if (err.statusCode === 409) {
        // Another process owns this bot's update stream. Retrying would just
        // fight it, so say it once and keep quiet until it clears.
        if (!this._conflictReported) {
          this._conflictReported = true;
          this._logger.error?.(
            "[BroadcastIngest] Telegram returned 409 Conflict — another process is polling this bot token " +
              "(or a webhook is set). Give the dashboard its own bot, or turn the channel watch off.",
          );
        }
        this._lastError = "409 Conflict — another process is polling this bot token";
        this._lastSummary = { polled: 0, recorded: 0, attached: 0, skipped: 0, conflict: true };
        return { polled: 0, recorded: 0, attached: 0, skipped: 0, conflict: true };
      }
      this._lastError = err.message;
      throw err;
    }
    this._conflictReported = false;
    this._lastError = null;

    // getUpdates already filters to arrays, but a stubbed or future transport
    // could hand back anything; a malformed response is an empty poll, never a
    // crash inside the interval timer.
    if (!Array.isArray(updates)) updates = [];

    const summary = { polled: updates.length, recorded: 0, attached: 0, skipped: 0 };
    let highestUpdateId = null;

    for (const update of updates) {
      if (!update || typeof update !== "object") {
        summary.skipped += 1;
        continue;
      }
      if (Number.isFinite(update.update_id)) {
        highestUpdateId = highestUpdateId === null ? update.update_id : Math.max(highestUpdateId, update.update_id);
      }
      // One unusable update must not take the batch down with it. Without this
      // the throw escaped before the offset was saved, so the same poison
      // update was re-read every interval and every later update behind it
      // stayed unrecorded — a stall that looks exactly like a watch that has
      // simply stopped seeing posts.
      try {
        const outcome = this._ingestPost(update.channel_post || update.message);
        if (outcome === "recorded") summary.recorded += 1;
        else if (outcome === "attached") summary.attached += 1;
        else summary.skipped += 1;
      } catch (err) {
        summary.skipped += 1;
        summary.errors = (summary.errors || 0) + 1;
        this._logger.error?.(
          `[BroadcastIngest] Skipped update ${update.update_id ?? "?"}: ${err.message}`,
        );
      }
    }

    // Advance past everything handled so the same posts are not re-read.
    // Saved after processing, so a crash mid-batch re-reads rather than
    // silently dropping a post — re-reading is free, the ingest is idempotent.
    if (highestUpdateId !== null) this._saveOffset(highestUpdateId + 1);

    this._lastSummary = { ...summary };

    if (summary.recorded || summary.attached) {
      this._logger.log?.(
        `[BroadcastIngest] ${summary.recorded} recorded, ${summary.attached} attached to existing receipts`,
      );
    }
    return summary;
  }

  /** @returns {"recorded"|"attached"|"skipped"} */
  _ingestPost(post) {
    if (!post || !post.chat) return "skipped";

    const chatId = String(post.chat.id);
    const threadId = post.message_thread_id == null ? null : String(post.message_thread_id);
    const incomingKey = targetKey({ chatId, threadId });
    if (!this._watchedTargetKeys.has(incomingKey)) {
      // Remember it: "posts are arriving, just not from the chat you told me
      // to watch" is the single most useful thing to be able to say.
      if (this._unwatchedTargets.size < 20) this._unwatchedTargets.add(incomingKey);
      return "skipped";
    }

    const messageId = post.message_id != null ? String(post.message_id) : "";
    if (!messageId) return "skipped";

    // Already on the ledger under this exact message — including a broadcast
    // the dashboard sent itself and recorded with its message ID.
    if (this._store.hasMessage("telegram", chatId, messageId)) return "skipped";

    const text = typeof post.text === "string" && post.text.trim() ? post.text : post.caption || "";
    if (!String(text).trim()) return "skipped";

    const title = deriveTitle(text);
    const url = firstUrl(text);
    const destination = {
      channel: "telegram",
      chatId,
      threadId,
      status: "posted",
      messageId,
    };

    // A path that reported for itself already holds the better record; give
    // it the message ID rather than writing a second receipt for one story.
    const existing = this._store.lookup({ url, text });
    if (existing.posted && existing.receipt) {
      this._store.updateReceipt(
        existing.receipt.id,
        { destinations: [destination], action: "telegram-ingest" },
        { actor: "telegram-ingest" },
      );
      return "attached";
    }

    if (!title && !url) return "skipped";

    this._store.createReceipt({
      source: "telegram-ingest",
      kind: "story",
      title,
      url,
      text,
      status: "posted",
      // Stable per message: re-reading the same update never forks a receipt.
      idempotencyKey: `telegram:${chatId}:${messageId}`,
      destinations: [destination],
    });
    return "recorded";
  }
}

module.exports = {
  BroadcastIngestService,
  deriveTitle,
  firstUrl,
  stripMarkup,
  looksLikeBanner,
  normalizeWatchTarget,
  targetKey,
};
