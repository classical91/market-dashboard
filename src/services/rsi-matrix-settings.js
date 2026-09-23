"use strict";

/**
 * RsiMatrixSettingsService
 *
 * Which instruments and timeframes the RSI Matrix shows, editable from
 * Settings → Screeners → RSI Matrix and persisted under DATA_DIR.
 *
 * Deliberately separate from screener-settings.js. That store is the Binance
 * USDT-spot token universe behind Directional Bias, Local Extremes, the
 * Pattern Scanner and Crypto OI, and it rejects USDT.D, TOTAL3 and every
 * CRYPTOCAP:/exchange-prefixed symbol on purpose — those screeners are candle
 * maths on Binance klines. The matrix mixes indices, yields, futures,
 * dominance series and stablecoins across many venues, so it owns its own
 * registry instead of loosening that validator.
 *
 * File shape (rsi-matrix-settings.json):
 *   {
 *     "version": 1,
 *     "seededDefaults": ["spx", ...],          // defaults already offered once
 *     "timeframes": { "1W": true, "1D": true, "4h": true, "1h": true },
 *     "instruments": [
 *       { "id": "spx", "label": "SPX", "group": "cross-market",
 *         "provider": "yahoo", "providerSymbol": "^GSPC", "enabled": true },
 *       ...
 *     ]
 *   }
 *
 * The array order is the configured column order. Persistence is the same
 * idiom as the other stores: one JSON file, rewritten whole under an exclusive
 * lock via an atomic rename.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { createServiceError } = require("../utils/errors");
const { GROUPS, GROUP_IDS, DEFAULT_INSTRUMENTS } = require("./rsi-matrix/registry");
const { TIMEFRAMES, TIMEFRAME_LABELS } = require("./rsi-matrix/candles");
const { assertProviderId, normalizeProviderSymbol, describeProviders } = require("./rsi-matrix/providers");

const SETTINGS_VERSION = 1;
const RSI_LENGTH = 14;

// Every instrument costs up to four upstream series per cold refresh; this
// keeps a full refresh well inside every venue's public rate limit.
const MAX_INSTRUMENTS = 80;
const MAX_LABEL_LENGTH = 24;

const DEFAULT_IDS = new Set(DEFAULT_INSTRUMENTS.map((i) => i.id));
const DEFAULTS_BY_ID = new Map(DEFAULT_INSTRUMENTS.map((i) => [i.id, i]));

function defaultTimeframes() {
  return TIMEFRAMES.reduce((acc, tf) => ({ ...acc, [tf]: true }), {});
}

function normalizeLabel(value) {
  const label = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!label) throw createServiceError("A display label is required", 400);
  if (label.length > MAX_LABEL_LENGTH) {
    throw createServiceError(`Display labels are at most ${MAX_LABEL_LENGTH} characters`, 400);
  }
  return label;
}

function assertGroup(value) {
  const group = String(value == null ? "" : value).trim();
  if (!GROUP_IDS.includes(group)) {
    throw createServiceError(`Unknown group "${group}". Expected one of: ${GROUP_IDS.join(", ")}`, 400);
  }
  return group;
}

/** Validates one row's editable fields. Throws a 400 on the first bad one. */
function normalizeInstrument(input) {
  if (!input || typeof input !== "object") throw createServiceError("Each instrument must be an object", 400);
  const provider = assertProviderId(input.provider);
  return {
    label: normalizeLabel(input.label),
    group: assertGroup(input.group),
    provider,
    providerSymbol: normalizeProviderSymbol(provider, input.providerSymbol),
    enabled: input.enabled !== false,
  };
}

function identity(row) {
  return `${row.group}|${row.provider}|${row.providerSymbol}`;
}

function assertNoDuplicates(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = identity(row);
    if (seen.has(key)) {
      throw createServiceError(
        `${row.label} duplicates ${seen.get(key)}: both read ${row.providerSymbol} from the same provider in the same group`,
        409,
      );
    }
    seen.set(key, row.label);
  }
}

function slug(label) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "instrument";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

class RsiMatrixSettingsService {
  constructor({ dataDir, logger = console, verifyInstrument = null, defaults = DEFAULT_INSTRUMENTS } = {}) {
    this._file = path.join(dataDir, "rsi-matrix-settings.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    // async ({ provider, providerSymbol }) => void; throws a service error
    // when the symbol does not resolve. Optional so tests and offline boots
    // can run without the network.
    this._verify = verifyInstrument;
    this._defaults = defaults.map((row) => ({ ...row }));
    this._defaultIds = new Set(this._defaults.map((row) => row.id));
    this._loadState = "unread";
    this._loadError = null;
    this._corruptBackedUp = false;
  }

  _defaultState() {
    return {
      seededDefaults: this._defaults.map((row) => row.id),
      timeframes: defaultTimeframes(),
      instruments: this._defaults.map(({ note, ...row }) => ({ ...row })),
    };
  }

  /**
   * Reads the file, seeding from the defaults the first time. A single bad
   * row is dropped (and logged) rather than failing the whole matrix; a file
   * that can't be parsed at all serves the defaults and is preserved for
   * recovery on the next write.
   */
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      this._loadState = err.code === "ENOENT" ? "seeded" : "unreadable";
      this._loadError = err.code === "ENOENT" ? null : err.message;
      return this._defaultState();
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.instruments)) {
        throw new SyntaxError("no instruments array");
      }
      const instruments = [];
      const ids = new Set();
      let dropped = 0;
      for (const row of parsed.instruments) {
        try {
          const id = String(row && row.id ? row.id : "").trim();
          if (!id || ids.has(id)) throw new Error("missing or repeated id");
          instruments.push({ id, ...normalizeInstrument(row) });
          ids.add(id);
        } catch {
          dropped += 1;
        }
      }
      const timeframes = defaultTimeframes();
      if (parsed.timeframes && typeof parsed.timeframes === "object") {
        for (const tf of TIMEFRAMES) {
          if (typeof parsed.timeframes[tf] === "boolean") timeframes[tf] = parsed.timeframes[tf];
        }
      }
      const seededDefaults = Array.isArray(parsed.seededDefaults) ? parsed.seededDefaults.map(String) : [];
      this._loadState = dropped ? "partial" : "loaded";
      this._loadError = dropped ? `${dropped} unreadable instrument row(s) skipped` : null;
      if (dropped) this._logger.warn?.(`[RsiMatrixSettings] ${this._loadError} in ${this._file}`);
      return { seededDefaults, timeframes, instruments };
    } catch (err) {
      this._loadState = "corrupt";
      this._loadError = err.message;
      this._logger.error?.(`[RsiMatrixSettings] ${this._file} is unreadable (${err.message}); serving defaults`);
      return this._defaultState();
    }
  }

  _write(state) {
    if (this._loadState === "corrupt" && !this._corruptBackedUp) {
      try {
        fs.copyFileSync(this._file, `${this._file}.corrupt`);
        this._corruptBackedUp = true;
      } catch {
        /* best effort */
      }
    }
    const written = writeJsonAtomic(
      this._file,
      {
        version: SETTINGS_VERSION,
        seededDefaults: Array.from(new Set(state.seededDefaults)),
        timeframes: state.timeframes,
        instruments: state.instruments.map(({ id, label, group, provider, providerSymbol, enabled }) => ({
          id,
          label,
          group,
          provider,
          providerSymbol,
          enabled: Boolean(enabled),
        })),
      },
      this._logger,
      "[RsiMatrixSettings]",
    );
    if (written) {
      this._loadState = "loaded";
      this._loadError = null;
    }
    return written;
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "RSI Matrix settings are busy; retry the request.",
    });
  }

  /**
   * Writes the seed on first boot and offers each later default exactly once:
   * an instrument a new release ships appears on the next boot, while one the
   * operator has disabled stays disabled.
   */
  ensureSeeded() {
    return this._withLock(() => {
      if (!fs.existsSync(this._file)) return this._write(this._read());
      const state = this._read();
      if (this._loadState === "corrupt") return false;
      const seeded = new Set(state.seededDefaults);
      const present = new Set(state.instruments.map((row) => row.id));
      const pending = this._defaults.filter((row) => !seeded.has(row.id) && !present.has(row.id));
      if (!pending.length) return false;
      for (const { note, ...row } of pending) state.instruments.push({ ...row });
      state.seededDefaults.push(...pending.map((row) => row.id));
      return this._write(state);
    });
  }

  _present(state) {
    return {
      version: SETTINGS_VERSION,
      rsiLength: RSI_LENGTH,
      groups: GROUPS.map((g) => ({ ...g })),
      providers: describeProviders(),
      timeframes: TIMEFRAMES.map((key) => ({ key, label: TIMEFRAME_LABELS[key], enabled: state.timeframes[key] !== false })),
      instruments: state.instruments.map((row) => {
        const shipped = DEFAULTS_BY_ID.get(row.id);
        // The shipped note explains a source choice; it stops applying the
        // moment the operator points the row somewhere else.
        const note =
          shipped && shipped.provider === row.provider && shipped.providerSymbol === row.providerSymbol ? shipped.note || null : null;
        return { ...row, isDefault: this._defaultIds.has(row.id), note };
      }),
      maxInstruments: MAX_INSTRUMENTS,
      status: { state: this._loadState, error: this._loadError },
    };
  }

  /** Everything the Settings page and the matrix route need, in one read. */
  snapshot() {
    return this._present(this._read());
  }

  async _verifyRow(row) {
    if (!this._verify) return;
    await this._verify({ provider: row.provider, providerSymbol: row.providerSymbol });
  }

  /**
   * Replaces order, labels, groups, sources, enabled flags and timeframes in
   * one write. The set of ids must match what is stored: adding goes through
   * addInstrument() (which verifies) and deleting through removeInstrument(),
   * so a stale page can't resurrect or drop rows by omission.
   *
   * Any row whose provider or symbol changed is verified before the lock is
   * taken — a network call inside the lock would hold every other writer.
   */
  async save({ instruments, timeframes } = {}) {
    if (!Array.isArray(instruments)) throw createServiceError("instruments must be an array", 400);
    const current = this._read();
    const byId = new Map(current.instruments.map((row) => [row.id, row]));
    const next = instruments.map((input) => {
      const id = String(input && input.id ? input.id : "").trim();
      if (!byId.has(id)) throw createServiceError(`Unknown instrument "${id}". Reload the page and try again.`, 409);
      return { id, ...normalizeInstrument(input) };
    });
    const ids = new Set(next.map((row) => row.id));
    if (ids.size !== next.length) throw createServiceError("An instrument is listed twice", 400);
    const missing = current.instruments.filter((row) => !ids.has(row.id));
    if (missing.length) {
      throw createServiceError(
        `${missing.map((row) => row.label).join(", ")} ${missing.length === 1 ? "is" : "are"} missing from the save. Reload the page and try again.`,
        409,
      );
    }
    assertNoDuplicates(next);

    const nextTimeframes = { ...current.timeframes };
    if (timeframes !== undefined) {
      if (!timeframes || typeof timeframes !== "object") throw createServiceError("timeframes must be an object", 400);
      for (const [key, value] of Object.entries(timeframes)) {
        if (!TIMEFRAMES.includes(key)) throw createServiceError(`Unknown timeframe "${key}"`, 400);
        nextTimeframes[key] = Boolean(value);
      }
    }
    if (!TIMEFRAMES.some((tf) => nextTimeframes[tf])) {
      throw createServiceError("At least one timeframe must stay enabled", 400);
    }

    for (const row of next) {
      const before = byId.get(row.id);
      if (before.provider !== row.provider || before.providerSymbol !== row.providerSymbol) await this._verifyRow(row);
    }

    return this._withLock(() => {
      const state = this._read();
      const storedIds = new Set(state.instruments.map((row) => row.id));
      if (storedIds.size !== ids.size || next.some((row) => !storedIds.has(row.id))) {
        throw createServiceError("The instrument list changed while saving. Reload the page and try again.", 409);
      }
      state.instruments = next;
      state.timeframes = nextTimeframes;
      if (!this._write(state)) throw createServiceError("Could not save the RSI Matrix settings", 500);
      return this.snapshot();
    });
  }

  /** Adds a user instrument (verified against its provider first). */
  async addInstrument(input) {
    const row = normalizeInstrument({ ...input, enabled: true });
    const existing = this._read();
    if (existing.instruments.length >= MAX_INSTRUMENTS) {
      throw createServiceError(`At most ${MAX_INSTRUMENTS} instruments can be tracked`, 400);
    }
    assertNoDuplicates([...existing.instruments, { id: "new", ...row }]);
    await this._verifyRow(row);

    return this._withLock(() => {
      const state = this._read();
      const created = { id: slug(row.label), ...row };
      assertNoDuplicates([...state.instruments, created]);
      state.instruments.push(created);
      if (!this._write(state)) throw createServiceError(`Could not add ${row.label}`, 500);
      return this.snapshot();
    });
  }

  /**
   * Deletes a user-added instrument. A shipped default is refused: it is
   * disabled rather than deleted, so Reset always restores the same list.
   */
  removeInstrument(rawId) {
    return this._withLock(() => {
      const id = String(rawId == null ? "" : rawId).trim();
      if (this._defaultIds.has(id)) {
        throw createServiceError("Default instruments can be disabled but not deleted", 400);
      }
      const state = this._read();
      if (!state.instruments.some((row) => row.id === id)) throw createServiceError(`Unknown instrument "${id}"`, 404);
      state.instruments = state.instruments.filter((row) => row.id !== id);
      if (!this._write(state)) throw createServiceError("Could not remove the instrument", 500);
      return this.snapshot();
    });
  }

  /**
   * Back to the shipped instruments, order, sources and timeframes.
   * User-added rows stay (removing one is an explicit delete) but are switched
   * off and moved after the defaults.
   */
  reset() {
    return this._withLock(() => {
      const state = this._read();
      const next = this._defaultState();
      for (const row of state.instruments) {
        if (!this._defaultIds.has(row.id)) next.instruments.push({ ...row, enabled: false });
      }
      if (!this._write(next)) throw createServiceError("Could not reset the RSI Matrix settings", 500);
      return this.snapshot();
    });
  }
}

module.exports = {
  RsiMatrixSettingsService,
  RSI_LENGTH,
  MAX_INSTRUMENTS,
  DEFAULT_IDS,
};
