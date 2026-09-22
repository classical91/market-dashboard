"use strict";

/**
 * ScreenerSettingsService
 *
 * The runtime source of truth for which tokens each screener scans.
 *
 * The universe used to be `TOP_TOKENS` in src/config/market-symbols.js, read
 * directly by the Signal Screener and constructed into the Pattern Scanner —
 * which meant the Settings page could not change what the scanners actually
 * monitor, and adding or dropping a token was a code change and a redeploy.
 * That static list is now only the default catalog: on first boot it seeds all
 * screener universes, and from then on this file is what the routes read.
 *
 * Server-side on purpose. The scanning happens here, not in the browser, so a
 * localStorage-only setting would leave the UI claiming one universe while
 * Railway kept scanning another.
 *
 * Persistence follows the same idiom as the other stores here (see
 * x-account-registry.js): one JSON file under DATA_DIR, rewritten whole under
 * an exclusive lock via an atomic rename. No new storage technology.
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "seededDefaults": ["BTCUSDT", ...],
 *     "added": ["RENDERUSDT"],
 *     "universes": {
 *       "directionalBias": ["BTCUSDT", ...],
 *       "localExtremes": ["BTCUSDT", ...],
 *       "patternScanner": ["BTCUSDT", ...]
 *     }
 *   }
 *
 * `seededDefaults` records which catalog defaults have already been offered,
 * so a token a later release adds to TOP_TOKENS starts being scanned the way
 * it would have before this store existed — while a token the operator has
 * unchecked stays unchecked across every later boot.
 *
 * An empty universe means exactly that: scan nothing. Falling back to the
 * defaults instead would make Clear silently a no-op and the page a lie. The
 * defaults are only served when the file itself cannot be trusted.
 */

const fs = require("fs");
const path = require("path");

const { withExclusiveLock, writeJsonAtomic } = require("./json-file-lock");
const { TOP_TOKENS } = require("../config/market-symbols");
const { createServiceError } = require("../utils/errors");

const SETTINGS_VERSION = 1;

// The screeners this store fronts. Order is the display order of the
// matrix columns on the Settings page.
const SCREENERS = [
  {
    key: "directionalBias",
    label: "Directional Bias",
    description: "Which way the market is leaning — the six-check confluence signal",
  },
  {
    key: "localExtremes",
    label: "Local Extremes",
    description: "Whether price is stretched toward a local top or bottom",
  },
  {
    key: "patternScanner",
    label: "Pattern Scanner",
    description: "Flags, wedges and RSI divergence across 1h / 4h / 1D",
  },
  {
    key: "openInterest",
    label: "Open Interest",
    description: "Futures positioning — OI change against price across 15m / 1h / 4h / 24h",
  },
];

const SCREENER_KEYS = SCREENERS.map((screener) => screener.key);

// Bounds the scan, not the operator's ambition: the Pattern Scanner alone
// costs one Binance request per token per timeframe on every cold refresh,
// so a catalog three times this size would spend the rate limit rather than
// the cache.
const MAX_CATALOG = 60;

// Binance spot pairs are uppercase alphanumerics. Only USDT quotes are
// accepted because the klines both scanners read are USDT-quoted throughout,
// and a token priced in BTC would silently break every percent comparison
// the pages make against it.
const SYMBOL_PATTERN = /^[A-Z0-9]{2,16}USDT$/;

function normalizeSymbol(value) {
  return String(value == null ? "" : value).trim().toUpperCase();
}

/**
 * Validates one symbol's format. Throws a 400-shaped error rather than
 * persisting anything questionable — every scan reads this list, so a bad
 * entry is a permanently failing row, not a one-off.
 */
function assertValidSymbol(value) {
  const symbol = normalizeSymbol(value);
  if (!symbol) throw createServiceError("A token symbol is required", 400);
  // The dominance and market-cap indices are the common mistake here: they're
  // synthetic TradingView series with no Binance OHLCV, so they can't go
  // through a candle scanner at all. USDT.D already rides along with the
  // Directional Bias response as market context, which is where it belongs.
  if (symbol.includes(".") || symbol.includes(":")) {
    throw createServiceError(
      `"${symbol}" is not a Binance spot pair. Dominance and market-cap indices (USDT.D, TOTAL) have no candles to scan — USDT.D already appears on Directional Bias as market context.`,
      400,
    );
  }
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw createServiceError(
      `"${symbol}" is not a valid Binance USDT spot pair (e.g. RENDERUSDT)`,
      400,
    );
  }
  return symbol;
}

/** Drops blanks and repeats, keeping the first spelling of each symbol. */
function dedupeSymbols(symbols) {
  const seen = new Set();
  const unique = [];
  for (const entry of symbols || []) {
    const symbol = normalizeSymbol(entry);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  return unique;
}

function assertScreenerKey(value) {
  const key = String(value == null ? "" : value).trim();
  if (!SCREENER_KEYS.includes(key)) {
    throw createServiceError(
      `Unknown screener "${key}". Expected one of: ${SCREENER_KEYS.join(", ")}`,
      400,
    );
  }
  return key;
}

/**
 * The default Binance ticker probe: does this pair actually return market
 * data? Adding a pair Binance has never heard of would otherwise put a
 * permanently erroring row on every screener page. Injectable so tests — and any
 * future data source — can supply their own.
 */
async function verifySymbolOnBinance(symbol) {
  const url = `https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // A provider outage must not be reported as "this token does not exist".
    throw createServiceError(`Could not reach Binance to verify ${symbol}: ${err.message}`, 503);
  }
  if (res.status === 400 || res.status === 404) {
    throw createServiceError(`Binance does not list ${symbol} as a spot pair`, 400);
  }
  if (!res.ok) {
    throw createServiceError(`Binance returned HTTP ${res.status} while verifying ${symbol}`, 503);
  }
  const data = await res.json().catch(() => null);
  if (!data || !Number.isFinite(Number(data.price))) {
    throw createServiceError(`Binance returned no price for ${symbol}`, 400);
  }
  return symbol;
}

class ScreenerSettingsService {
  constructor({
    dataDir,
    defaults = TOP_TOKENS,
    logger = console,
    verifySymbol = verifySymbolOnBinance,
  } = {}) {
    this._file = path.join(dataDir, "screener-settings.json");
    this._lockState = { depth: 0 };
    this._logger = logger;
    this._defaults = dedupeSymbols(defaults);
    this._verifySymbol = verifySymbol;
    this._loadState = "unread";
    this._loadError = null;
    this._corruptBackedUp = false;
  }

  get screeners() {
    return SCREENERS.map((screener) => ({ ...screener }));
  }

  get defaults() {
    return this._defaults.slice();
  }

  /** Every default selected — the shape a first boot and a reset both write. */
  _defaultState() {
    const universes = {};
    for (const key of SCREENER_KEYS) universes[key] = this._defaults.slice();
    return { seededDefaults: this._defaults.slice(), added: [], universes };
  }

  /**
   * Reads the file, seeding from the default catalog the first time.
   *
   * A file that exists but cannot be parsed is the dangerous case: returning
   * empty universes would silently stop every screener. The defaults are
   * served instead, the state is recorded for diagnostics, and the unreadable
   * file is preserved until a write can back it up.
   */
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._loadState = "seeded";
        this._loadError = null;
        return this._defaultState();
      }
      this._loadState = "unreadable";
      this._loadError = err.message;
      this._logger.error?.(`[ScreenerSettings] Could not read ${this._file}: ${err.message}`);
      return this._defaultState();
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.universes || typeof parsed.universes !== "object") {
        throw new SyntaxError("no universes object");
      }

      const universes = {};
      let missing = 0;
      for (const key of SCREENER_KEYS) {
        const list = parsed.universes[key];
        if (!Array.isArray(list)) {
          // A universe the file never mentions is not the same as one an
          // operator emptied: the first is a gap to fill from the defaults,
          // the second is an explicit "scan nothing" that must survive.
          missing += 1;
          universes[key] = this._defaults.slice();
          continue;
        }
        universes[key] = dedupeSymbols(list).filter((symbol) => SYMBOL_PATTERN.test(symbol));
      }

      const added = dedupeSymbols(parsed.added).filter((symbol) => SYMBOL_PATTERN.test(symbol));
      const seededDefaults = dedupeSymbols(parsed.seededDefaults);

      this._loadState = missing ? "partial" : "loaded";
      this._loadError = missing ? `${missing} screener universe(s) restored from defaults` : null;
      if (missing) this._logger.warn?.(`[ScreenerSettings] ${this._loadError} in ${this._file}`);
      return { seededDefaults, added, universes };
    } catch (err) {
      this._loadState = "corrupt";
      this._loadError = err.message;
      this._logger.error?.(
        `[ScreenerSettings] ${this._file} is unreadable (${err.message}); serving the default universes instead`,
      );
      return this._defaultState();
    }
  }

  _write(state) {
    // Preserve whatever could not be parsed before overwriting it, so a
    // corrupt file is recoverable by hand rather than lost to the fix.
    if (this._loadState === "corrupt" && !this._corruptBackedUp) {
      try {
        fs.copyFileSync(this._file, `${this._file}.corrupt`);
        this._corruptBackedUp = true;
        this._logger.warn?.(`[ScreenerSettings] Backed up the unreadable settings to ${this._file}.corrupt`);
      } catch {
        /* best effort — never block the repair on the backup */
      }
    }

    // The last line of defence. Whatever a caller hands us, each universe is
    // a de-duplicated subset of the catalog: a symbol listed twice would be
    // fetched and rendered twice on every scan.
    const catalog = new Set(this._catalogFrom(state));
    const universes = {};
    for (const key of SCREENER_KEYS) {
      universes[key] = dedupeSymbols(state.universes?.[key]).filter((symbol) => catalog.has(symbol));
    }

    const written = writeJsonAtomic(
      this._file,
      {
        version: SETTINGS_VERSION,
        seededDefaults: dedupeSymbols(state.seededDefaults),
        added: dedupeSymbols(state.added).slice(0, MAX_CATALOG),
        universes,
      },
      this._logger,
      "[ScreenerSettings]",
    );
    if (written) {
      this._loadState = "loaded";
      this._loadError = null;
    }
    return written;
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "Screener settings are busy; retry the request.",
    });
  }

  /**
   * Every token the matrix should show: the defaults in their declared order,
   * then operator-added pairs, then any symbol a universe names that neither
   * list covers — a default dropped by a later release is still being scanned,
   * so it must stay visible and removable rather than becoming invisible
   * state.
   */
  _catalogFrom(state) {
    const universeSymbols = SCREENER_KEYS.flatMap((key) => state.universes?.[key] || []);
    return dedupeSymbols([...this._defaults, ...(state.added || []), ...universeSymbols]);
  }

  /** The token catalog, in display order. */
  catalog() {
    return this._catalogFrom(this._read());
  }

  /**
   * The symbols one screener should scan. This is the call the routes make on
   * every request; an empty array is a legitimate answer and means the
   * screener scans nothing.
   */
  getUniverse(screener) {
    const key = assertScreenerKey(screener);
    return this._read().universes[key] || [];
  }

  /** Everything the Settings page needs to draw the matrix in one read. */
  snapshot() {
    const state = this._read();
    const catalog = this._catalogFrom(state);
    const defaults = new Set(this._defaults);
    const counts = {};
    for (const key of SCREENER_KEYS) counts[key] = (state.universes[key] || []).length;
    return {
      version: SETTINGS_VERSION,
      screeners: this.screeners,
      // `isDefault` is what lets the page offer Reset per column and refuse to
      // delete a catalog default, which is unchecked rather than removed.
      catalog: catalog.map((symbol) => ({
        symbol,
        label: symbol.replace(/USDT$/, ""),
        isDefault: defaults.has(symbol),
      })),
      universes: SCREENER_KEYS.reduce((acc, key) => {
        acc[key] = (state.universes[key] || []).slice();
        return acc;
      }, {}),
      counts,
      defaults: this.defaults,
      maxTokens: MAX_CATALOG,
      // Diagnostics, so a page showing the defaults after a bad write says so
      // instead of quietly presenting them as the saved configuration.
      status: { state: this._loadState, error: this._loadError },
    };
  }

  /**
   * Writes the seed on first boot, and offers each later catalog default
   * exactly once. Recording the symbol means a default the operator unchecks
   * stays unchecked on every later boot, while a token a new release adds to
   * TOP_TOKENS starts being scanned the way it would have before this store
   * existed.
   */
  ensureSeeded() {
    return this._withLock(() => {
      if (!fs.existsSync(this._file)) {
        this._write(this._read());
        return true;
      }

      const state = this._read();
      if (this._loadState === "corrupt") return false;
      // A screener added by a later release (Open Interest joined the
      // original three) is missing from an older file. _read() has already
      // filled it from the defaults; writing that once stops every later read
      // from reporting the file as partial.
      const migrated = this._loadState === "partial";
      const seeded = new Set(state.seededDefaults);
      const pending = this._defaults.filter((symbol) => !seeded.has(symbol));
      if (!pending.length) {
        if (!migrated) return false;
        if (!this._write(state)) throw createServiceError("Could not add the new screener universes", 500);
        this._logger.log?.("[ScreenerSettings] Added missing screener universe(s) from the defaults");
        return true;
      }

      for (const key of SCREENER_KEYS) {
        state.universes[key] = dedupeSymbols([...(state.universes[key] || []), ...pending]);
      }
      state.seededDefaults = dedupeSymbols([...state.seededDefaults, ...pending]);
      if (!this._write(state)) throw createServiceError("Could not seed the screener token universes", 500);
      this._logger.log?.(
        `[ScreenerSettings] Added ${pending.length} new default token(s) to every screener: ${pending.join(", ")}`,
      );
      return true;
    });
  }

  /**
   * Replaces the membership of one or more universes. Only the screeners the
   * caller names are touched, so a page that renders two columns can't blank
   * the third by omission.
   */
  save(universes) {
    return this._withLock(() => {
      if (!universes || typeof universes !== "object") {
        throw createServiceError("universes must be an object keyed by screener", 400);
      }
      const requested = Object.keys(universes);
      if (!requested.length) {
        throw createServiceError("At least one screener universe is required", 400);
      }

      const state = this._read();
      const catalog = new Set(this._catalogFrom(state));
      for (const rawKey of requested) {
        const key = assertScreenerKey(rawKey);
        const list = universes[rawKey];
        if (!Array.isArray(list)) {
          throw createServiceError(`universes.${key} must be an array of symbols`, 400);
        }
        const symbols = dedupeSymbols(list).map((symbol) => assertValidSymbol(symbol));
        // Membership is a subset of the catalog, never a back door for adding
        // one: an unverified pair must go through addToken().
        const unknown = symbols.filter((symbol) => !catalog.has(symbol));
        if (unknown.length) {
          throw createServiceError(
            `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the token catalog. Add ${unknown.length === 1 ? "it" : "them"} first.`,
            400,
          );
        }
        state.universes[key] = symbols;
      }

      if (!this._write(state)) throw createServiceError("Could not save the screener token universes", 500);
      return this.snapshot();
    });
  }

  /**
   * Back to the shipped defaults: every default token scanned by every
   * screener. Operator-added pairs stay in the catalog — removing one is an
   * explicit delete, not a side effect of a reset — but are left unselected,
   * because "defaults" is precisely the list that does not include them.
   */
  reset() {
    return this._withLock(() => {
      const state = this._read();
      const next = this._defaultState();
      next.added = dedupeSymbols(state.added);
      if (!this._write(next)) throw createServiceError("Could not reset the screener token universes", 500);
      return this.snapshot();
    });
  }

  /**
   * Adds a Binance USDT pair to the catalog and, by default, to every
   * screener. The pair is verified against Binance *before* the lock is taken:
   * a network call inside an exclusive lock would hold every other writer for
   * the length of a provider timeout.
   */
  async addToken(input, { screeners } = {}) {
    const symbol = assertValidSymbol(input);
    const targets = screeners === undefined || screeners === null
      ? SCREENER_KEYS.slice()
      : (Array.isArray(screeners) ? screeners : [screeners]).map((key) => assertScreenerKey(key));

    // Cheap pre-checks first, so an obvious duplicate or a full catalog is
    // answered without spending a Binance request.
    const existing = this._read();
    const catalog = new Set(this._catalogFrom(existing));
    if (catalog.has(symbol)) {
      throw createServiceError(`${symbol} is already in the token catalog`, 409);
    }
    if (catalog.size >= MAX_CATALOG) {
      throw createServiceError(`At most ${MAX_CATALOG} tokens can be tracked`, 400);
    }

    if (this._verifySymbol) await this._verifySymbol(symbol);

    return this._withLock(() => {
      // Re-read under the lock: the pre-checks above ran before it was held.
      const state = this._read();
      if (this._catalogFrom(state).includes(symbol)) {
        throw createServiceError(`${symbol} is already in the token catalog`, 409);
      }
      state.added = dedupeSymbols([...(state.added || []), symbol]);
      for (const key of targets) {
        state.universes[key] = dedupeSymbols([...(state.universes[key] || []), symbol]);
      }
      if (!this._write(state)) throw createServiceError(`Could not add ${symbol}`, 500);
      return this.snapshot();
    });
  }

  /**
   * Drops an operator-added pair from the catalog and every universe. A
   * catalog default is refused: it is unchecked, not deleted, so the code's
   * own default list stays the thing a reset restores.
   */
  removeToken(input) {
    return this._withLock(() => {
      const symbol = assertValidSymbol(input);
      if (this._defaults.includes(symbol)) {
        throw createServiceError(
          `${symbol} is a default token — uncheck it instead of removing it from the catalog`,
          400,
        );
      }
      const state = this._read();
      if (!this._catalogFrom(state).includes(symbol)) {
        throw createServiceError(`${symbol} is not in the token catalog`, 404);
      }
      state.added = (state.added || []).filter((entry) => entry !== symbol);
      for (const key of SCREENER_KEYS) {
        state.universes[key] = (state.universes[key] || []).filter((entry) => entry !== symbol);
      }
      if (!this._write(state)) throw createServiceError(`Could not remove ${symbol}`, 500);
      return this.snapshot();
    });
  }
}

module.exports = {
  ScreenerSettingsService,
  SCREENERS,
  SCREENER_KEYS,
  MAX_CATALOG,
  normalizeSymbol,
  verifySymbolOnBinance,
};
