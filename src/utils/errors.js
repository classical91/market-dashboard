function createServiceError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

/** Node's fetch reports every network failure as "fetch failed"; the cause says which. */
function describeNetworkError(err) {
  const cause = err?.cause;
  const detail = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
  return detail && !String(err.message).includes(detail) ? `${err.message} (${detail})` : String(err?.message || err);
}

module.exports = { createServiceError, describeNetworkError };
