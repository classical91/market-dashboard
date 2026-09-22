"use strict";

// Cross-Market Open Interest — backs GET /api/cross-market-oi.
//
// Compares futures markets that trade on completely different scales (a
// Bitcoin contract, a Natural Gas contract and an S&P 500 contract share no
// unit), so raw contract counts are never plotted. Two metrics are served,
// each with its normalisation stated in the payload:
//
//   OI            total open interest; plotted as the % change over the
//                 lookback (1 or 4 reports). Change in participation, not
//                 direction.
//   COT_NET_SPEC  net non-commercial ("large speculator") position as a % of
//                 open interest; plotted as that level. Direction of the
//                 speculative crowd, bounded by construction to ±100.
//
// These are different quantities and never interchangeable: every row
// carries its metricType. Neither reproduces LuxAlgo's proprietary formula.
//
// Source: CFTC Commitments of Traders, weekly (Tuesday positions, published
// Friday). There is no free, licensed daily OI feed for these exchanges, so
// the page offers Weekly only and says so.
//
// Missing data stays null — a market absent from the report is an error row,
// never a 0% change.

const {
  INSTRUMENTS,
  ASSET_CLASSES,
  DEFAULT_SELECTION,
  MIN_SELECTION,
  MAX_SELECTION,
} = require("../../config/cross-market-oi");

const DAY = 24 * 60 * 60 * 1000;
const LAST_GOOD_KEY = "cross-market-oi:last-good";
const LAST_GOOD_TTL_MS = 60 * DAY;
// Enough weekly reports for a 4-report lookback plus a holiday-shifted week.
const HISTORY_DAYS = 63;

const LOOKBACKS = Object.freeze({ "1w": 1, "4w": 4 });

const METRICS = Object.freeze([
  Object.freeze({
    type: "OI",
    label: "Open interest",
    valueUnit: "contracts",
    plotted: "% change in total open interest over the lookback",
    plottedUnit: "%",
    defaultScale: 25,
  }),
  Object.freeze({
    type: "COT_NET_SPEC",
    label: "COT net speculator positioning",
    valueUnit: "% of open interest",
    plotted: "Net non-commercial position (long − short) as a % of open interest",
    plottedUnit: "% of OI",
    defaultScale: 50,
  }),
]);

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function round(v, digits = 2) {
  if (!isNum(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function dateMs(date) {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The report `weeks` before `current`, allowing a couple of days either way:
 * a federal holiday moves the CFTC's "as of" date off Tuesday. A missing
 * week is null, never the nearest report further back.
 */
function reportWeeksBefore(list, current, weeks) {
  const target = dateMs(current.date) - weeks * 7 * DAY;
  let best = null;
  for (const row of list) {
    const t = dateMs(row.date);
    if (t == null || row === current) continue;
    const gap = Math.abs(t - target);
    if (gap <= 2 * DAY && (!best || gap < best.gap)) best = { row, gap };
  }
  return best ? best.row : null;
}

function netSpecPct(row) {
  if (!row || !isNum(row.nonCommLong) || !isNum(row.nonCommShort) || !isNum(row.openInterest) || row.openInterest <= 0) {
    return null;
  }
  return ((row.nonCommLong - row.nonCommShort) / row.openInterest) * 100;
}

function thirdFriday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return Date.UTC(year, monthIndex, 1 + offset + 14);
}

/**
 * Is `date` inside the window where a quarterly contract's open interest
 * migrates to the next expiry? Three weeks before the third Friday of
 * Mar/Jun/Sep/Dec through one week after.
 */
function inQuarterlyRollWindow(date) {
  const t = dateMs(date);
  if (t == null) return false;
  const year = new Date(t).getUTCFullYear();
  for (const y of [year - 1, year, year + 1]) {
    for (const m of [2, 5, 8, 11]) {
      const expiry = thirdFriday(y, m);
      if (t >= expiry - 21 * DAY && t <= expiry + 7 * DAY) return true;
    }
  }
  return false;
}

class CrossMarketOiService {
  constructor({
    provider,
    cache,
    store = null,
    cacheTtlMs = 60 * 60 * 1000,
    failureCacheTtlMs = 5 * 60 * 1000,
    staleAfterDays = 11,
    instruments = INSTRUMENTS,
    now = () => Date.now(),
    logger = console,
  }) {
    this._provider = provider;
    this._cache = cache;
    this._store = store;
    this._cacheTtlMs = cacheTtlMs;
    this._failureCacheTtlMs = failureCacheTtlMs;
    this._staleAfterDays = staleAfterDays;
    this._instruments = instruments;
    this._now = now;
    this._logger = logger;
  }

  _loadLastGood() {
    try {
      const stored = this._store && this._store.get(LAST_GOOD_KEY);
      return stored && stored.history && stored.fetchedAt ? stored : null;
    } catch {
      return null;
    }
  }

  _saveLastGood(record) {
    if (!this._store) return;
    try {
      this._store.set(LAST_GOOD_KEY, record, LAST_GOOD_TTL_MS);
    } catch (err) {
      this._logger.error?.(`[CrossMarketOI] Could not persist the last good report: ${err.message}`);
    }
  }

  /**
   * Raw weekly history for every configured market: fresh from the CFTC when
   * it answers, otherwise the last good copy, with the failure recorded.
   */
  async _history({ force = false } = {}) {
    const key = "cross-market-oi:history";
    if (force) this._cache.delete(key);
    const cached = this._cache.get(key);
    if (cached) return cached;
    const loaded = await this._cache.getOrLoad(key, 0, async () => {
      const since = isoDate(this._now() - HISTORY_DAYS * DAY);
      try {
        const byCode = await this._provider.fetchWeekly(this._instruments.map((i) => i.contract), { sinceDate: since });
        if (!byCode.size) throw new Error("CFTC returned no rows for the configured markets");
        const record = { history: Object.fromEntries(byCode), fetchedAt: new Date(this._now()).toISOString() };
        this._saveLastGood(record);
        return { ...record, status: "LIVE", error: null };
      } catch (err) {
        this._logger.warn?.(`[CrossMarketOI] ${err.message}`);
        const lastGood = this._loadLastGood();
        if (lastGood) return { ...lastGood, status: "CACHED", error: err.message };
        return { history: {}, fetchedAt: null, status: "UNAVAILABLE", error: err.message };
      }
    });
    this._cache.set(key, loaded, loaded.status === "LIVE" ? this._cacheTtlMs : this._failureCacheTtlMs);
    return loaded;
  }

  _freshness(date) {
    const t = dateMs(date);
    if (t == null) return { state: "UNKNOWN", ageDays: null, reason: "No report date" };
    const ageDays = Math.floor((this._now() - t) / DAY);
    if (ageDays > this._staleAfterDays) {
      return { state: "STALE", ageDays, reason: `Latest CFTC report is as of ${date} (${ageDays} days old); a newer weekly report was expected` };
    }
    return { state: "FRESH", ageDays, reason: null };
  }

  _rows(instrument, list, weeks, status) {
    const base = {
      id: instrument.id,
      symbol: instrument.symbol,
      marketName: instrument.marketName,
      exchange: instrument.exchange,
      assetClass: instrument.assetClass,
      contract: instrument.contract,
      timeframe: "W",
      lookback: `${weeks}W`,
      source: "CFTC COT · Legacy, Futures Only",
    };
    const current = list && list.length ? list[0] : null;
    if (!current || !isNum(current.openInterest)) {
      const error = status === "UNAVAILABLE"
        ? "CFTC report unavailable"
        : `No CFTC report rows for contract ${instrument.contract}`;
      return METRICS.map((m) => ({
        ...base,
        metricType: m.type,
        currentValue: null,
        previousValue: null,
        change: null,
        changePct: null,
        normalizedValue: null,
        observationDate: null,
        previousDate: null,
        reportName: null,
        rollWindow: false,
        freshness: { state: "UNKNOWN", ageDays: null, reason: error },
        error,
      }));
    }

    const previous = reportWeeksBefore(list, current, weeks);
    const freshness = this._freshness(current.date);
    const rollWindow = instrument.roll === "quarterly" && inQuarterlyRollWindow(current.date);
    const common = {
      ...base,
      observationDate: current.date,
      previousDate: previous ? previous.date : null,
      reportName: current.marketAndExchange,
      rollWindow,
      freshness,
      error: null,
    };

    const oiChange = previous && isNum(previous.openInterest) ? current.openInterest - previous.openInterest : null;
    const oiChangePct = previous && isNum(previous.openInterest) && previous.openInterest > 0
      ? (oiChange / previous.openInterest) * 100
      : null;

    const netNow = netSpecPct(current);
    const netThen = netSpecPct(previous);

    return [
      {
        ...common,
        metricType: "OI",
        currentValue: current.openInterest,
        previousValue: previous ? previous.openInterest : null,
        change: oiChange,
        changePct: round(oiChangePct, 2),
        normalizedValue: round(oiChangePct, 2),
      },
      {
        ...common,
        metricType: "COT_NET_SPEC",
        currentValue: round(netNow, 2),
        previousValue: round(netThen, 2),
        // Percentage points, not a percent of a percent.
        change: isNum(netNow) && isNum(netThen) ? round(netNow - netThen, 2) : null,
        changePct: null,
        normalizedValue: round(netNow, 2),
        netContracts: isNum(current.nonCommLong) && isNum(current.nonCommShort) ? current.nonCommLong - current.nonCommShort : null,
      },
    ];
  }

  async snapshot({ lookback = "1w", force = false } = {}) {
    const weeks = LOOKBACKS[lookback] || LOOKBACKS["1w"];
    const history = await this._history({ force });
    const rows = [];
    for (const instrument of this._instruments) {
      rows.push(...this._rows(instrument, history.history[instrument.contract], weeks, history.status));
    }
    const dates = rows.map((r) => r.observationDate).filter(Boolean).sort();
    const latest = dates.length ? dates[dates.length - 1] : null;
    const reportFreshness = this._freshness(latest);
    // A served-from-disk copy is never presented as live.
    let status = history.status;
    if (status === "CACHED" && reportFreshness.state === "STALE") status = "STALE";

    const covered = new Set(rows.filter((r) => !r.error).map((r) => r.id)).size;
    return {
      updatedAt: new Date(this._now()).toISOString(),
      timeframe: "W",
      timeframes: [
        { key: "D", label: "Daily", available: false, reason: "No free, licensed daily open-interest feed for CME/ICE/COMEX/NYMEX" },
        { key: "W", label: "Weekly", available: true, reason: null },
      ],
      lookback: `${weeks}W`,
      lookbacks: Object.keys(LOOKBACKS).map((key) => ({ key, label: `${LOOKBACKS[key]}W` })),
      metrics: METRICS,
      assetClasses: ASSET_CLASSES,
      instruments: this._instruments.map((i) => ({ ...i })),
      defaultSelection: DEFAULT_SELECTION.slice(),
      selectionLimits: { min: MIN_SELECTION, max: MAX_SELECTION },
      source: {
        label: this._provider.label,
        url: "https://publicreporting.cftc.gov/",
        cadence: "Weekly — positions as of Tuesday, published Friday 3:30pm ET",
        fetchedAt: history.fetchedAt,
        reportDate: latest,
        status,
        error: history.error,
      },
      freshness: reportFreshness,
      coverage: { markets: this._instruments.length, withData: covered },
      rows,
    };
  }
}

module.exports = { CrossMarketOiService, METRICS, LOOKBACKS, inQuarterlyRollWindow, reportWeeksBefore, netSpecPct };
