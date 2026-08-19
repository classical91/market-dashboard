"use strict";

/**
 * BroadcastIngestService
 *
 * Watches the Telegram channels the dashboard's bot already posts to and
 * writes a broadcast receipt for every post it sees — whoever sent it.
 *
 * This is what makes the ledger automatic. The three posting paths each had
 * to volunteer a receipt: the shortcut needed an extra action, ShareBot67
 * needed an agent-side change, and a hand-posted story needed the form. But
 * all three end up as a message in the same channel, so watching the channel
 * covers all three at one point instead of three.
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
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_TITLE_LEN = 300;
const DEFAULT_INTERVAL_MS = 60 * 1000;

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
    // Only the chats the dashboard is configured for. A bot can be in other
    // channels; those are not this ledger's business.
    this._watchedChatIds = new Set(
      (telegramService && telegramService._chatIds ? telegramService._chatIds : []).map((target) =>
        String(target.chatId),
      ),
    );
  }

  get enabled() {
    return Boolean(this._enabledFlag && this._telegram && this._telegram.configured);
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
      `[BroadcastIngest] Watching ${this._watchedChatIds.size} Telegram chat(s) every ${Math.round(
        this._intervalMs / 1000,
      )}s`,
    );
    this._timer = setInterval(() => {
      this.runOnce().catch((err) => this._logger.error?.(`[BroadcastIngest] Poll failed: ${err.message}`));
    }, this._intervalMs);
    if (this._timer.unref) this._timer.unref();
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

  async runOnce() {
    if (!this.enabled) return { polled: 0, recorded: 0, attached: 0, skipped: 0 };

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
        return { polled: 0, recorded: 0, attached: 0, skipped: 0, conflict: true };
      }
      throw err;
    }
    this._conflictReported = false;

    const summary = { polled: updates.length, recorded: 0, attached: 0, skipped: 0 };
    let highestUpdateId = null;

    for (const update of updates) {
      if (Number.isFinite(update.update_id)) {
        highestUpdateId = highestUpdateId === null ? update.update_id : Math.max(highestUpdateId, update.update_id);
      }
      const post = update.channel_post || update.message;
      const outcome = this._ingestPost(post);
      if (outcome === "recorded") summary.recorded += 1;
      else if (outcome === "attached") summary.attached += 1;
      else summary.skipped += 1;
    }

    // Advance past everything handled so the same posts are not re-read.
    // Saved after processing, so a crash mid-batch re-reads rather than
    // silently dropping a post — re-reading is free, the ingest is idempotent.
    if (highestUpdateId !== null) this._saveOffset(highestUpdateId + 1);

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
    if (!this._watchedChatIds.has(chatId)) return "skipped";

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
      threadId: post.message_thread_id != null ? String(post.message_thread_id) : null,
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

module.exports = { BroadcastIngestService, deriveTitle, firstUrl, stripMarkup, looksLikeBanner };
