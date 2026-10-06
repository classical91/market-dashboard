"use strict";

/**
 * Delivery into the FarmClaw OpenClaw agent through the gateway's inbound
 * webhook: `POST <hooks base>/agent` (OpenClaw docs: automation/cron-jobs/webhooks,
 * gateway/config-hooks).
 *
 * The gateway answers `200 { ok: true, runId }` once the agent run is
 * admitted. That runId is the delivery id: the item is in FarmClaw's own
 * workflow. Admission does not mean the turn finished; FarmClaw's own result
 * (e.g. its FarmBot intake) is a separate step the dashboard doesn't track.
 *
 * Duplicates: every request carries `Idempotency-Key: farmclaw-<taskId>` and
 * an identical payload, so a retry of a request whose response was lost
 * replays the same run instead of dispatching a second one. The gateway keeps
 * that replay entry while the run is pending or running and for 5 minutes
 * after it settles, and forgets it on restart. So a lost response is retried
 * here, immediately and a few times, while the replay is guaranteed. If it is
 * still unanswered, the outcome is `unknown` and the collector does not
 * re-send it later.
 *
 * Status mapping (gateway/config-hooks "Hook HTTP contract"):
 *   200 ok:true + runId     delivered
 *   400/401/404/405/408/413/429, 409, 500/502/503
 *                           failed: not admitted, nothing ran; safe to retry later
 *   network error / timeout unknown after the immediate retries
 */

const DEFAULT_AGENT_ID = "farmclaw";
const DEFAULT_TIMEOUT_MS = 30 * 1000; // admission can take up to 15s
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2000;

function describeCause(err) {
  const cause = err?.cause;
  const detail = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
  const message = String(err?.message || err);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

function hooksAgentUrl(base) {
  const trimmed = String(base || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/agent$/.test(trimmed) ? trimmed : `${trimmed}/agent`;
}

function createOpenclawHookDeliverer({
  url,
  token,
  agentId = DEFAULT_AGENT_ID,
  channel,
  to,
  accountId,
  name = "X Intelligence handoff",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = global.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const endpoint = hooksAgentUrl(url);
  if (!endpoint) throw new Error("OpenClaw hooks URL is required (e.g. http://127.0.0.1:18789/hooks)");
  if (!token) throw new Error("OpenClaw hook token is required (the gateway's hooks.token)");
  if (Boolean(channel) !== Boolean(to)) {
    throw new Error("OpenClaw announce destination needs both channel and to, or neither");
  }

  return async function deliver(payload) {
    // Identical on every attempt: the gateway's replay identity covers the
    // token, path and dispatch fields, so a changed body would be a new run.
    const body = { message: payload.message, name, agentId, deliver: true };
    if (channel) Object.assign(body, { channel, to });
    if (channel && accountId) body.accountId = accountId;
    const idempotencyKey = `farmclaw-${payload.taskId}`;

    let lastError = "";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(retryDelayMs * attempt);
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // The request may or may not have reached the gateway. Retrying with
        // the same key is safe now; later it may not be.
        lastError = `OpenClaw hook request failed: ${describeCause(err)}`;
        continue;
      }

      const text = await res.text().catch(() => "");
      let json = null;
      try { json = JSON.parse(text); } catch {}

      if (res.ok && json?.ok === true && json.runId) {
        return { outcome: "delivered", deliveryId: `openclaw-run:${json.runId}` };
      }
      if (res.ok) {
        // A 200 that isn't the documented admission shape (e.g. a proxy page):
        // something answered, but not proof the run was admitted.
        return { outcome: "unknown", error: `OpenClaw hook answered ${res.status} without { ok: true, runId }: ${text.slice(0, 200)}` };
      }
      const reason = json?.error || text.slice(0, 200) || "no body";
      return { outcome: "failed", error: `OpenClaw hook rejected the run (HTTP ${res.status}): ${reason}` };
    }
    return { outcome: "unknown", error: `${lastError}; no answer after ${retries + 1} attempts` };
  };
}

/** Build the deliverer from the environment, or null when it isn't configured. */
function openclawDelivererFromEnv(env = process.env) {
  const url = env.FARMCLAW_OPENCLAW_HOOKS_URL;
  const token = env.FARMCLAW_OPENCLAW_HOOK_TOKEN;
  if (!url && !token) return null;
  return createOpenclawHookDeliverer({
    url,
    token,
    agentId: env.FARMCLAW_OPENCLAW_AGENT_ID || DEFAULT_AGENT_ID,
    channel: env.FARMCLAW_OPENCLAW_CHANNEL || undefined,
    to: env.FARMCLAW_OPENCLAW_TO || undefined,
    accountId: env.FARMCLAW_OPENCLAW_ACCOUNT_ID || undefined,
    timeoutMs: Number(env.FARMCLAW_OPENCLAW_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  });
}

module.exports = { createOpenclawHookDeliverer, openclawDelivererFromEnv, hooksAgentUrl, DEFAULT_AGENT_ID };
