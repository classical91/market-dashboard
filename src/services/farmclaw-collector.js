"use strict";

/**
 * FarmClaw collector: the consumer loop for the dashboard's handoff queue.
 *
 * One pass (`collectOnce`):
 *   1. Claim pending handoffs from the dashboard with the machine key.
 *   2. Write each into FarmClaw's durable intake store (FarmclawIntakeStore).
 *   3. Only after that write is confirmed, send the receipt with the task id.
 *
 * Failure handling follows docs/farmclaw-handoff.md:
 *   - The intake write failed → `POST /:id/fail` with the exact error. No
 *     receipt, because FarmClaw does not have the item.
 *   - The receipt request failed (network, 5xx) → do nothing more. The lease
 *     expires, the item is handed out again, `intake` finds the existing task
 *     and the same receipt id is re-sent, which the dashboard accepts.
 *   - The receipt got a 409 (a different receipt already exists) → recorded on
 *     the task and reported; never "fixed" by sending another id.
 */

const DEFAULT_AGENT = "farmclaw";

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

async function collectOnce({ client, store, agent = DEFAULT_AGENT, limit = 10, logger = console }) {
  const summary = { claimed: 0, received: 0, alreadyReceived: 0, failed: 0, pendingRetry: 0, errors: [] };

  const claim = await client.claim({ agent, limit });
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
      try {
        const res = await client.fail(handoff.id, { error, agent });
        if (!res.ok) logger.error?.(`[farmclaw-collector] ${handoff.id}: fail report rejected (${describeHttpError(res)})`);
      } catch (failErr) {
        // The lease will expire and the item comes back; nothing else to do.
        logger.error?.(`[farmclaw-collector] ${handoff.id}: fail report not delivered: ${failErr.message}`);
      }
      continue;
    }

    let res;
    try {
      res = await client.receipt(handoff.id, { receiptId: task.id, agent });
    } catch (err) {
      summary.pendingRetry += 1;
      summary.errors.push({ handoffId: handoff.id, taskId: task.id, error: `receipt not delivered: ${err.message}` });
      logger.warn?.(`[farmclaw-collector] ${handoff.id}: receipt not delivered (${err.message}); task ${task.id} kept, will re-send after lease expiry`);
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

module.exports = { createHandoffClient, collectOnce, DEFAULT_AGENT };
