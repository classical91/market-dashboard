"use strict";

/**
 * FarmClaw collector: the consumer loop for the dashboard's handoff queue.
 *
 * One pass (`collectOnce`):
 *   1. Claim pending handoffs from the dashboard with the machine key.
 *   2. Write each into FarmClaw's durable intake store (FarmclawIntakeStore).
 *   3. Deliver it into the live FarmClaw session (`deliver`, see
 *      farmclaw-delivery.js). A local task alone is not FarmClaw's workflow:
 *      nothing reads the file unless FarmClaw is told.
 *   4. Only after delivery is confirmed, send the receipt with the task id.
 *
 * Failure handling follows docs/farmclaw-handoff.md:
 *   - The intake write failed → `POST /:id/fail` with the exact error. No
 *     receipt, because FarmClaw does not have the item.
 *   - The receipt request failed (network, 5xx) → do nothing more. The lease
 *     expires, the item is handed out again, `intake` finds the existing task
 *     and the same receipt id is re-sent, which the dashboard accepts.
 *   - The receipt got a 409 (a different receipt already exists) → recorded on
 *     the task and reported; never "fixed" by sending another id.
 *   - Delivery failed (the command said nothing was sent) → no receipt; the
 *     lease expiry retries it, up to `maxDeliveryAttempts`, then `/fail` with
 *     the exact error. A re-tap starts a fresh round.
 *   - Delivery outcome unknown (timeout, or success without an id) → `/fail`
 *     saying so, and never re-sent automatically, because a blind re-send can
 *     duplicate the message. `task <id> --delivery delivered|retry` resolves it.
 *   - Delivered but the receipt was lost → the next claim skips delivery and
 *     only re-sends the receipt.
 */

const { buildDeliveryPayload } = require("./farmclaw-delivery");

const DEFAULT_AGENT = "farmclaw";
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;

/** Node's fetch reports every network failure as "fetch failed"; the cause says which. */
function describeNetworkError(err) {
  const cause = err?.cause;
  const detail = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
  return detail && !String(err.message).includes(detail) ? `${err.message} (${detail})` : String(err?.message || err);
}

function createHandoffClient({ baseUrl, key, fetchImpl = global.fetch, timeoutMs = 15000 }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("dashboard base URL is required");
  if (!key) throw new Error("BROADCAST_LEDGER_API_KEY is required");

  async function post(pathname, body) {
    const res = await fetchImpl(`${base}/api/farmclaw/handoffs${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-broadcast-key": key },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, text };
  }

  return {
    claim: ({ agent, limit }) => post("/claim", { agent, limit }),
    receipt: (id, body) => post(`/${encodeURIComponent(id)}/receipt`, body),
    fail: (id, body) => post(`/${encodeURIComponent(id)}/fail`, body),
  };
}

function describeHttpError(res) {
  const message = res.json?.error || String(res.text || "").slice(0, 200) || "no body";
  return `HTTP ${res.status}: ${message}`;
}

/** The one receipt shape FarmClaw sends: its task id, plus the session's delivery id when there is one. */
function receiptBody(task, agent = DEFAULT_AGENT) {
  const body = { receiptId: task.id, agent };
  if (task.delivery?.deliveryId) body.note = `Delivered to the FarmClaw session: ${task.delivery.deliveryId}`;
  return body;
}

async function reportFailure({ client, handoff, agent, error, logger }) {
  try {
    const res = await client.fail(handoff.id, { error, agent });
    if (!res.ok) logger.error?.(`[farmclaw-collector] ${handoff.id}: fail report rejected (${describeHttpError(res)})`);
  } catch (err) {
    // The lease will expire and the item comes back; nothing else to do.
    logger.error?.(`[farmclaw-collector] ${handoff.id}: fail report not delivered: ${describeNetworkError(err)}`);
  }
}

/**
 * Hand the task to the FarmClaw session unless it already was. Returns the
 * task when it is delivered, or null after recording why it isn't (the caller
 * then skips the receipt).
 */
async function deliverTask({ client, store, deliver, handoff, task, agent, maxDeliveryAttempts, summary, logger }) {
  const delivery = task.delivery || {};
  if (delivery.deliveredAt) return task;

  const fail = async (error, counter) => {
    summary[counter] += 1;
    summary.errors.push({ handoffId: handoff.id, taskId: task.id, error });
    logger.error?.(`[farmclaw-collector] ${handoff.id}: ${error}`);
    await reportFailure({ client, handoff, agent, error, logger });
  };

  if (delivery.startedAt) {
    await fail(
      `Delivery to the FarmClaw session started at ${delivery.startedAt} and its outcome is unknown` +
        `${delivery.lastError ? ` (${delivery.lastError})` : ""}. Not re-sent, to avoid a duplicate. Check the session, then run:` +
        ` farmclaw-collector.js task ${task.id} --delivery delivered|retry`,
      "unknown",
    );
    return null;
  }

  let started;
  try {
    started = store.beginDelivery(task.id);
  } catch (err) {
    await fail(`FarmClaw intake store write failed: ${err.message}`, "failed");
    return null;
  }

  let result;
  try {
    result = await deliver(buildDeliveryPayload(handoff, started));
  } catch (err) {
    // A deliverer that throws gives no promise about what it sent.
    result = { outcome: "unknown", error: `deliverer threw: ${err.message}` };
  }
  try {
    if (result.outcome === "delivered") {
      return store.deliverySucceeded(task.id, { deliveryId: result.deliveryId });
    }
    if (result.outcome === "failed") {
      const updated = store.deliveryFailed(task.id, { error: result.error });
      if (updated.delivery.attempts >= maxDeliveryAttempts) {
        await fail(`Delivery to the FarmClaw session failed ${updated.delivery.attempts} times: ${result.error}`, "failed");
        store.resetDeliveryAttempts(task.id);
      } else {
        summary.pendingRetry += 1;
        summary.errors.push({ handoffId: handoff.id, taskId: task.id, error: result.error });
        logger.warn?.(`[farmclaw-collector] ${handoff.id}: ${result.error}; attempt ${updated.delivery.attempts}/${maxDeliveryAttempts}, retried after lease expiry`);
      }
      return null;
    }
    store.deliveryUnknown(task.id, { error: result.error });
  } catch (err) {
    // The delivery happened (or may have); only the bookkeeping failed. The
    // in-flight mark stays, so the next pass reports "unknown" rather than
    // re-sending.
    result.error = `${result.error || "delivered"}; recording it failed: ${err.message}`;
  }
  await fail(
    `Delivery to the FarmClaw session has an unknown outcome: ${result.error}. Not re-sent, to avoid a duplicate. Check the session, then run:` +
      ` farmclaw-collector.js task ${task.id} --delivery delivered|retry`,
    "unknown",
  );
  return null;
}

async function collectOnce({
  client,
  store,
  deliver = null,
  agent = DEFAULT_AGENT,
  limit = 10,
  maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS,
  logger = console,
}) {
  const summary = { claimed: 0, delivered: 0, received: 0, alreadyReceived: 0, failed: 0, unknown: 0, pendingRetry: 0, errors: [] };

  let claim;
  try {
    claim = await client.claim({ agent, limit });
  } catch (err) {
    throw new Error(`claim failed: ${describeNetworkError(err)}`);
  }
  if (!claim.ok) throw new Error(`claim failed: ${describeHttpError(claim)}`);
  const records = Array.isArray(claim.json?.records) ? claim.json.records : [];
  summary.claimed = records.length;

  for (const handoff of records) {
    let task;
    try {
      ({ task } = store.intake(handoff));
    } catch (err) {
      const error = `FarmClaw intake store write failed: ${err.message}`;
      summary.failed += 1;
      summary.errors.push({ handoffId: handoff.id, error });
      logger.error?.(`[farmclaw-collector] ${handoff.id}: ${error}`);
      await reportFailure({ client, handoff, agent, error, logger });
      continue;
    }

    if (deliver) {
      const wasDelivered = Boolean(task.delivery?.deliveredAt);
      task = await deliverTask({ client, store, deliver, handoff, task, agent, maxDeliveryAttempts, summary, logger });
      if (!task) continue;
      if (!wasDelivered) summary.delivered += 1;
    }

    let res;
    try {
      res = await client.receipt(handoff.id, receiptBody(task, agent));
    } catch (err) {
      const error = `receipt not delivered: ${describeNetworkError(err)}`;
      summary.pendingRetry += 1;
      summary.errors.push({ handoffId: handoff.id, taskId: task.id, error });
      logger.warn?.(`[farmclaw-collector] ${handoff.id}: ${error}; task ${task.id} kept, will re-send after lease expiry`);
      continue;
    }

    if (res.ok) {
      store.recordReceipt(task.id, { ok: true });
      if (task.receiptSentAt) summary.alreadyReceived += 1;
      else summary.received += 1;
      logger.log?.(`[farmclaw-collector] ${handoff.id} → task ${task.id} (${handoff.url})`);
    } else if (res.status === 409) {
      const error = describeHttpError(res);
      store.recordReceipt(task.id, { ok: false, error });
      summary.errors.push({ handoffId: handoff.id, taskId: task.id, error });
      logger.error?.(`[farmclaw-collector] ${handoff.id}: receipt conflict for task ${task.id}: ${error}`);
    } else {
      summary.pendingRetry += 1;
      const error = describeHttpError(res);
      summary.errors.push({ handoffId: handoff.id, taskId: task.id, error: `receipt rejected: ${error}` });
      logger.warn?.(`[farmclaw-collector] ${handoff.id}: receipt rejected (${error}); task ${task.id} kept, will re-send after lease expiry`);
    }
  }

  return summary;
}

module.exports = { createHandoffClient, collectOnce, receiptBody, describeHttpError, describeNetworkError, DEFAULT_AGENT, DEFAULT_MAX_DELIVERY_ATTEMPTS };
