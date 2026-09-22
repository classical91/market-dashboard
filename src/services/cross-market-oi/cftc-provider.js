"use strict";

// CFTC Commitments of Traders — Legacy, Futures Only.
//
// The CFTC Public Reporting Environment (publicreporting.cftc.gov) serves the
// weekly COT reports as a Socrata dataset: public domain, free, no key needed.
// An optional app token raises the anonymous rate limit; it is sent from the
// server only and never reaches the browser.
//
// One request covers every configured market: the page needs a handful of
// weekly rows per contract, not a per-market fan-out.
//
// The report is weekly. Positions are as of Tuesday and published the
// following Friday, so the newest row is normally 3–10 days old — that is
// current for this source, not stale.

const LEGACY_FUTURES_ONLY = "6dca-aqww";

const FIELDS = [
  "market_and_exchange_names",
  "report_date_as_yyyy_mm_dd",
  "cftc_contract_market_code",
  "open_interest_all",
  "noncomm_positions_long_all",
  "noncomm_positions_short_all",
  "comm_positions_long_all",
  "comm_positions_short_all",
];

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "2026-09-15T00:00:00.000" → "2026-09-15"; anything unparseable → null. */
function reportDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : null;
}

class CftcCotProvider {
  constructor({
    fetchImpl = fetch,
    baseUrl = "https://publicreporting.cftc.gov",
    appToken = "",
    timeoutMs = 15000,
    dataset = LEGACY_FUTURES_ONLY,
  } = {}) {
    this.id = "cftc-legacy";
    this.label = "CFTC Commitments of Traders — Legacy, Futures Only";
    this._fetch = fetchImpl;
    this._base = baseUrl.replace(/\/+$/, "");
    this._appToken = appToken;
    this._timeoutMs = timeoutMs;
    this._dataset = dataset;
  }

  /**
   * Weekly rows for the given contract codes since `sinceDate` (YYYY-MM-DD),
   * newest first, grouped by contract code.
   */
  async fetchWeekly(codes, { sinceDate }) {
    const quoted = codes.map((code) => `'${String(code).replace(/'/g, "")}'`).join(",");
    const params = new URLSearchParams({
      $select: FIELDS.join(","),
      $where: `cftc_contract_market_code in(${quoted}) AND report_date_as_yyyy_mm_dd >= '${sinceDate}T00:00:00'`,
      $order: "report_date_as_yyyy_mm_dd DESC",
      $limit: "5000",
    });
    const url = `${this._base}/resource/${this._dataset}.json?${params.toString()}`;
    const headers = { Accept: "application/json" };
    if (this._appToken) headers["X-App-Token"] = this._appToken;

    let res;
    try {
      res = await this._fetch(url, { headers, signal: AbortSignal.timeout(this._timeoutMs) });
    } catch (err) {
      const reason = err && err.name === "TimeoutError" ? `timed out after ${this._timeoutMs}ms` : err.message;
      throw new Error(`CFTC request failed: ${reason}`);
    }
    if (!res.ok) throw new Error(`CFTC HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("CFTC returned an unexpected response shape");

    const byCode = new Map();
    for (const row of rows) {
      const code = String(row.cftc_contract_market_code || "").trim();
      const date = reportDate(row.report_date_as_yyyy_mm_dd);
      if (!code || !date) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({
        date,
        marketAndExchange: row.market_and_exchange_names || null,
        openInterest: num(row.open_interest_all),
        nonCommLong: num(row.noncomm_positions_long_all),
        nonCommShort: num(row.noncomm_positions_short_all),
        commLong: num(row.comm_positions_long_all),
        commShort: num(row.comm_positions_short_all),
      });
    }
    for (const list of byCode.values()) list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return byCode;
  }
}

module.exports = { CftcCotProvider, LEGACY_FUTURES_ONLY, reportDate };
