"use strict";

// One fetch wrapper for every RSI Matrix venue, so each provider file is only
// the venue's URL and row shape.
//
// Errors carry a `scope`, the same idea as open-interest/providers.js:
//   "symbol" — the venue answered and does not know this symbol (400/404, or a
//              venue-specific "no such market" body). Settings uses this to
//              reject a bad symbol at save time.
//   "venue"  — the venue could not be asked (timeout, 403/451 geo-block, 429,
//              5xx). A symbol is never reported as invalid because of this.

const DEFAULT_TIMEOUT_MS = 8000;

function providerError(message, scope = "venue", status = null) {
  const err = new Error(message);
  err.scope = scope;
  err.status = status;
  return err;
}

async function fetchJson(fetchImpl, url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, label = "provider" } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err.message;
    throw providerError(`${label} request failed: ${reason}`, "venue");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const scope = res.status === 400 || res.status === 404 ? "symbol" : "venue";
    const detail = body && (body.msg || body.message || (body.chart && body.chart.error && body.chart.error.description));
    throw providerError(`${label} HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, scope, res.status);
  }
  return body;
}

module.exports = { providerError, fetchJson, DEFAULT_TIMEOUT_MS };
