"use strict";

/**
 * FarmclawPusher: the dashboard sends a FarmClaw handoff straight to the
 * FarmClaw OpenClaw agent, through the gateway's `POST <hooks>/agent`
 * (see farmclaw-openclaw.js). No process on FarmClaw's side is needed.
 *
 *   tap → request() → push(id): claimById → POST /hooks/agent
 *     200 { ok, runId }  → receipt "openclaw-run:<runId>"   → button ✓
 *     rejected           → fail with the gateway's error    → "FarmClaw failed", tap retries
 *     no answer          → fail saying the outcome is unknown; a re-tap reuses
 *                          the same Idempotency-Key, which the gateway replays
 *                          while it still remembers the run
 *
 * The claim is the same lease the pull collector uses, so a collector still
 * running on FarmClaw's host can't deliver the same handoff twice. `sweep()`
 * picks up handoffs queued before the hook was configured and claims whose
 * lease ran out (e.g. the dashboard restarted mid-push).
 */

const { buildDeliveryPayload } = require("./farmclaw-delivery");

const PUSH_AGENT = "openclaw-gateway";
const DEFAULT_SWEEP_MS = 60 * 1000;

class FarmclawPusher {
  constructor({ store, deliver, agentId, logger = console }) {
    this._store = store;
    this._deliver = deliver;
    this._agentId = agentId;
    this._logger = logger;
    this._inFlight = new Map();
    this._timer = null;
  }

  get enabled() {
    return Boolean(this._deliver);
  }

  /** Push one handoff. Resolves with the updated record, or null if it wasn't claimable. */
  push(id) {
    if (!this.enabled) return Promise.resolve(null);
    // A double tap while the first push is still waiting joins it.
    if (this._inFlight.has(id)) return this._inFlight.get(id);
    const run = this._push(id).finally(() => this._inFlight.delete(id));
    this._inFlight.set(id, run);
    return run;
  }

  async _push(id) {
    const record = this._store.claimById(id, { agent: PUSH_AGENT });
    if (!record) return null;
    return this._deliverClaimed(record);
  }

  async _deliverClaimed(record) {
    // The handoff id is the identity: the Idempotency-Key is farmclaw-<id>,
    // the same on every attempt at this handoff.
    const payload = buildDeliveryPayload(record, { id: record.id });
    let result;
    try {
      result = await this._deliver(payload);
    } catch (err) {
      result = { outcome: "unknown", error: `delivery threw: ${err.message}` };
    }

    try {
      if (result.outcome === "delivered") {
        this._logger.log?.(`[FarmclawPusher] ${record.id} → FarmClaw agent ${result.deliveryId} (${record.url})`);
        return this._store.receipt(record.id, {
          receiptId: result.deliveryId,
          agent: PUSH_AGENT,
          note: `Delivered to the FarmClaw session: OpenClaw agent "${this._agentId}" run admitted by the gateway`,
        });
      }
      const error = result.outcome === "unknown"
        ? `${result.error}. The run may already be in FarmClaw: check it before tapping again (a tap within a few minutes is replayed, not re-run).`
        : result.error;
      this._logger.error?.(`[FarmclawPusher] ${record.id}: ${error}`);
      return this._store.fail(record.id, { error, agent: PUSH_AGENT });
    } catch (err) {
      // The store write failed; the lease will expire and sweep() retries
      // with the same Idempotency-Key.
      this._logger.error?.(`[FarmclawPusher] ${record.id}: could not record the outcome: ${err.message}`);
      return null;
    }
  }

  /** Deliver anything pending or abandoned. Never throws. */
  async sweep({ limit = 10 } = {}) {
    if (!this.enabled) return [];
    let records = [];
    try {
      records = this._store.claimPending({ agent: PUSH_AGENT, limit });
    } catch (err) {
      this._logger.error?.(`[FarmclawPusher] sweep claim failed: ${err.message}`);
      return [];
    }
    const results = [];
    for (const record of records) {
      if (this._inFlight.has(record.id)) continue;
      const run = this._deliverClaimed(record).finally(() => this._inFlight.delete(record.id));
      this._inFlight.set(record.id, run);
      results.push(await run);
    }
    return results;
  }

  start(intervalMs = DEFAULT_SWEEP_MS) {
    if (!this.enabled || this._timer) return;
    this._timer = setInterval(() => { this.sweep(); }, intervalMs);
    this._timer.unref?.();
    setImmediate(() => { this.sweep(); });
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

/**
 * Wait for a push, but answer the tap within `ms` either way. The button
 * keeps polling if the gateway is slower than that.
 */
async function pushWithin(pusher, id, ms = 20000) {
  if (!pusher?.enabled) return null;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([pusher.push(id).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { FarmclawPusher, pushWithin, PUSH_AGENT };
