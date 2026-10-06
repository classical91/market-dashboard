"use strict";

/**
 * `farmclaw-collector.js doctor`: check every hop between the FarmClaw button
 * and the FarmClaw OpenClaw agent, without starting an agent run, and say
 * which one is broken.
 *
 *   1. Delivery configured?  (OpenClaw hook env, or FARMCLAW_DELIVER_CMD)
 *   2. Dashboard reachable, machine key accepted, queue state, and when the
 *      collector last polled (never / long ago = the collector isn't running).
 *   3. OpenClaw gateway hook: reachable, hooks enabled, token accepted.
 *      Probed with a body that has no `message`. The gateway checks the token
 *      first (401), then rejects the empty message with
 *      400 { error: "message required" } before resolving an agent or
 *      dispatching anything (openclaw dist hooks handler, normalizeAgentPayload).
 *      So a 400 "message required" proves URL, hooks.enabled and token, and
 *      starts no run. The agent id itself is only proven by deliver-test.
 *   4. Local task file: deliveries stuck as unknown or failing.
 */

const { hooksAgentUrl } = require("./farmclaw-openclaw");

const STALE_POLL_MS = 5 * 60 * 1000;

function describeCause(err) {
  const cause = err?.cause;
  const detail = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
  const message = String(err?.message || err);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

function ago(iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)} min ago`;
  return `${(ms / 3600000).toFixed(1)} h ago`;
}

async function checkDashboard({ baseUrl, key, fetchImpl, now }) {
  const lines = [];
  if (!key) return { ok: false, lines: [["FAIL", "BROADCAST_LEDGER_API_KEY is not set: the collector can't claim anything"]] };
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/farmclaw/handoffs?limit=100`, {
      headers: { "x-broadcast-key": key },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, lines: [["FAIL", `dashboard unreachable at ${baseUrl}: ${describeCause(err)}`]] };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, lines: [["FAIL", `dashboard rejected the machine key (HTTP ${res.status}): BROADCAST_LEDGER_API_KEY doesn't match the dashboard's`]] };
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || !Array.isArray(body?.records)) {
    return { ok: false, lines: [["FAIL", `dashboard answered HTTP ${res.status} without a handoff list at ${baseUrl}`]] };
  }

  lines.push(["PASS", `dashboard reachable at ${baseUrl}, machine key accepted`]);
  const counts = {};
  body.records.forEach((record) => { counts[record.status] = (counts[record.status] || 0) + 1; });
  lines.push(["INFO", `recent handoffs: ${["pending", "claimed", "received", "failed"].map((s) => `${s} ${counts[s] || 0}`).join(", ")}`]);
  const latestFailed = body.records.find((record) => record.status === "failed");
  if (latestFailed) lines.push(["INFO", `latest failure (${latestFailed.url}): ${latestFailed.error}`]);

  const lastPollAt = body.agent?.lastPollAt;
  let polling = true;
  if (!lastPollAt) {
    polling = false;
    lines.push(["FAIL", "the collector has never polled the dashboard: `watch` isn't running anywhere with this key"]);
  } else if (now - Date.parse(lastPollAt) > STALE_POLL_MS) {
    polling = false;
    lines.push(["FAIL", `the collector last polled ${ago(lastPollAt, now)} (${lastPollAt}): \`watch\` isn't running now`]);
  } else {
    lines.push(["PASS", `the collector last polled ${ago(lastPollAt, now)}`]);
  }
  return { ok: true, polling, lines };
}

async function checkGateway({ url, token, agentId, fetchImpl }) {
  const endpoint = hooksAgentUrl(url);
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // No message: rejected before any agent run is dispatched.
      body: JSON.stringify({ agentId }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, lines: [["FAIL", `OpenClaw gateway unreachable at ${endpoint}: ${describeCause(err)}. Is the gateway running, and is this its port?`]] };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (res.status === 400 && json?.error === "message required") {
    return {
      ok: true,
      lines: [["PASS", `OpenClaw gateway hook at ${endpoint}: hooks enabled, token accepted (no run started)`]],
    };
  }
  const hints = {
    401: "token rejected: FARMCLAW_OPENCLAW_HOOK_TOKEN must equal the gateway's hooks.token",
    404: "no hook here: hooks.enabled is false, the gateway wasn't restarted after enabling it, or hooks.path differs from the URL",
    405: "wrong method or path",
    429: "too many failed tokens recently; wait for Retry-After, then fix the token",
  };
  const hint = hints[res.status] || `unexpected answer: ${(json?.error || text).slice(0, 200)}`;
  return { ok: false, lines: [["FAIL", `OpenClaw gateway hook at ${endpoint} answered HTTP ${res.status}: ${hint}`]] };
}

function checkTasks(store) {
  const lines = [];
  let tasks;
  try {
    tasks = store.list({ limit: 1000 });
  } catch (err) {
    return [["FAIL", `task file ${store.file} can't be read: ${err.message}`]];
  }
  const unknown = tasks.filter((task) => task.delivery?.startedAt && !task.delivery?.deliveredAt);
  const failing = tasks.filter((task) => !task.delivery?.startedAt && !task.delivery?.deliveredAt && task.delivery?.lastError);
  const notDelivered = tasks.filter((task) => !task.delivery?.deliveredAt);
  lines.push(["INFO", `task file ${store.file}: ${tasks.length} tasks, ${tasks.length - notDelivered.length} delivered`]);
  unknown.forEach((task) => lines.push([
    "WARN",
    `${task.id} (${task.url}) has an UNKNOWN delivery: ${task.delivery.lastError || "interrupted"}. Check FarmClaw, then \`task ${task.id} --delivery delivered|retry\``,
  ]));
  failing.slice(0, 5).forEach((task) => lines.push(["WARN", `${task.id} (${task.url}) last delivery error: ${task.delivery.lastError}`]));
  return lines;
}

async function runDoctor({ env = process.env, dashboardUrl, store, fetchImpl = global.fetch, now = Date.now() }) {
  const lines = [];
  const hooksUrl = env.FARMCLAW_OPENCLAW_HOOKS_URL;
  const hookToken = env.FARMCLAW_OPENCLAW_HOOK_TOKEN;
  const agentId = env.FARMCLAW_OPENCLAW_AGENT_ID || "farmclaw";
  const command = env.FARMCLAW_DELIVER_CMD;
  let deliveryOk = true;

  if ((hooksUrl || hookToken) && command) {
    deliveryOk = false;
    lines.push(["FAIL", "both the OpenClaw hook and FARMCLAW_DELIVER_CMD are set: run/watch refuse to start. Unset one"]);
  } else if (hooksUrl && hookToken) {
    lines.push(["PASS", `delivery: OpenClaw agent "${agentId}" via ${hooksUrl}`]);
  } else if (hooksUrl || hookToken) {
    deliveryOk = false;
    lines.push(["FAIL", `delivery: ${hooksUrl ? "FARMCLAW_OPENCLAW_HOOK_TOKEN" : "FARMCLAW_OPENCLAW_HOOKS_URL"} is missing`]);
  } else if (command) {
    lines.push(["PASS", "delivery: FARMCLAW_DELIVER_CMD (check it with deliver-test)"]);
  } else {
    deliveryOk = false;
    lines.push(["FAIL", "delivery: nothing configured, so run/watch refuse to start. Set FARMCLAW_OPENCLAW_HOOKS_URL + FARMCLAW_OPENCLAW_HOOK_TOKEN"]);
  }

  const dashboard = await checkDashboard({ baseUrl: dashboardUrl, key: env.BROADCAST_LEDGER_API_KEY, fetchImpl, now });
  lines.push(...dashboard.lines);

  let gatewayOk = true;
  if (hooksUrl && hookToken) {
    const gateway = await checkGateway({ url: hooksUrl, token: hookToken, agentId, fetchImpl });
    gatewayOk = gateway.ok;
    lines.push(...gateway.lines);
  }

  if (store) lines.push(...checkTasks(store));

  const ok = deliveryOk && dashboard.ok && dashboard.polling !== false && gatewayOk && !lines.some(([level]) => level === "FAIL");
  if (ok) {
    lines.push(["PASS", `every hop answers. Next: \`deliver-test --link <url>\` starts one real test run in agent "${agentId}"; confirm FarmClaw got it`]);
  }
  return { ok, lines };
}

module.exports = { runDoctor };
