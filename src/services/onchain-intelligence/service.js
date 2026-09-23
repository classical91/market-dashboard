/**
 * On-Chain Intelligence service — backs GET /api/onchain/intelligence.
 *
 * Wraps a provider (DefiLlama today), caches its normalized snapshot, and
 * keeps the last good copy of every section so a provider outage degrades the
 * Overview card instead of breaking it. Missing data stays null; it is never
 * turned into zero.
 *
 * Status, per section and overall:
 *   LIVE         fetched from the provider on the latest refresh
 *   CACHED       latest refresh failed; serving a copy younger than staleAfterMs
 *   STALE        latest refresh failed; serving a copy older than staleAfterMs
 *   UNAVAILABLE  no data has ever been fetched
 */

const { RULES, liquidityRegime, activityLabel, computePulse, trend } = require("./scoring");

const SECTIONS = ["tvl", "stablecoins", "dex", "chains"];
const LAST_GOOD_KEY = "onchain-intelligence:last-good";
const LAST_GOOD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class OnchainIntelligenceService {
  constructor({
    provider,
    cache,
    store = null,
    cacheTtlMs = 10 * 60 * 1000,
    failureCacheTtlMs = 60 * 1000,
    staleAfterMs = 60 * 60 * 1000,
    now = () => Date.now(),
  }) {
    this.provider = provider;
    this.cache = cache;
    // Optional persistent store (PersistentReporterCache) so the last good
    // dataset survives a restart.
    this.store = store;
    this.cacheTtlMs = cacheTtlMs;
    this.failureCacheTtlMs = failureCacheTtlMs;
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    this.lastGood = this.loadLastGood();
    this.lastRefreshFailed = false;
  }

  async getIntelligence() {
    const key = "onchain-intelligence:payload";
    const cached = this.cache.get(key);
    if (cached) return cached;
    const payload = await this.cache.getOrLoad(key, 0, () => this.refresh());
    // A degraded refresh is retried sooner than a clean one.
    this.cache.set(key, payload, this.lastRefreshFailed ? this.failureCacheTtlMs : this.cacheTtlMs);
    return payload;
  }

  async refresh() {
    let snapshot = null;
    let providerError = null;
    try {
      snapshot = await this.provider.fetchSnapshot();
    } catch (error) {
      providerError = error;
    }

    const fetchedAt = new Date(this.now()).toISOString();
    const fresh = snapshot?.data || {};
    const sections = {};
    // Which sections this refresh actually fetched. LIVE is decided from
    // this, never by comparing timestamps: a saved copy written in the same
    // millisecond as this refresh would otherwise read as live.
    const refreshed = new Set();
    let updated = false;

    for (const name of ["tvl", "stablecoins", "dex"]) {
      if (fresh[name]) {
        sections[name] = { value: fresh[name], fetchedAt };
        this.lastGood[name] = sections[name];
        refreshed.add(name);
        updated = true;
      } else if (this.lastGood[name]) {
        sections[name] = this.lastGood[name];
      }
    }

    // Chain rows fall back row-by-row, so one chain's failed TVL fetch keeps
    // its previous value instead of discarding the other chains' fresh rows.
    if (hasChainData(fresh.chains)) {
      const value = mergeChainRows(fresh.chains, this.lastGood.chains?.value);
      sections.chains = { value, fetchedAt };
      this.lastGood.chains = sections.chains;
      refreshed.add("chains");
      updated = true;
    } else if (this.lastGood.chains) {
      sections.chains = this.lastGood.chains;
    }

    if (updated) this.saveLastGood();

    const errors = providerError ? [providerError.message] : snapshot?.errors || [];
    this.lastRefreshFailed = Boolean(providerError) || errors.length > 0;
    return this.buildPayload({ sections, errors, fetchedAt, refreshed });
  }

  buildPayload({ sections, errors, fetchedAt, refreshed = new Set() }) {
    const nowMs = this.now();
    const statusOf = (section, name) => {
      if (!section) return "UNAVAILABLE";
      if (refreshed.has(name)) return "LIVE";
      return nowMs - Date.parse(section.fetchedAt) > this.staleAfterMs ? "STALE" : "CACHED";
    };

    const tvl = sections.tvl?.value ?? null;
    const stablecoins = sections.stablecoins?.value ?? null;
    const dex = sections.dex?.value ?? null;
    const chains = sections.chains?.value ?? [];

    const sectionStatus = Object.fromEntries(SECTIONS.map((name) => [name, statusOf(sections[name], name)]));
    const pulse = computePulse({ stablecoins, tvl, dex });
    const liquidity = liquidityRegime(stablecoins);
    const bands = RULES.components;

    return {
      status: overallStatus(Object.values(sectionStatus)),
      updatedAt: fetchedAt,
      // Age of the oldest section served — differs from updatedAt when a
      // section is being carried from the last good dataset.
      dataAsOf: oldestFetchedAt(Object.values(sections)),
      provider: this.provider.id,
      attribution: this.provider.attribution,
      state: pulse.state,
      pulse,
      liquidity: {
        regime: liquidity.regime,
        basis: liquidity.basis,
        change7d: stablecoins?.change7d ?? null,
        change30d: stablecoins?.change30d ?? null,
      },
      activity: activityLabel(dex),
      metrics: {
        tvl: tvl && { ...tvl, trend: trend(tvl.change7d, bands.tvl.neutral) },
        stablecoins: stablecoins && {
          ...stablecoins,
          trend: trend(stablecoins.change7d, bands.liquidity.neutral),
        },
        dex: dex && { ...dex, trend: trend(dex.change7d, bands.activity.neutral) },
      },
      chains: chains.map((row) => ({
        ...row,
        trend: trend(row.tvlChange7d, bands.tvl.neutral),
      })),
      sections: sectionStatus,
      rules: serializeRules(),
      errors,
    };
  }

  loadLastGood() {
    const stored = this.store?.get(LAST_GOOD_KEY);
    return stored && typeof stored === "object" ? { ...stored } : {};
  }

  saveLastGood() {
    if (!this.store) return;
    try {
      this.store.set(LAST_GOOD_KEY, this.lastGood, LAST_GOOD_TTL_MS);
    } catch (error) {
      console.error("[OnchainIntelligence] Could not persist last good dataset:", error.message);
    }
  }
}

function hasChainData(rows) {
  return Array.isArray(rows) && rows.some((row) => row.tvl !== null || row.dexVolume24h !== null);
}

// A chain whose TVL fetch failed this time keeps its previous TVL (flagged
// `tvlCarried`) rather than dropping to "—".
function mergeChainRows(fresh, previous) {
  const byId = new Map((previous || []).map((row) => [row.id, row]));
  return fresh.map((row) => {
    const prior = byId.get(row.id);
    if (row.tvl !== null || !prior || prior.tvl === null) return { ...row, tvlCarried: false };
    return {
      ...row,
      tvl: prior.tvl,
      tvlChange1d: prior.tvlChange1d,
      tvlChange7d: prior.tvlChange7d,
      tvlCarried: true,
    };
  });
}

function oldestFetchedAt(sections) {
  const times = sections.map((section) => section?.fetchedAt).filter(Boolean).sort();
  return times[0] || null;
}

function overallStatus(statuses) {
  if (statuses.every((status) => status === "UNAVAILABLE")) return "UNAVAILABLE";
  if (statuses.includes("STALE")) return "STALE";
  if (statuses.includes("CACHED")) return "CACHED";
  return "LIVE";
}

function serializeRules() {
  return {
    components: RULES.components,
    liquidity30d: RULES.liquidity30d,
    pulse: RULES.pulse.map((band) => ({ ...band, min: Number.isFinite(band.min) ? band.min : null })),
    minComponents: RULES.minComponents,
    maxComponentScore: RULES.maxComponentScore,
  };
}

module.exports = { OnchainIntelligenceService };
