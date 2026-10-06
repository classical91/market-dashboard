"use strict";

/**
 * Delivery of a claimed handoff into the live FarmClaw session.
 *
 * A task in the local intake file is durable but inert: nothing reads it
 * unless FarmClaw is told. Delivery is that step. It is a shell command that
 * FarmClaw's host supplies (`FARMCLAW_DELIVER_CMD`), for example the OpenClaw
 * call that posts a message into the FarmClaw Telegram session. The command
 * never talks to the dashboard. The collector owns the claim and receipt
 * payloads, so a delivery script cannot get them wrong.
 *
 * Command contract:
 *   stdin   one JSON object (see buildDeliveryPayload), also mirrored in env:
 *           FARMCLAW_HANDOFF_ID, FARMCLAW_TASK_ID, FARMCLAW_URL, FARMCLAW_MESSAGE
 *   exit 0  delivered; the last stdout line must be JSON with a non-empty
 *           "deliveryId" (the session's own message/run id)
 *   exit ≠0 not delivered; safe to retry. Last stderr line is the error.
 *
 * Results:
 *   delivered  exit 0 and a deliveryId
 *   failed     non-zero exit: the command says nothing was sent
 *   unknown    timeout, or exit 0 without a deliveryId: it may have been sent,
 *              so it is not re-sent automatically
 */

const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_CAPTURE = 64 * 1024;
const MAX_TEXT_IN_MESSAGE = 500;

function buildMessage({ url, handle, text, taskId, handoffId }) {
  const lines = ["FarmClaw handoff from X Intelligence", url];
  const snippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_IN_MESSAGE);
  if (snippet) lines.push(`${handle ? `@${handle}: ` : ""}${snippet}`);
  lines.push(taskId && taskId !== handoffId ? `Ref: ${taskId} (handoff ${handoffId})` : `Ref: handoff ${handoffId}`);
  return lines.join("\n");
}

function buildDeliveryPayload(handoff, task) {
  const base = {
    version: 1,
    handoffId: handoff.id,
    taskId: task.id,
    url: handoff.url || task.url,
    canonicalUrl: handoff.canonicalUrl || task.canonicalUrl || null,
    handle: handoff.handle || task.handle || null,
    text: handoff.text || task.text || null,
    attempt: task.delivery?.attempts || 1,
  };
  return { ...base, message: buildMessage(base) };
}

function lastLine(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}

function createCommandDeliverer({ command, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  if (!command) throw new Error("delivery command is required");

  return function deliver(payload) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...env,
          FARMCLAW_HANDOFF_ID: payload.handoffId,
          FARMCLAW_TASK_ID: payload.taskId,
          FARMCLAW_URL: payload.url || "",
          FARMCLAW_MESSAGE: payload.message,
        },
      });

      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ outcome: "unknown", error: `delivery command timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);

      child.stdout.on("data", (chunk) => { if (stdout.length < MAX_CAPTURE) stdout += chunk; });
      child.stderr.on("data", (chunk) => { if (stderr.length < MAX_CAPTURE) stderr += chunk; });
      // The command may exit without reading stdin; that is not an error.
      child.stdin.on("error", () => {});
      child.on("error", (err) => finish({ outcome: "failed", error: `delivery command could not start: ${err.message}` }));
      child.on("close", (code, signal) => {
        if (code !== 0) {
          const reason = lastLine(stderr) || lastLine(stdout) || (signal ? `killed by ${signal}` : "no output");
          finish({ outcome: "failed", error: `delivery command exited ${code ?? signal}: ${reason}` });
          return;
        }
        let parsed = null;
        try { parsed = JSON.parse(lastLine(stdout)); } catch {}
        const deliveryId = typeof parsed?.deliveryId === "string" || typeof parsed?.deliveryId === "number"
          ? String(parsed.deliveryId).trim()
          : "";
        if (!deliveryId) {
          finish({ outcome: "unknown", error: 'delivery command exited 0 without {"deliveryId": "..."} on its last stdout line' });
          return;
        }
        finish({ outcome: "delivered", deliveryId });
      });

      child.stdin.end(JSON.stringify(payload));
    });
  };
}

module.exports = { createCommandDeliverer, buildDeliveryPayload, buildMessage, DEFAULT_TIMEOUT_MS };
