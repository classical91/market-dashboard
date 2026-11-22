const { MemoryCache } = require("./cache");
const { createServiceError } = require("../utils/errors");

// One queue and rate-limit circuit for every endpoint of a provider. A 429
// stops queued work too; retrying another URL would spend the same quota.
class ProviderRequestCache {
  constructor({ intervalMs = 2200, cooldownMs = 60000 } = {}) {
    this.cache = new MemoryCache();
    this.intervalMs = intervalMs;
    this.cooldownMs = cooldownMs;
    this.tail = Promise.resolve();
    this.nextRequestAt = 0;
    this.cooldownUntil = 0;
    this.rateLimitCount = 0;
  }

  get(url, ttlMs, load) {
    return this.cache.getOrLoad(url, ttlMs, () => {
      const pending = this.tail.then(async () => {
        this.checkCooldown();
        const waitMs = this.nextRequestAt - Date.now();
        if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        this.checkCooldown();
        this.nextRequestAt = Date.now() + this.intervalMs;
        try {
          const value = await load();
          this.rateLimitCount = 0;
          return value;
        } catch (error) {
          if ((error.statusCode || error.status) === 429) {
            this.rateLimitCount += 1;
            const backoff = Math.min(this.cooldownMs * 2 ** (this.rateLimitCount - 1), 15 * 60_000);
            // Never shorten the provider's Retry-After, even if it is hours.
            this.cooldownUntil = Date.now() + Math.max(backoff, error.retryAfterMs || 0);
          }
          throw error;
        }
      });
      this.tail = pending.catch(() => {});
      return pending;
    });
  }

  checkCooldown() {
    if (Date.now() >= this.cooldownUntil) return;
    const error = createServiceError(
      `CoinGecko rate limited; retrying after ${new Date(this.cooldownUntil).toISOString()}`,
      429,
    );
    error.retryAfterMs = this.cooldownUntil - Date.now();
    throw error;
  }
}

module.exports = { ProviderRequestCache };
