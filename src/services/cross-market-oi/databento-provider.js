"use strict";

// Daily futures open interest from Databento (paid, keyed).
//
// Exchanges publish open interest once per trading day, after settlement, so
// Daily is the finest timeframe that exists for these markets — there is no
// 4h or 8h figure to fetch from anyone. The CFTC's free report is weekly; a
// daily series needs an exchange-data licence, which Databento resells on a
// usage basis.
//
// Each market is requested by its parent symbol (e.g. GC.FUT = every listed
// Gold futures expiry) from the `statistics` schema. Open-interest records
// (stat_type 9) are summed across expiries per trading date, giving the same
// "all futures" total the CFTC figure describes.
//
// The key is sent as HTTP basic auth from the server only and never reaches a
// browser or a response.

const OPEN_INTEREST_STAT = 9;
const UPDATE_DELETE = 2;
// Databento's "undefined" quantity sentinel (INT32_MAX); never a real OI.
const UNDEF_QUANTITY = 2147483647;

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The trading date a statistics record refers to, as YYYY-MM-DD. */
function recordDate(record) {
  const ref = record.ts_ref;
  const event = record.hd && record.hd.ts_event;
  for (const value of [ref, event]) {
    if (value == null) continue;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const n = Number(value);
    // Nanosecond epoch when pretty_ts is off.
    if (Number.isFinite(n) && n > 0 && n < 9e18) return new Date(Math.floor(n / 1e6)).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * A calendar spread (e.g. "ESZ6-ESH7") or a user-defined strategy ("UD:…").
 * A parent symbol covers these as well as the outright expiries, and any open
 * interest a spread reported would count the same positions twice. Records
 * without a mapped symbol are kept: nothing says they are spreads.
 */
function isSpreadSymbol(symbol) {
  return typeof symbol === "string" && (symbol.includes("-") || /^UD:/i.test(symbol));
}

/**
 * Newline-delimited JSON statistics records → [{ date, openInterest,
 * contracts }], newest first, summed across every outright expiry
 * (instrument_id) of the product. `contracts` is how many expiries the day's
 * total is made of, so a thin or partial day can be seen for what it is.
 */
function aggregateOpenInterest(text) {
  // (instrument_id, date) → latest open interest for that expiry on that day.
  const perExpiry = new Map();
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (Number(record.stat_type) !== OPEN_INTEREST_STAT) continue;
    if (isSpreadSymbol(record.symbol)) continue;
    const date = recordDate(record);
    const instrument = record.hd ? record.hd.instrument_id : record.instrument_id;
    if (!date || instrument == null) continue;
    const key = `${instrument}|${date}`;
    // A delete withdraws that expiry's figure for the day; it is not skipped,
    // or the withdrawn number would still be summed.
    if (Number(record.update_action) === UPDATE_DELETE) {
      perExpiry.delete(key);
      continue;
    }
    const quantity = num(record.quantity);
    if (quantity == null || quantity < 0 || quantity >= UNDEF_QUANTITY) continue;
    // Later records for the same expiry and day are corrections; keep the last.
    perExpiry.set(key, { date, quantity });
  }
  const byDate = new Map();
  for (const { date, quantity } of perExpiry.values()) {
    const day = byDate.get(date) || { openInterest: 0, contracts: 0 };
    day.openInterest += quantity;
    day.contracts += 1;
    byDate.set(date, day);
  }
  return [...byDate.entries()]
    .map(([date, day]) => ({ date, openInterest: day.openInterest, contracts: day.contracts }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

class DatabentoDailyOiProvider {
  constructor({
    apiKey = "",
    fetchImpl = fetch,
    baseUrl = "https://hist.databento.com",
    timeoutMs = 20000,
  } = {}) {
    this.id = "databento";
    this.label = "Databento — exchange daily open interest";
    this._apiKey = apiKey;
    this._fetch = fetchImpl;
    this._base = baseUrl.replace(/\/+$/, "");
    this._timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this._apiKey);
  }

  async _fetchProduct({ dataset, parent }, startDate) {
    const params = new URLSearchParams({
      dataset,
      schema: "statistics",
      symbols: parent,
      stype_in: "parent",
      start: startDate,
      encoding: "json",
      pretty_ts: "true",
      // Adds each record's raw symbol, so spreads can be told from outrights.
      map_symbols: "true",
    });
    const url = `${this._base}/v0/timeseries.get_range?${params.toString()}`;
    const auth = Buffer.from(`${this._apiKey}:`).toString("base64");
    let res;
    try {
      res = await this._fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (err) {
      const reason = err && err.name === "TimeoutError" ? `timed out after ${this._timeoutMs}ms` : err.message;
      throw new Error(`Databento request failed: ${reason}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        const body = JSON.parse(text);
        detail = body.detail ? ` — ${typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)}` : "";
      } catch {
        /* non-JSON error body */
      }
      // Never echo the key: the detail is Databento's message, not our request.
      throw new Error(`Databento HTTP ${res.status}${detail}`);
    }
    return aggregateOpenInterest(text);
  }

  /**
   * Daily open interest per instrument id since `startDate`, newest first.
   * One product failing leaves only that product missing.
   */
  async fetchDaily(instruments, { startDate }) {
    if (!this.configured) throw new Error("DATABENTO_API_KEY is not set");
    const results = new Map();
    const errors = {};
    await Promise.all(instruments.map(async (instrument) => {
      if (!instrument.daily) {
        errors[instrument.id] = "No daily source configured";
        return;
      }
      try {
        const rows = await this._fetchProduct(instrument.daily, startDate);
        if (rows.length) results.set(instrument.id, rows);
        else errors[instrument.id] = `No open-interest records for ${instrument.daily.parent}`;
      } catch (err) {
        errors[instrument.id] = err.message;
      }
    }));
    if (!results.size) {
      const first = Object.values(errors)[0];
      throw new Error(first || "Databento returned no open interest");
    }
    return { byId: results, errors };
  }
}

module.exports = { DatabentoDailyOiProvider, aggregateOpenInterest, recordDate, isSpreadSymbol, OPEN_INTEREST_STAT };
