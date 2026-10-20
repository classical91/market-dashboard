"use strict";

/**
 * XBroadcastChannelStore
 *
 * The Telegram rooms the X Intelligence Broadcast button offers, editable from
 * the Settings page.
 *
 * X_BROADCAST_CHANNELS (or TELEGRAM_CHAT_IDS behind it) stays the default:
 * until someone saves a list here the picker offers exactly what the
 * environment names, so an existing deploy changes nothing. Once a list is
 * saved, that file is what the picker and the send route read — renaming a
 * room or adding a topic no longer needs a redeploy. Reset deletes the file
 * and hands control back to the environment.
 *
 * Only this button reads it. The reporter auto-post, the ledger's finance
 * route and news routing keep their own TELEGRAM_CHAT_IDS handling, so editing
 * the X picker cannot redirect a briefing.
 *
 * Persistence follows the same idiom as the other stores here (see
 * x-account-registry.js): one JSON file under DATA_DIR, rewritten whole under
 * an exclusive lock via an atomic rename.
 *
 * File shape:
 *   { "version": 1, "updatedAt": "...", "channels": [ { label, chatId, threadId } ] }
 *
 * An empty saved list means exactly that: offer nothing. Falling back to the
 * environment instead would make removing the last room silently a no-op.
 * The environment is only served when the file itself cannot be trusted.
 */

const fs = require("fs");
const path = require("path");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { MAX_CHANNELS, channelId, parseChannelsJson } = require("./x-broadcast-channels");
const { createServiceError } = require("../utils/errors");

const STORE_VERSION = 1;
const MAX_LABEL_LEN = 60;
// A numeric chat id (groups and channels are negative) or a public
// @channelusername — the two forms the Bot API accepts as chat_id.
const CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const THREAD_ID_PATTERN = /^\d{1,12}$/;

/**
 * Validates one row. Throws a 400-shaped error rather than saving anything the
 * Bot API would reject: a bad row is a room that fails on every broadcast.
 */
function normalizeChannelInput(input, index) {
  const where = `Channel ${index + 1}`;
  const chatId = String(input?.chatId == null ? "" : input.chatId).trim();
  if (!chatId) throw createServiceError(`${where}: a chat id is required`, 400);
  if (!CHAT_ID_PATTERN.test(chatId)) {
    throw createServiceError(
      `${where}: "${chatId}" is not a Telegram chat id (e.g. -1001841650798 or @channelname)`,
      400,
    );
  }

  const threadId = String(input?.threadId == null ? "" : input.threadId).trim();
  if (threadId && !THREAD_ID_PATTERN.test(threadId)) {
    throw createServiceError(`${where}: topic id "${threadId}" must be a number`, 400);
  }

  const label = String(input?.label == null ? "" : input.label).trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LEN);
  return { label, chatId, threadId: threadId || null };
}

class XBroadcastChannelStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {Array}  options.envChannels  resolved channels from the environment
   */
  constructor({ dataDir, envChannels = [], logger = console } = {}) {
    this._file = path.join(dataDir, "x-broadcast-channels.json");
    this._lockState = { depth: 0 };
    this._envChannels = envChannels;
    this._logger = logger;
  }

  /**
   * Reads the saved list. `{ state: "env" }` when nothing is saved,
   * `{ state: "corrupt" }` when a file exists but cannot be trusted — the
   * environment is served then, and the next save replaces the file.
   */
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return { state: "env", channels: null };
      this._logger.error?.(`[XBroadcastChannels] Could not read ${this._file}: ${err.message}`);
      return { state: "corrupt", channels: null, error: err.message };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.channels)) throw new SyntaxError("no channels array");
      // Re-run through the same resolver the environment uses, so a
      // hand-edited file gets the same ids, labels and topic checks.
      const channels = parseChannelsJson(JSON.stringify(parsed.channels)) || [];
      return { state: "saved", channels: dedupe(channels), updatedAt: parsed.updatedAt || null };
    } catch (err) {
      this._logger.error?.(`[XBroadcastChannels] ${this._file} is unreadable: ${err.message}`);
      return { state: "corrupt", channels: null, error: err.message };
    }
  }

  /** The channels the picker offers and the send route accepts. */
  list() {
    const read = this._read();
    return read.channels || this._envChannels;
  }

  snapshot() {
    const read = this._read();
    return {
      source: read.state === "saved" ? "saved" : "env",
      status: { state: read.state, error: read.error || null },
      updatedAt: read.updatedAt || null,
      channels: read.channels || this._envChannels,
      envChannels: this._envChannels,
      maxChannels: MAX_CHANNELS,
    };
  }

  /** Replaces the whole list. Refuses duplicates rather than dropping them. */
  save(input) {
    if (!Array.isArray(input)) throw createServiceError("channels must be an array", 400);
    if (input.length > MAX_CHANNELS) {
      throw createServiceError(`At most ${MAX_CHANNELS} broadcast channels can be saved`, 400);
    }
    const rows = input.map(normalizeChannelInput);
    const seen = new Map();
    rows.forEach((row, index) => {
      const id = channelId(row.chatId, row.threadId);
      if (seen.has(id)) {
        throw createServiceError(
          `Channel ${index + 1} repeats channel ${seen.get(id) + 1} (same chat and topic)`,
          400,
        );
      }
      seen.set(id, index);
    });

    return withExclusiveLock(
      this._file,
      this._lockState,
      () => {
        const written = writeJsonAtomic(this._file, {
          version: STORE_VERSION,
          updatedAt: new Date().toISOString(),
          channels: rows,
        }, this._logger, "[XBroadcastChannels]");
        if (!written) throw createServiceError("Could not write the broadcast channel list", 500);
        return this.snapshot();
      },
      { busyMessage: "Broadcast channels are being saved elsewhere; retry." },
    );
  }

  /** Drops the saved list so the environment applies again. */
  reset() {
    return withExclusiveLock(
      this._file,
      this._lockState,
      () => {
        try {
          fs.unlinkSync(this._file);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        return this.snapshot();
      },
      { busyMessage: "Broadcast channels are being saved elsewhere; retry." },
    );
  }
}

function dedupe(channels) {
  const seen = new Set();
  return channels.filter((channel) => {
    if (seen.has(channel.id)) return false;
    seen.add(channel.id);
    return true;
  }).slice(0, MAX_CHANNELS);
}

module.exports = { XBroadcastChannelStore, normalizeChannelInput };
