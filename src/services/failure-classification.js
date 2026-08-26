"use strict";

/**
 * Failure classification for the newsroom pipeline.
 *
 * The point of this module is a single question: *may this be retried?* A
 * timeout or a 502 is worth another attempt on the next cycle. A 401 is not —
 * retrying it burns quota, fills the ledger with identical failures and hides
 * the one thing an operator needs to see, which is that a credential or a
 * provider route is wrong. The August 11 ShareBot cron failure ("HTTP 401:
 * User not found") is exactly that shape, so it gets its own code rather than
 * being lumped in with generic auth.
 *
 * Nothing here decides *whether* to retry — callers do. This only labels the
 * failure, and the label is persisted on the cycle so the decision is
 * auditable after the fact.
 */

const RETRYABLE = "retryable";
const NON_RETRYABLE = "non_retryable";
// Deliberately its own class rather than a default of "retryable": an error we
// cannot read is not evidence that trying again is safe.
const UNKNOWN = "unknown";

const FAILURE_CLASSES = [RETRYABLE, NON_RETRYABLE, UNKNOWN];

// Transport-level codes. Every one of these means the request never reached a
// decision on the far side, so the same request is still valid.
const RETRYABLE_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  // DNS can fail transiently behind a proxy or during a deploy. A genuinely
  // wrong hostname repeats identically, which the cycle history makes visible.
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const MAX_MESSAGE_LEN = 500;

function clamp(value, max = MAX_MESSAGE_LEN) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function statusOf(err) {
  const candidates = [
    err?.status,
    err?.statusCode,
    err?.response?.status,
    err?.cause?.status,
    err?.cause?.statusCode,
  ];
  const found = candidates.find((value) => Number.isInteger(Number(value)) && Number(value) > 0);
  return found === undefined ? null : Number(found);
}

function codeOf(err) {
  return clamp(err?.code || err?.cause?.code || err?.errno || "", 60) || null;
}

function messageOf(err) {
  if (!err) return "";
  if (typeof err === "string") return clamp(err);
  return clamp(err.message || err.error?.message || "");
}

/**
 * Provider responses that mean "this credential/route does not identify a
 * user", regardless of the status code the gateway chose to wrap them in.
 * OpenClaw returned `HTTP 401: User not found` on August 11; a bare 401 from
 * OpenAI reads differently ("Incorrect API key provided"), and the two need
 * different operator instructions.
 */
function isProviderIdentityFailure(message) {
  return /user not found|no such user|unknown user|account not found/i.test(message);
}

function isMissingCredential(err, message) {
  if (err?.code === "missing_credentials") return true;
  return /missing (api )?key|not configured|no api key|credentials? (are )?required/i.test(message);
}

function isTimeoutMessage(err, message) {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  return /timed? ?out|timeout|aborted/i.test(message);
}

/**
 * Label a failure.
 *
 * @returns {{class: string, retryable: boolean, code: string, status: number|null,
 *            message: string, reason: string}}
 *   `code` is a stable machine label (`auth`, `rate_limited`, …) safe to
 *   persist and compare; `reason` is the human sentence shown to an operator.
 *   Neither ever carries a credential — only the provider's own message text,
 *   which is truncated but not otherwise rewritten.
 */
function classifyFailure(err, { phase = null } = {}) {
  const status = statusOf(err);
  const code = codeOf(err);
  const message = messageOf(err);

  const label = (failureClass, machineCode, reason) => ({
    class: failureClass,
    retryable: failureClass === RETRYABLE,
    code: machineCode,
    status,
    message,
    reason,
    phase,
  });

  if (isMissingCredential(err, message)) {
    return label(NON_RETRYABLE, "missing_credentials", "A required credential is not configured. Retrying cannot fix it.");
  }

  if (isProviderIdentityFailure(message)) {
    return label(
      NON_RETRYABLE,
      "provider_user_not_found",
      "The provider does not recognize the identity behind this key or agent route. " +
        "Verify the agent/model route and credentials before retrying — see docs/newsroom-401-verification.md.",
    );
  }

  if (status === 401 || status === 403) {
    return label(NON_RETRYABLE, "auth", "Authentication or authorization failed. A retry sends the same rejected credential.");
  }

  if (status === 404) {
    return label(NON_RETRYABLE, "invalid_route", "The requested agent, model or endpoint does not exist.");
  }

  if (status === 400 || status === 422) {
    return label(NON_RETRYABLE, "bad_request", "The request was rejected as invalid. This is a configuration or payload problem.");
  }

  if (status === 429) {
    return label(RETRYABLE, "rate_limited", "Rate limited by the provider. Safe to retry after a cooldown.");
  }

  if (status === 408) {
    return label(RETRYABLE, "timeout", "The provider reported a timeout. Safe to retry.");
  }

  if (status !== null && status >= 500) {
    return label(RETRYABLE, "server_error", `Provider returned HTTP ${status}. Safe to retry.`);
  }

  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return label(RETRYABLE, "network", `Network failure (${code}). The request never reached the provider.`);
  }

  if (isTimeoutMessage(err, message)) {
    return label(RETRYABLE, "timeout", "The request timed out before a response arrived. Safe to retry.");
  }

  return label(
    UNKNOWN,
    "unclassified",
    "The failure could not be classified. Treated as not automatically retryable so a repeating fault stays visible.",
  );
}

/** Convenience for callers that only branch on "try again?". */
function isRetryable(err) {
  return classifyFailure(err).retryable;
}

module.exports = {
  classifyFailure,
  isRetryable,
  FAILURE_CLASSES,
  RETRYABLE,
  NON_RETRYABLE,
  UNKNOWN,
};
