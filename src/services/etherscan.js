const { createServiceError } = require("../utils/errors");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class EtherscanService {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(this.config.apiKey);
  }

  async getBlockNumberByTimestamp(timestamp) {
    const payload = await this.request({
      module: "block",
      action: "getblocknobytime",
      timestamp,
      closest: "before",
    });

    return Number.parseInt(payload.result, 10);
  }

  async getTokenTransfers({
    contractAddress,
    address,
    startBlock,
    endBlock,
    page = 1,
    offset = 100,
    sort = "desc",
  }) {
    const payload = await this.request({
      module: "account",
      action: "tokentx",
      contractaddress: contractAddress,
      address,
      startblock: startBlock,
      endblock: endBlock,
      page,
      offset,
      sort,
    });

    if (payload.message === "No transactions found") {
      return [];
    }

    return Array.isArray(payload.result) ? payload.result : [];
  }

  async request(query) {
    if (!this.isConfigured()) {
      throw createServiceError("Etherscan API key is not configured.", 503);
    }

    const url = new URL("/v2/api", this.config.baseUrl);
    url.searchParams.set("chainid", this.config.chainId);
    url.searchParams.set("apikey", this.config.apiKey);

    for (const [key, value] of Object.entries(query)) {
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
          },
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
          const error = createServiceError(
            `Etherscan API ${response.status}: ${payload?.result || response.statusText}`,
            response.status,
          );
          lastError = error;
          if (attempt < maxAttempts && response.status >= 500) {
            await sleep(attempt * 250);
            continue;
          }
          throw error;
        }

        if (payload?.status === "0" && payload?.message !== "No transactions found") {
          const detail = payload?.result || payload?.message || "Unknown Etherscan error";
          const error = createServiceError(`Etherscan API: ${detail}`, 502);
          lastError = error;
          if (attempt < maxAttempts && /Max rate limit/i.test(detail)) {
            await sleep(attempt * 500);
            continue;
          }
          throw error;
        }

        return payload;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || error.statusCode < 500) {
          if (error.name === "AbortError") {
            throw createServiceError("Timed out waiting for Etherscan API response.", 504);
          }
          throw error;
        }
        await sleep(attempt * 250);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || createServiceError("Etherscan request failed.", 502);
  }
}

module.exports = { EtherscanService };
