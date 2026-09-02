"use strict";

/**
 * XAccountRegistry
 *
 * The runtime source of truth for which X accounts the dashboard tracks.
 *
 * The list used to live in src/config/x-accounts.js, which meant adding or
 * dropping an account was a code change and a redeploy. That static list is
 * now only the seed: on first boot it is written into a JSON file under
 * DATA_DIR (the Railway volume in production), and from then on the file is
 * what the feed reads. Storing it browser-side instead would have quietly
 * resurrected deleted accounts on the next deploy for every other device.
 *
 * Persistence follows the same idiom as the other stores here: one JSON file,
 * rewritten whole under an exclusive lock via an atomic rename. No new
 * storage technology.
 *
 * File shape:
 *   { "version": 1, "accounts": [ { handle, label, category, addedAt } ] }
 *
 * Adding an account never calls X. Format is the only thing validated, so a
 * rejected bearer token or a rate-limited provider can neither block account
 * management nor leave a half-written registry behind.
 *
 * One X account is one row. Handles are compared case-insensitively (X treats
 * them that way), an add that repeats one is refused with a 409, and the write
 * path de-duplicates regardless of caller — a second row for one handle would
 * show the account twice in the sidebar and every one of its posts twice in
 * the feed.
 */

const fs = require("fs");
const path = require("path");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { X_ACCOUNTS } = require("../config/x-accounts");
const { createServiceError } = require("../utils/errors");

const REGISTRY_VERSION = 1;
const MAX_ACCOUNTS = 200;
// X handles are 1-15 characters of [A-Za-z0-9_]. Enforced before persistence
// so a typo cannot become a permanently failing account in the feed.
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const MAX_LABEL_LEN = 60;
const MAX_CATEGORY_LEN = 40;

// Offered by the UI. Not a whitelist — a custom category groups itself in the
// sidebar, which builds its sections from whatever categories come back.
const DEFAULT_CATEGORIES = ["Market Data", "Crypto Traders", "TA & Signals"];

function normalizeHandle(value) {
  return String(value == null ? "" : value).trim().replace(/^@+/, "").trim();
}

/**
 * The identity a handle is compared by. X handles are case-insensitive, so
 * @Barchart and @barchart are one account, not two. Every duplicate check in
 * the X Intelligence stack goes through this so they cannot drift apart.
 */
function canonicalHandle(value) {
  return normalizeHandle(value).toLowerCase();
}

function sameHandle(a, b) {
  return canonicalHandle(a) === canonicalHandle(b);
}

/**
 * Drops any account whose handle is already present, keeping the first.
 * Used as a persistence invariant rather than only as a pre-check: no path —
 * the seed list, an add, a hand-edited file — should be able to leave two rows
 * for one account.
 */
function dedupeAccounts(accounts) {
  const seen = new Set();
  const unique = [];
  let dropped = 0;
  for (const account of accounts || []) {
    const key = canonicalHandle(account?.handle);
    if (!key || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    unique.push(account);
  }
  return { accounts: unique, dropped };
}

function clamp(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

/**
 * Validates and normalizes one account. Throws a 400-shaped error rather than
 * persisting anything questionable — the registry is read on every feed
 * refresh, so a bad row is a permanent failure, not a one-off.
 */
function normalizeAccount(input) {
  const handle = normalizeHandle(input?.handle);
  if (!handle) {
    throw createServiceError("An X handle is required", 400);
  }
  if (!HANDLE_PATTERN.test(handle)) {
    throw createServiceError(
      `"${handle}" is not a valid X handle (1-15 letters, numbers or underscores)`,
      400,
    );
  }

  const category = clamp(input?.category, MAX_CATEGORY_LEN);
  if (!category) {
    throw createServiceError("A category is required", 400);
  }

  return {
    handle,
    // An empty label is normal — most handles are their own best label.
    label: clamp(input?.label, MAX_LABEL_LEN) || handle,
    category,
  };
}

class XAccountRegistry {
  constructor({ dataDir, seed = X_ACCOUNTS, logger = console, cache = null } = {}) {
    this._file = path.join(dataDir, "x-accounts.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._seed = seed;
    // Used to drop a removed account's cached feed state, so a delete cannot
    // be undone by a cache entry outliving it.
    this._cache = cache;
    this._loadState = "unread";
    this._loadError = null;
    this._corruptBackedUp = false;
    this._membershipHooks = { onAdd: null, onRemove: null };
  }

  setMembershipHooks({ onAdd = null, onRemove = null } = {}) {
    this._membershipHooks = { onAdd, onRemove };
  }

  /**
   * Reads the file, seeding it from the static config the first time.
   *
   * A file that exists but cannot be parsed is the dangerous case: returning
   * an empty list would silently untrack every account. Instead the seed is
   * served, the state is recorded for diagnostics, and the unreadable file is
   * preserved until a write can back it up.
   */
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._loadState = "seeded";
        this._loadError = null;
        return this._seed.map((account) => normalizeAccount(account));
      }
      this._loadState = "unreadable";
      this._loadError = err.message;
      this._logger.error?.(`[XAccounts] Could not read ${this._file}: ${err.message}`);
      return this._seed.map((account) => normalizeAccount(account));
    }

    try {
      const parsed = JSON.parse(raw);
      const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;
      if (!Array.isArray(accounts)) throw new SyntaxError("no accounts array");

      const valid = [];
      let malformed = 0;
      let duplicates = 0;
      for (const entry of accounts) {
        // One bad row must not take the whole registry down with it.
        try {
          const account = normalizeAccount(entry);
          if (valid.some((existing) => sameHandle(existing.handle, account.handle))) {
            // A file edited by hand (or written by an older build) can name
            // one account twice. Serving both would duplicate the account in
            // the sidebar and every one of its posts in the feed.
            duplicates += 1;
            continue;
          }
          valid.push({ ...account, addedAt: entry?.addedAt || null });
        } catch {
          malformed += 1;
        }
      }

      const notes = [];
      if (malformed) notes.push(`${malformed} malformed entr${malformed === 1 ? "y" : "ies"} skipped`);
      if (duplicates) notes.push(`${duplicates} duplicate handle${duplicates === 1 ? "" : "s"} merged`);
      this._loadState = notes.length ? "partial" : "loaded";
      this._loadError = notes.length ? notes.join("; ") : null;
      if (notes.length) {
        this._logger.warn?.(`[XAccounts] ${notes.join("; ")} in ${this._file}`);
      }
      return valid;
    } catch (err) {
      this._loadState = "corrupt";
      this._loadError = err.message;
      this._logger.error?.(
        `[XAccounts] ${this._file} is unreadable (${err.message}); serving the seed list instead`,
      );
      return this._seed.map((account) => normalizeAccount(account));
    }
  }

  _write(accounts) {
    // Preserve whatever could not be parsed before overwriting it, so a
    // corrupt registry is recoverable by hand rather than lost to the fix.
    if (this._loadState === "corrupt" && !this._corruptBackedUp) {
      try {
        fs.copyFileSync(this._file, `${this._file}.corrupt`);
        this._corruptBackedUp = true;
        this._logger.warn?.(`[XAccounts] Backed up the unreadable registry to ${this._file}.corrupt`);
      } catch {
        /* best effort — never block the repair on the backup */
      }
    }

    // The last line of defence: whatever a caller hands us, one X account
    // gets one row. add() already rejects a duplicate with a 409 so the
    // request is answered honestly; this only guarantees that no other path
    // (the seed list, a repair after a corrupt read, a future caller) can
    // persist the same handle twice.
    const { accounts: unique, dropped } = dedupeAccounts(accounts);
    if (dropped) {
      this._logger.warn?.(`[XAccounts] Dropped ${dropped} duplicate account row(s) before saving`);
    }

    const written = writeJsonAtomic(
      this._file,
      { version: REGISTRY_VERSION, accounts: unique.slice(0, MAX_ACCOUNTS) },
      this._logger,
      "[XAccounts]",
    );
    if (written) {
      this._loadState = "loaded";
      this._loadError = null;
    }
    return written;
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "The X account registry is busy; retry the request.",
    });
  }

  /** The tracked accounts, in the order the feed and sidebar should show them. */
  list() {
    return this._read().map(({ handle, label, category }) => ({ handle, label, category }));
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
      const account = normalizeAccount(input);
      const accounts = this._read();

      // Case-insensitive, because X handles are: @Barchart and @barchart are
      // the same account. The stored spelling is quoted back so the message
      // matches what the admin sees in the list.
      const duplicate = accounts.find((existing) => sameHandle(existing.handle, account.handle));
      if (duplicate) {
        throw createServiceError(
          `@${duplicate.handle} is already tracked under ${duplicate.category}`,
          409,
        );
      }
      if (accounts.length >= MAX_ACCOUNTS) {
        throw createServiceError(`At most ${MAX_ACCOUNTS} accounts can be tracked`, 400);
      }

      const stored = { ...account, addedAt: new Date().toISOString() };
      const next = accounts.concat(stored);
      if (!this._write(next)) {
        throw createServiceError("Could not save the account registry", 500);
      }
      try {
        this._membershipHooks.onAdd?.(stored);
      } catch (err) {
        this._logger.warn?.(`[XAccounts] Account saved but could not add it to the default template: ${err.message}`);
      }
      return stored;
    });
  }

  remove(handleInput) {
    return this._withLock(() => {
      const handle = normalizeHandle(handleInput);
      const accounts = this._read();
      const existing = accounts.find((account) => sameHandle(account.handle, handle));
      if (!existing) {
        throw createServiceError(`@${handle} is not tracked`, 404);
      }

      // Remove memberships first so a globally deleted account cannot leave
      // dead references in any template. If that cleanup fails, keep the
      // global account and report the failure instead.
      this._membershipHooks.onRemove?.(existing);

      const next = accounts.filter((account) => !sameHandle(account.handle, handle));
      if (!this._write(next)) {
        throw createServiceError("Could not save the account registry", 500);
      }

      // Drop the cached feed state too. Without this the account keeps
      // reappearing in the feed until its entries expire, which reads exactly
      // like the delete having failed.
      this._forgetCachedFeed(existing.handle);
      return existing;
    });
  }

  _forgetCachedFeed(handle) {
    if (typeof this._cache?.delete !== "function") return;
    for (const key of [
      `x:feed:${handle}`,
      `x:feed:latest:${handle}`,
      `x:userid:${handle.toLowerCase()}`,
    ]) {
      try {
        this._cache.delete(key);
      } catch (err) {
        this._logger.warn?.(`[XAccounts] Could not clear ${key}: ${err.message}`);
      }
    }
  }

  /** Surfaces a registry problem instead of leaving it to be inferred. */
  describe() {
    const accounts = this._read();
    return {
      file: this._file,
      loadState: this._loadState,
      loadError: this._loadError,
      accounts: accounts.length,
      seedAccounts: this._seed.length,
    };
  }
}

module.exports = {
  XAccountRegistry,
  normalizeHandle,
  canonicalHandle,
  sameHandle,
  dedupeAccounts,
  normalizeAccount,
  DEFAULT_CATEGORIES,
  HANDLE_PATTERN,
};
