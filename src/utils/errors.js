function createServiceError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

module.exports = { createServiceError };
