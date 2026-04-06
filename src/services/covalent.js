const { createServiceError } = require("../utils/errors");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class CovalentService {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(this.config.apiKey);
  }

  async getLogEventsByContract({ contractAddress, startBlock, endBlock, pageSize = 100, pageNumber = 0 }) {
    const payload = await this.request({
      pathname: `/v1/${this.config.chainName}/events/address/${contractAddress}/`,
      query: {
        "starting-block": startBlock,
        "ending-block": endBlock,
        "page-size": pageSize,
        "page-number": pageNumber,
      },
    });

    const data = payload?.data || payload;
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      pagination: data?.pagination || null,
    };
  }

  async request({ pathname, query }) {
    if (!this.isConfigured()) {
      throw createServiceError("Covalent API key is not configured.", 503);
    }

    const url = new URL(pathname, this.config.baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const maxAttempts = Math.max(0, this.config.retryCount) + 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
          const error = createServiceError(
            `Covalent API ${response.status}: ${payload?.error_message || payload?.error || response.statusText}`,
            response.status,
          );
          lastError = error;
          if (attempt < maxAttempts && response.status >= 500) {
            await sleep(attempt * 250);
            continue;
          }
          throw error;
        }

        if (payload?.error) {
          const detail = payload?.error_message || payload?.error || "Unknown Covalent error";
          const error = createServiceError(`Covalent API: ${detail}`, 502);
          lastError = error;
          if (attempt < maxAttempts && /rate limit/i.test(detail)) {
            await sleep(attempt * 500);
            continue;
          }
          throw error;
        }

        return payload;
      } catch (error) {
        lastError = error;
        if (error.name === "AbortError") {
          if (attempt >= maxAttempts) {
            throw createServiceError("Timed out waiting for Covalent API response.", 504);
          }
        } else if (attempt >= maxAttempts || (error.statusCode && error.statusCode < 500)) {
          throw error;
        }

        await sleep(attempt * 250);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || createServiceError("Covalent request failed.", 502);
  }
}

module.exports = { CovalentService };
