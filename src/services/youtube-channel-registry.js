"use strict";

/**
 * YoutubeChannelRegistry
 *
 * The runtime source of truth for which YouTube channels the dashboard tracks.
 *
 * The list used to live only in src/config/youtube-channels.js, which meant
 * adding or dropping a channel was a code change and a redeploy — and with
 * themes on the page that was the whole friction: a theme could be switched to
 * but never filled. That static list is now the seed. On first boot it is
 * written into a JSON file under DATA_DIR (the Railway volume in production),
 * and from then on the file is what the feed reads.
 *
 * This is deliberately the same idiom as XAccountRegistry: one JSON file,
 * rewritten whole under an exclusive lock via an atomic rename. No new storage
 * technology, and an operator who has debugged one registry has debugged both.
 *
 * File shape:
 *   { "version": 1, "channels": [ { handle, label, category, channelId, addedAt } ] }
 *
 * Adding a channel never calls YouTube. Only the format is validated, so an
 * exhausted API quota can neither block channel management nor leave a
 * half-written registry behind — the feed resolves the channel ID on its next
 * refresh, exactly as it does for a seeded channel with no configured ID.
 *
 * A channel's `category` is what places it in a theme (see
 * src/config/youtube-themes.js), so adding a channel under "Archaeology" is
 * all it takes to fill the Dig Site theme.
 */

const fs = require("fs");
const path = require("path");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { YOUTUBE_CHANNELS, isChannelId } = require("../config/youtube-channels");
const { createServiceError } = require("../utils/errors");

const REGISTRY_VERSION = 1;
const MAX_CHANNELS = 200;
// A YouTube handle is 3-30 characters of [A-Za-z0-9._-]. Enforced before
// persistence so a typo cannot become a permanently failing feed.
const HANDLE_PATTERN = /^[A-Za-z0-9._-]{3,30}$/;
const MAX_LABEL_LEN = 60;
const MAX_CATEGORY_LEN = 40;

function normalizeHandle(value) {
  return String(value == null ? "" : value).trim().replace(/^@+/, "").trim();
}

/**
 * The identity a handle is compared by. YouTube handles are case-insensitive
 * for lookup, so @StockMoe and @stockmoe are one channel, not two.
 */
function canonicalHandle(value) {
  return normalizeHandle(value).toLowerCase();
}

function sameHandle(a, b) {
  return canonicalHandle(a) === canonicalHandle(b);
}

function clamp(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

/** Drops any channel whose handle is already present, keeping the first. */
function dedupeChannels(channels) {
  const seen = new Set();
  const unique = [];
  let dropped = 0;
  for (const channel of channels || []) {
    const key = canonicalHandle(channel?.handle);
    if (!key || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    unique.push(channel);
  }
  return { channels: unique, dropped };
}

/**
 * Validates and normalizes one channel. Throws a 400-shaped error rather than
 * persisting anything questionable — the registry is read on every feed
 * refresh, so a bad row is a permanent failure, not a one-off.
 */
function normalizeChannel(input) {
  const handle = normalizeHandle(input?.handle);
  if (!handle) throw createServiceError("A YouTube handle is required", 400);
  if (!HANDLE_PATTERN.test(handle)) {
    throw createServiceError(
      `"${handle}" is not a valid YouTube handle (3-30 letters, numbers, dots, dashes or underscores)`,
      400,
    );
  }

  const category = clamp(input?.category, MAX_CATEGORY_LEN);
  if (!category) throw createServiceError("A category is required", 400);

  // An ID is optional. A blank or malformed one is stored as "" so the service
  // resolves it through the API rather than building a broken feed URL — the
  // same rule resolveYoutubeChannels applies to the static list.
  const rawId = String(input?.channelId == null ? "" : input.channelId).trim();
  if (rawId && !isChannelId(rawId)) {
    throw createServiceError(`"${rawId}" is not a valid channel ID (UC followed by 22 characters)`, 400);
  }

  return {
    handle,
    label: clamp(input?.label, MAX_LABEL_LEN) || handle,
    category,
    channelId: rawId,
  };
}

class YoutubeChannelRegistry {
  constructor({ dataDir, seed = YOUTUBE_CHANNELS, logger = console } = {}) {
    this._file = path.join(dataDir, "youtube-channels.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._seed = seed;
    this._loadState = "unread";
    this._loadError = null;
    this._corruptBackedUp = false;
  }

  /**
   * Reads the file, seeding it from the static config the first time.
   *
   * A file that exists but cannot be parsed is the dangerous case: returning
   * an empty list would silently untrack every channel and blank the page.
   * The seed is served instead, and the unreadable file is preserved until a
   * write can back it up.
   */
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._loadState = "seeded";
        this._loadError = null;
        return this._seed.map((channel) => normalizeChannel(channel));
      }
      this._loadState = "unreadable";
      this._loadError = err.message;
      this._logger.error?.(`[YoutubeChannels] Could not read ${this._file}: ${err.message}`);
      return this._seed.map((channel) => normalizeChannel(channel));
    }

    try {
      const parsed = JSON.parse(raw);
      const source = Array.isArray(parsed) ? parsed : parsed?.channels;
      if (!Array.isArray(source)) throw new SyntaxError("no channels array");

      const valid = [];
      let malformed = 0;
      let duplicates = 0;
      for (const entry of source) {
        // One bad row must not take the whole registry down with it.
        try {
          const channel = normalizeChannel(entry);
          if (valid.some((existing) => sameHandle(existing.handle, channel.handle))) {
            duplicates += 1;
            continue;
          }
          valid.push({ ...channel, addedAt: entry?.addedAt || null });
        } catch {
          malformed += 1;
        }
      }

      const notes = [];
      if (malformed) notes.push(`${malformed} malformed entr${malformed === 1 ? "y" : "ies"} skipped`);
      if (duplicates) notes.push(`${duplicates} duplicate handle${duplicates === 1 ? "" : "s"} merged`);
      this._loadState = notes.length ? "partial" : "loaded";
      this._loadError = notes.length ? notes.join("; ") : null;
      if (notes.length) this._logger.warn?.(`[YoutubeChannels] ${notes.join("; ")} in ${this._file}`);
      return valid;
    } catch (err) {
      this._loadState = "corrupt";
      this._loadError = err.message;
      this._logger.error?.(
        `[YoutubeChannels] ${this._file} is unreadable (${err.message}); serving the seed list instead`,
      );
      return this._seed.map((channel) => normalizeChannel(channel));
    }
  }

  _write(channels) {
    // Preserve whatever could not be parsed before overwriting it, so a
    // corrupt registry is recoverable by hand rather than lost to the fix.
    if (this._loadState === "corrupt" && !this._corruptBackedUp) {
      try {
        fs.copyFileSync(this._file, `${this._file}.corrupt`);
        this._corruptBackedUp = true;
        this._logger.warn?.(`[YoutubeChannels] Backed up the unreadable registry to ${this._file}.corrupt`);
      } catch {
        /* best effort — never block the repair on the backup */
      }
    }

    const { channels: unique, dropped } = dedupeChannels(channels);
    if (dropped) {
      this._logger.warn?.(`[YoutubeChannels] Dropped ${dropped} duplicate channel row(s) before saving`);
    }

    const written = writeJsonAtomic(
      this._file,
      { version: REGISTRY_VERSION, channels: unique.slice(0, MAX_CHANNELS) },
      this._logger,
      "[YoutubeChannels]",
    );
    if (written) {
      this._loadState = "loaded";
      this._loadError = null;
    }
    return written;
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "The YouTube channel registry is busy; retry the request.",
    });
  }

  /** The tracked channels, in the order the feed and switcher should show them. */
  list() {
    return this._read().map(({ handle, label, category, channelId }) => ({
      handle,
      label,
      category,
      channelId,
    }));
  }

  /** Writes the seed out on first boot so the file exists to be edited. */
  ensureSeeded() {
    return this._withLock(() => {
      if (fs.existsSync(this._file)) {
        this._read();
        return false;
      }
      this._write(this._read());
      return true;
    });
  }

  add(input) {
    return this._withLock(() => {
      const channel = normalizeChannel(input);
      const channels = this._read();

      const duplicate = channels.find((existing) => sameHandle(existing.handle, channel.handle));
      if (duplicate) {
        throw createServiceError(
          `@${duplicate.handle} is already tracked under ${duplicate.category}`,
          409,
        );
      }
      if (channels.length >= MAX_CHANNELS) {
        throw createServiceError(`At most ${MAX_CHANNELS} channels can be tracked`, 400);
      }

      const stored = { ...channel, addedAt: new Date().toISOString() };
      if (!this._write(channels.concat(stored))) {
        throw createServiceError("Could not save the channel registry", 500);
      }
      return stored;
    });
  }

  remove(handleInput) {
    return this._withLock(() => {
      const handle = normalizeHandle(handleInput);
      const channels = this._read();
      const existing = channels.find((channel) => sameHandle(channel.handle, handle));
      if (!existing) throw createServiceError(`@${handle} is not tracked`, 404);

      if (!this._write(channels.filter((channel) => !sameHandle(channel.handle, handle)))) {
        throw createServiceError("Could not save the channel registry", 500);
      }
      return existing;
    });
  }

  /** Surfaces a registry problem instead of leaving it to be inferred. */
  describe() {
    const channels = this._read();
    return {
      file: this._file,
      loadState: this._loadState,
      loadError: this._loadError,
      channels: channels.length,
      seedChannels: this._seed.length,
    };
  }
}

module.exports = {
  YoutubeChannelRegistry,
  normalizeHandle,
  canonicalHandle,
  sameHandle,
  dedupeChannels,
  normalizeChannel,
  HANDLE_PATTERN,
  MAX_CHANNELS,
};
