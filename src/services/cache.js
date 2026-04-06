class MemoryCache {
  constructor() {
    this.values = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    this.values.set(key, { value, expiresAt });
    return value;
  }

  async getOrLoad(key, ttlMs, loader) {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    if (this.inflight.has(key)) {
      return this.inflight.get(key);
    }

    const pending = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (ttlMs > 0) {
          this.set(key, value, ttlMs);
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return pending;
  }

  getStats() {
    return {
      entries: this.values.size,
      inflight: this.inflight.size,
    };
  }
}

module.exports = { MemoryCache };
