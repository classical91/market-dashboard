"use strict";

// Cross-Market Open Interest — backs GET /api/cross-market-oi.
//
// Compares futures markets that trade on completely different scales (a
// Bitcoin contract, a Natural Gas contract and an S&P 500 contract share no
// unit), so raw contract counts are never plotted. Two metrics are served,
// each with its normalisation stated in the payload:
//
//   OI            total open interest across every listed expiry of the
//                 product (the CFTC's "all" figure; Daily sums the same set);
//                 plotted as the % change between two comparable
//                 observations: ((current − previous) / previous) × 100.
//                 Change in participation, not direction. It is not a
//                 front-month or continuous-contract (e.g. ES1!) figure, and
//                 around an expiry it moves with the roll — see rollWindow.
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
// never a 0% change. Every row says why a value is missing (valueStatus),
// which observations it compares and when they were retrieved, and whether it
// came from a saved copy (isFallback) or is behind the rest (isStale).

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
// Daily lookbacks count trading days: the series only has sessions.
const DAILY_LOOKBACKS = Object.freeze({ "1d": 1, "5d": 5 });
const DAILY_LAST_GOOD_KEY = "cross-market-oi:daily-last-good";
// Enough calendar days for a 5-session lookback across a long weekend.
const DAILY_HISTORY_DAYS = 14;
const DAILY_UNAVAILABLE_REASON = "Daily open interest needs a Databento API key (DATABENTO_API_KEY). Exchanges publish OI once per session; there is no free daily feed.";

const METRICS = Object.freeze([
  Object.freeze({
    type: "OI",
    label: "OI change, all expiries",
    valueUnit: "contracts",
    plotted: "% change in total open interest (every listed expiry combined) between the two report dates",
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
 * The quarterly expiry (third Friday of Mar/Jun/Sep/Dec, as YYYY-MM-DD) whose
 * roll window — three weeks before through one week after — overlaps the
 * span from `fromDate` to `toDate`, or null. A change is distorted by the
 * roll when either end of it is, not only when the newest report is: a 4W
 * change measured from the week before an expiry reads the roll even when
 * today is well clear of it.
 */
function quarterlyRollExpiry(fromDate, toDate = fromDate) {
  const a = dateMs(fromDate || toDate);
  const b = dateMs(toDate || fromDate);
  if (a == null || b == null) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const year = new Date(hi).getUTCFullYear();
  let found = null;
  for (const y of [year - 1, year, year + 1]) {
    for (const m of [2, 5, 8, 11]) {
      const expiry = thirdFriday(y, m);
      if (hi >= expiry - 21 * DAY && lo <= expiry + 7 * DAY) found = expiry;
    }
  }
  return found == null ? null : isoDate(found);
}

/** Is `date` itself inside a quarterly roll window? */
function inQuarterlyRollWindow(date) {
  return quarterlyRollExpiry(date) != null;
}

/**
 * The comparable change between two open-interest observations, or why there
 * isn't one. Never a number from a missing or zero base.
 */
function oiChange(current, previous) {
  if (!previous) return { change: null, changePct: null, valueStatus: "INSUFFICIENT_HISTORY" };
  if (!isNum(previous.openInterest)) return { change: null, changePct: null, valueStatus: "INSUFFICIENT_HISTORY" };
  const change = current.openInterest - previous.openInterest;
  if (previous.openInterest <= 0) return { change, changePct: null, valueStatus: "ZERO_BASE" };
  return { change, changePct: (change / previous.openInterest) * 100, valueStatus: "OK" };
}

function nameMatches(pattern, name) {
  if (!pattern || !name) return null;
  try {
    return new RegExp(pattern, "i").test(name);
  } catch {
    return null;
  }
}

// Calendar days a daily comparison may span before a session is taken to be
// missing: a weekend plus a market holiday for 1D, two holidays for 5D.
const DAILY_MAX_SPAN_DAYS = Object.freeze({ 1: 4, 5: 10 });

function dailyMaxSpan(sessions) {
  return DAILY_MAX_SPAN_DAYS[sessions] || Math.ceil((sessions * 7) / 5) + 4;
}

class CrossMarketOiService {
  constructor({
    provider,
    cache,
    store = null,
    cacheTtlMs = 60 * 60 * 1000,
    failureCacheTtlMs = 5 * 60 * 1000,
    staleAfterDays = 11,
    // Optional: a keyed daily provider (Databento). Without one, Daily is
    // offered as unavailable, with the reason, and Weekly is unaffected.
    dailyProvider = null,
    dailyStaleAfterDays = 4,
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
    this._dailyProvider = dailyProvider;
    this._dailyStaleAfterDays = dailyStaleAfterDays;
    this._instruments = instruments;
    this._now = now;
    this._logger = logger;
  }

  _loadLastGood(key = LAST_GOOD_KEY) {
    try {
      const stored = this._store && this._store.get(key);
      return stored && stored.history && stored.fetchedAt ? stored : null;
    } catch {
      return null;
    }
  }

  _saveLastGood(record, key = LAST_GOOD_KEY) {
    if (!this._store) return;
    try {
      this._store.set(key, record, LAST_GOOD_TTL_MS);
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

  get dailyAvailable() {
    return Boolean(this._dailyProvider && this._dailyProvider.configured);
  }

  /**
   * Daily open interest per market: fresh from the daily provider, otherwise
   * the last good copy. Cached separately from the weekly report, which it
   * never affects.
   */
  async _dailyHistory({ force = false } = {}) {
    const key = "cross-market-oi:daily-history";
    if (force) this._cache.delete(key);
    const cached = this._cache.get(key);
    if (cached) return cached;
    const loaded = await this._cache.getOrLoad(key, 0, async () => {
      const since = isoDate(this._now() - DAILY_HISTORY_DAYS * DAY);
      try {
        const { byId, errors } = await this._dailyProvider.fetchDaily(this._instruments, { startDate: since });
        const record = { history: Object.fromEntries(byId), errors, fetchedAt: new Date(this._now()).toISOString() };
        this._saveLastGood(record, DAILY_LAST_GOOD_KEY);
        return { ...record, status: "LIVE", error: null };
      } catch (err) {
        this._logger.warn?.(`[CrossMarketOI] daily: ${err.message}`);
        const lastGood = this._loadLastGood(DAILY_LAST_GOOD_KEY);
        if (lastGood) return { ...lastGood, status: "CACHED", error: err.message };
        return { history: {}, errors: {}, fetchedAt: null, status: "UNAVAILABLE", error: err.message };
      }
    });
    this._cache.set(key, loaded, loaded.status === "LIVE" ? this._cacheTtlMs : this._failureCacheTtlMs);
    return loaded;
  }

  _freshness(date, timeframe = "W") {
    const t = dateMs(date);
    if (t == null) return { state: "UNKNOWN", ageDays: null, reason: "No report date" };
    const ageDays = Math.floor((this._now() - t) / DAY);
    const limit = timeframe === "D" ? this._dailyStaleAfterDays : this._staleAfterDays;
    if (ageDays > limit) {
      const what = timeframe === "D" ? "daily open interest" : "CFTC report";
      const expected = timeframe === "D" ? "a newer session" : "a newer weekly report";
      return { state: "STALE", ageDays, reason: `Latest ${what} is as of ${date} (${ageDays} days old); ${expected} was expected` };
    }
    return { state: "FRESH", ageDays, reason: null };
  }

  _emptyRows(base, error) {
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
      comparisonDate: null,
      reportName: null,
      rollWindow: false,
      rollExpiry: null,
      valueStatus: "UNAVAILABLE",
      freshness: { state: "UNKNOWN", ageDays: null, reason: error },
      error,
    }));
  }

  /**
   * Daily rows. Open interest only: COT positioning is a CFTC weekly
   * quantity and has no daily equivalent, so that row says so rather than
   * repeating the week's number as if it were today's.
   */
  _dailyRows(instrument, list, sessions, status, productError) {
    const base = {
      id: instrument.id,
      symbol: instrument.symbol,
      marketName: instrument.marketName,
      exchange: instrument.exchange,
      assetClass: instrument.assetClass,
      contract: instrument.contract,
      timeframe: "D",
      lookback: `${sessions}D`,
      source: `Databento · ${instrument.daily ? `${instrument.daily.dataset} ${instrument.daily.parent}` : "not configured"}`,
      contractScope: "ALL_EXPIRIES",
      // An aggregate of every listed expiry has no single expiration.
      expiration: null,
      // Databento's statistics records carry no preliminary/final flag here.
      isPreliminary: null,
      identityVerified: null,
    };
    const current = list && list.length ? list[0] : null;
    if (!current || !isNum(current.openInterest)) {
      const error = status === "UNAVAILABLE"
        ? "Daily open interest unavailable"
        : productError || `No daily open interest for ${instrument.daily ? instrument.daily.parent : instrument.id}`;
      return this._emptyRows(base, error);
    }
    // The Nth entry back is N sessions back only if no session is missing
    // from the series; a gap longer than a weekend and holidays means it isn't,
    // and the comparison is refused rather than quietly stretched.
    let previous = list[sessions] || null;
    let statusReason = null;
    if (previous) {
      const span = Math.round((dateMs(current.date) - dateMs(previous.date)) / DAY);
      if (!(span > 0) || span > dailyMaxSpan(sessions)) {
        statusReason = `The session ${sessions} back in the series is ${previous.date}, ${span} days before ${current.date}; a session is missing`;
        previous = null;
      }
    }
    const delta = oiChange(current, previous);
    if (!statusReason && delta.valueStatus === "INSUFFICIENT_HISTORY") statusReason = `Fewer than ${sessions + 1} sessions of open interest are available`;
    if (delta.valueStatus === "ZERO_BASE") statusReason = `Open interest on ${previous.date} was 0; a % change from 0 is undefined`;
    const rollExpiry = instrument.roll === "quarterly" ? quarterlyRollExpiry(previous ? previous.date : current.date, current.date) : null;
    const common = {
      ...base,
      observationDate: current.date,
      previousDate: previous ? previous.date : null,
      comparisonDate: previous ? previous.date : null,
      reportName: instrument.daily ? instrument.daily.parent : null,
      contractsCounted: isNum(current.contracts) ? current.contracts : null,
      previousContractsCounted: previous && isNum(previous.contracts) ? previous.contracts : null,
      rollWindow: rollExpiry != null,
      rollExpiry,
      freshness: this._freshness(current.date, "D"),
      error: null,
    };
    const weeklyOnly = "COT positioning is published weekly only";
    return [
      {
        ...common,
        metricType: "OI",
        currentValue: current.openInterest,
        previousValue: previous ? previous.openInterest : null,
        change: delta.change,
        changePct: round(delta.changePct, 2),
        normalizedValue: round(delta.changePct, 2),
        valueStatus: delta.valueStatus,
        statusReason,
      },
      {
        ...common,
        metricType: "COT_NET_SPEC",
        currentValue: null,
        previousValue: null,
        change: null,
        changePct: null,
        normalizedValue: null,
        valueStatus: "UNAVAILABLE",
        freshness: { state: "UNKNOWN", ageDays: null, reason: weeklyOnly },
        error: weeklyOnly,
      },
    ];
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
      // The CFTC's open_interest_all: every listed expiry of the contract
      // market combined. There is no per-expiry or front-month figure in it.
      contractScope: "ALL_EXPIRIES",
      expiration: null,
      // The CFTC publishes one figure per report date with no preliminary
      // flag; unknown rather than asserted either way.
      isPreliminary: null,
      identityVerified: null,
    };
    let rows = list || [];
    // The contract code is the key, but the reported name must still be the
    // market we say it is: a wrong code must not plot another market (the
    // Micro contract, the consolidated index) under this one's label.
    if (instrument.cftcName && rows.length) {
      const newest = rows[0];
      if (nameMatches(instrument.cftcName, newest.marketAndExchange) === false) {
        const rowsOut = this._emptyRows(base, `CFTC contract ${instrument.contract} reports as "${newest.marketAndExchange}", not ${instrument.marketName}`);
        return rowsOut.map((r) => ({ ...r, valueStatus: "IDENTITY_MISMATCH", reportName: newest.marketAndExchange, identityVerified: false }));
      }
      // An older report under a different name is a different market; it is
      // never the base of a comparison.
      rows = rows.filter((r) => nameMatches(instrument.cftcName, r.marketAndExchange) !== false);
    }
    const current = rows.length ? rows[0] : null;
    if (!current || !isNum(current.openInterest)) {
      const error = status === "UNAVAILABLE"
        ? "CFTC report unavailable"
        : `No CFTC report rows for contract ${instrument.contract}`;
      return this._emptyRows(base, error);
    }
    base.identityVerified = nameMatches(instrument.cftcName, current.marketAndExchange);

    const previous = reportWeeksBefore(rows, current, weeks);
    const freshness = this._freshness(current.date);
    const rollExpiry = instrument.roll === "quarterly" ? quarterlyRollExpiry(previous ? previous.date : current.date, current.date) : null;
    const common = {
      ...base,
      observationDate: current.date,
      previousDate: previous ? previous.date : null,
      comparisonDate: previous ? previous.date : null,
      reportName: current.marketAndExchange,
      rollWindow: rollExpiry != null,
      rollExpiry,
      freshness,
      error: null,
    };

    const delta = oiChange(current, previous);
    const missingReason = delta.valueStatus === "INSUFFICIENT_HISTORY"
      ? `No CFTC report ${weeks} week${weeks === 1 ? "" : "s"} before ${current.date} to compare with`
      : delta.valueStatus === "ZERO_BASE"
        ? `Open interest on ${previous.date} was 0; a % change from 0 is undefined`
        : null;

    const netNow = netSpecPct(current);
    const netThen = netSpecPct(previous);

    return [
      {
        ...common,
        metricType: "OI",
        currentValue: current.openInterest,
        previousValue: previous ? previous.openInterest : null,
        change: delta.change,
        changePct: round(delta.changePct, 2),
        normalizedValue: round(delta.changePct, 2),
        valueStatus: delta.valueStatus,
        statusReason: missingReason,
      },
      {
        ...common,
        metricType: "COT_NET_SPEC",
        // The level is plotted; it needs only the current report.
        valueStatus: isNum(netNow) ? "OK" : "UNAVAILABLE",
        statusReason: isNum(netNow) ? null : "Speculator positions are missing from the report",
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

  _timeframes() {
    return [
      {
        key: "D",
        label: "Daily",
        available: this.dailyAvailable,
        reason: this.dailyAvailable ? null : DAILY_UNAVAILABLE_REASON,
        lookbacks: Object.keys(DAILY_LOOKBACKS).map((key) => ({ key, label: `${DAILY_LOOKBACKS[key]}D` })),
        metrics: ["OI"],
      },
      {
        key: "W",
        label: "Weekly",
        available: true,
        reason: null,
        lookbacks: Object.keys(LOOKBACKS).map((key) => ({ key, label: `${LOOKBACKS[key]}W` })),
        metrics: METRICS.map((m) => m.type),
      },
    ];
  }

  /**
   * Row metadata that depends on the whole fetch: when it was retrieved,
   * whether it is a saved copy, and whether this market is behind the rest.
   * Every market in a CFTC report shares one date, and every product in a
   * Databento pull should reach the same session; a market that doesn't is
   * showing an older observation and is marked STALE, never passed off as
   * concurrent with its neighbours.
   */
  _annotate(rows, { status, fetchedAt, latest, toleranceDays, what }) {
    const isFallback = status === "CACHED" || status === "STALE";
    const latestMs = dateMs(latest);
    return rows.map((row) => {
      const out = { ...row, retrievedAt: fetchedAt || null, isFallback: row.observationDate ? isFallback : false };
      const t = dateMs(row.observationDate);
      if (t != null && latestMs != null && latestMs - t > toleranceDays * DAY) {
        out.freshness = {
          state: "STALE",
          ageDays: out.freshness.ageDays,
          reason: `Latest ${what} for this market is as of ${row.observationDate}; other markets are as of ${latest}`,
        };
      }
      out.isStale = out.freshness.state === "STALE";
      return out;
    });
  }

  _payload({ timeframe, lookbackLabel, lookbacks, rows, source, freshness }) {
    const oiRows = rows.filter((r) => r.metricType === "OI");
    const covered = oiRows.filter((r) => isNum(r.normalizedValue)).length;
    const reported = oiRows.filter((r) => !r.error).length;
    return {
      updatedAt: new Date(this._now()).toISOString(),
      timeframe,
      timeframes: this._timeframes(),
      lookback: lookbackLabel,
      lookbacks,
      metrics: METRICS,
      assetClasses: ASSET_CLASSES,
      instruments: this._instruments.map((i) => ({ ...i })),
      defaultSelection: DEFAULT_SELECTION.slice(),
      selectionLimits: { min: MIN_SELECTION, max: MAX_SELECTION },
      source,
      freshness,
      // withData: markets with a plotted value; reported: markets present in
      // the source at all (a reported market can still lack a comparison).
      coverage: { markets: this._instruments.length, withData: covered, reported },
      rows,
    };
  }

  async snapshot({ timeframe = "W", lookback, force = false } = {}) {
    if (timeframe === "D") return this._dailySnapshot({ lookback, force });
    const weeks = LOOKBACKS[lookback] || LOOKBACKS["1w"];
    const history = await this._history({ force });
    let rows = [];
    for (const instrument of this._instruments) {
      rows.push(...this._rows(instrument, history.history[instrument.contract], weeks, history.status));
    }
    const dates = rows.map((r) => r.observationDate).filter(Boolean).sort();
    const latest = dates.length ? dates[dates.length - 1] : null;
    const reportFreshness = this._freshness(latest);
    // A served-from-disk copy is never presented as live.
    let status = history.status;
    if (status === "CACHED" && reportFreshness.state === "STALE") status = "STALE";
    // Two days' slack: a holiday moves a report's "as of" date off Tuesday.
    rows = this._annotate(rows, { status, fetchedAt: history.fetchedAt, latest, toleranceDays: 2, what: "CFTC report" });

    return this._payload({
      timeframe: "W",
      lookbackLabel: `${weeks}W`,
      lookbacks: Object.keys(LOOKBACKS).map((key) => ({ key, label: `${LOOKBACKS[key]}W` })),
      rows,
      freshness: reportFreshness,
      source: {
        label: this._provider.label,
        url: "https://publicreporting.cftc.gov/",
        cadence: "Weekly — positions as of Tuesday, published Friday 3:30pm ET",
        fetchedAt: history.fetchedAt,
        reportDate: latest,
        status,
        error: history.error,
      },
    });
  }

  async _dailySnapshot({ lookback, force }) {
    const sessions = DAILY_LOOKBACKS[lookback] || DAILY_LOOKBACKS["1d"];
    const lookbacks = Object.keys(DAILY_LOOKBACKS).map((key) => ({ key, label: `${DAILY_LOOKBACKS[key]}D` }));
    const sourceBase = {
      label: this._dailyProvider ? this._dailyProvider.label : "Databento — exchange daily open interest",
      url: "https://databento.com/",
      cadence: "Daily — exchange open interest per trading session, summed across expiries",
    };
    if (!this.dailyAvailable) {
      const rows = [];
      for (const instrument of this._instruments) rows.push(...this._dailyRows(instrument, null, sessions, "UNAVAILABLE", null));
      return this._payload({
        rows: this._annotate(rows, { status: "UNAVAILABLE", fetchedAt: null, latest: null, toleranceDays: 0, what: "session" }),
        timeframe: "D",
        lookbackLabel: `${sessions}D`,
        lookbacks,
        freshness: { state: "UNKNOWN", ageDays: null, reason: DAILY_UNAVAILABLE_REASON },
        source: { ...sourceBase, fetchedAt: null, reportDate: null, status: "UNAVAILABLE", error: DAILY_UNAVAILABLE_REASON },
      });
    }
    const history = await this._dailyHistory({ force });
    let rows = [];
    for (const instrument of this._instruments) {
      rows.push(...this._dailyRows(
        instrument,
        history.history[instrument.id],
        sessions,
        history.status,
        history.errors ? history.errors[instrument.id] : null,
      ));
    }
    const dates = rows.map((r) => r.observationDate).filter(Boolean).sort();
    const latest = dates.length ? dates[dates.length - 1] : null;
    const freshness = this._freshness(latest, "D");
    let status = history.status;
    if (status === "CACHED" && freshness.state === "STALE") status = "STALE";
    rows = this._annotate(rows, { status, fetchedAt: history.fetchedAt, latest, toleranceDays: 0, what: "session" });
    return this._payload({
      timeframe: "D",
      lookbackLabel: `${sessions}D`,
      lookbacks,
      rows,
      freshness,
      source: { ...sourceBase, fetchedAt: history.fetchedAt, reportDate: latest, status, error: history.error },
    });
  }
}

module.exports = {
  CrossMarketOiService,
  METRICS,
  LOOKBACKS,
  DAILY_LOOKBACKS,
  inQuarterlyRollWindow,
  quarterlyRollExpiry,
  reportWeeksBefore,
  netSpecPct,
  oiChange,
};
