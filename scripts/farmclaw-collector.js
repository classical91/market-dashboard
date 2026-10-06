#!/usr/bin/env node
"use strict";

/**
 * FarmClaw's side of the dashboard handoff queue. Runs on FarmClaw's host,
 * not on the dashboard. See docs/farmclaw-handoff.md.
 *
 *   node scripts/farmclaw-collector.js run              one claim → task → deliver → receipt pass
 *   node scripts/farmclaw-collector.js watch [--interval 60]
 *                                                        the recurring collector
 *   node scripts/farmclaw-collector.js deliver-test --link <url>
 *                                                        run only the delivery command, no dashboard calls
 *   node scripts/farmclaw-collector.js tasks [--status open] [--limit 50] [--json]
 *   node scripts/farmclaw-collector.js task <id> [--status in_progress|done|dropped|open] [--note "..."]
 *   node scripts/farmclaw-collector.js task <id> --delivery delivered|retry [--delivery-id <id>]
 *
 * run/watch need a way to reach the FarmClaw agent: the OpenClaw gateway hook
 * (FARMCLAW_OPENCLAW_HOOKS_URL + FARMCLAW_OPENCLAW_HOOK_TOKEN, preferred) or a
 * custom command (FARMCLAW_DELIVER_CMD). Without one, a claimed link only lands
 * in the local file, which nothing reads, so they refuse to start unless
 * --local-only is passed explicitly.
 *
 * Environment:
 *   BROADCAST_LEDGER_API_KEY    machine key (required for run/watch)
 *   FARMCLAW_OPENCLAW_HOOKS_URL gateway hooks base, e.g. http://127.0.0.1:18789/hooks
 *   FARMCLAW_OPENCLAW_HOOK_TOKEN the gateway's hooks.token
 *   FARMCLAW_OPENCLAW_AGENT_ID  agent to run (default: farmclaw)
 *   FARMCLAW_OPENCLAW_CHANNEL / FARMCLAW_OPENCLAW_TO / FARMCLAW_OPENCLAW_ACCOUNT_ID
 *                               optional announce destination (both channel and to)
 *   FARMCLAW_DELIVER_CMD        alternative: shell command that posts into the FarmClaw session
 *                               (contract in src/services/farmclaw-delivery.js)
 *   FARMCLAW_DELIVER_TIMEOUT_MS delivery command timeout (default 60000)
 *   FARMCLAW_DASHBOARD_URL      dashboard base URL (default: production)
 *   FARMCLAW_INTAKE_FILE        task store path (default: ~/.farmclaw/intake.json)
 *   FARMCLAW_AGENT              claimant name (default: farmclaw)
 */

const os = require("os");
const path = require("path");
const { FarmclawIntakeStore, TASK_STATUSES } = require("../src/services/farmclaw-intake");
const {
  createHandoffClient,
  collectOnce,
  receiptBody,
  describeHttpError,
  DEFAULT_AGENT,
} = require("../src/services/farmclaw-collector");
const { createCommandDeliverer, buildDeliveryPayload, DEFAULT_TIMEOUT_MS } = require("../src/services/farmclaw-delivery");
const { openclawDelivererFromEnv } = require("../src/services/farmclaw-openclaw");

const DEFAULT_DASHBOARD_URL = "https://market-dashboard-production-b2f4.up.railway.app";
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;

// Flags that never take a value, so `--local-only run` doesn't eat the command.
const BOOLEAN_FLAGS = new Set(["local-only", "json"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        args[name] = true;
      } else {
        args[name] = argv[i + 1];
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function intakeFile(args) {
  const file = args.file || process.env.FARMCLAW_INTAKE_FILE || path.join(os.homedir(), ".farmclaw", "intake.json");
  // A value from a .env file or a quoted shell string arrives with a literal "~".
  return file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
}

function usage(code = 1) {
  console.error(
    "usage: farmclaw-collector.js run | watch [--interval 60] | deliver-test --link <url> | tasks [--status s] [--json]" +
      " | task <id> [--status s] [--note text] [--delivery delivered|retry] [--delivery-id id]",
  );
  process.exit(code);
}

function deliverer(args) {
  const command = args.deliver || process.env.FARMCLAW_DELIVER_CMD;
  const openclaw = openclawDelivererFromEnv(process.env);
  if (openclaw && command) {
    throw new Error("set either the OpenClaw hook (FARMCLAW_OPENCLAW_*) or FARMCLAW_DELIVER_CMD, not both");
  }
  if (openclaw) return openclaw;
  if (!command) return null;
  const timeoutMs = Number(args["deliver-timeout-ms"] || process.env.FARMCLAW_DELIVER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return createCommandDeliverer({ command, timeoutMs });
}

function deliveryTarget() {
  if (process.env.FARMCLAW_OPENCLAW_HOOKS_URL) {
    return `OpenClaw agent "${process.env.FARMCLAW_OPENCLAW_AGENT_ID || "farmclaw"}" via ${process.env.FARMCLAW_OPENCLAW_HOOKS_URL}`;
  }
  return "the FarmClaw session via FARMCLAW_DELIVER_CMD";
}

function requireDeliverer(args) {
  const deliver = deliverer(args);
  if (deliver || args["local-only"]) return deliver;
  throw new Error(
    "no delivery to FarmClaw configured: set FARMCLAW_OPENCLAW_HOOKS_URL and FARMCLAW_OPENCLAW_HOOK_TOKEN" +
      " (the OpenClaw gateway hook), or FARMCLAW_DELIVER_CMD." +
      " Without one a claimed link only reaches the local task file and FarmClaw never sees it." +
      " Pass --local-only to run that way on purpose.",
  );
}

function handoffClient(args) {
  return createHandoffClient({
    baseUrl: args.url || process.env.FARMCLAW_DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
    key: args.key || process.env.BROADCAST_LEDGER_API_KEY,
  });
}

async function runPass(store, args, deliver) {
  const client = handoffClient(args);
  return collectOnce({
    client,
    store,
    deliver,
    agent: args.agent || process.env.FARMCLAW_AGENT || DEFAULT_AGENT,
    limit: Number(args.limit) || 10,
  });
}

function printSummary(summary) {
  console.log(
    `[farmclaw-collector] ${new Date().toISOString()} claimed=${summary.claimed} delivered=${summary.delivered}` +
      ` received=${summary.received} already=${summary.alreadyReceived} failed=${summary.failed}` +
      ` unknown=${summary.unknown} retry=${summary.pendingRetry}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "run";
  const store = new FarmclawIntakeStore({ file: intakeFile(args) });

  if (command === "run") {
    const summary = await runPass(store, args, requireDeliverer(args));
    printSummary(summary);
    process.exitCode = summary.errors.length ? 2 : 0;
    return;
  }

  if (command === "watch") {
    const deliver = requireDeliverer(args);
    const intervalMs = Math.max(MIN_INTERVAL_SECONDS, Number(args.interval) || DEFAULT_INTERVAL_SECONDS) * 1000;
    console.log(
      `[farmclaw-collector] watching every ${intervalMs / 1000}s; tasks in ${store.file};` +
        ` ${deliver ? `delivering to ${deliveryTarget()}` : "LOCAL ONLY, nothing is delivered"}`,
    );
    let stopping = false;
    const stop = () => { stopping = true; };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopping) {
      try {
        printSummary(await runPass(store, args, deliver));
      } catch (err) {
        // A failed claim leaves nothing half-done; try again next tick.
        console.error(`[farmclaw-collector] pass failed: ${err.message}`);
      }
      const until = Date.now() + intervalMs;
      while (!stopping && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
      }
    }
    return;
  }

  if (command === "deliver-test") {
    // Exercises only the delivery command with a marked test item: no claim,
    // no receipt, no task written.
    const deliver = deliverer(args);
    if (!deliver) throw new Error("set FARMCLAW_OPENCLAW_HOOKS_URL + FARMCLAW_OPENCLAW_HOOK_TOKEN, or FARMCLAW_DELIVER_CMD, first");
    const link = args.link || "https://x.com/i/status/0";
    const stamp = Date.now().toString(36);
    const payload = buildDeliveryPayload(
      { id: `fch_test_${stamp}`, url: link, text: "TEST delivery from farmclaw-collector deliver-test. No action needed." },
      { id: `fct_test_${stamp}`, delivery: { attempts: 1 } },
    );
    payload.test = true;
    const result = await deliver(payload);
    console.log(JSON.stringify({ payload, result }, null, 2));
    process.exitCode = result.outcome === "delivered" ? 0 : 2;
    return;
  }

  if (command === "tasks") {
    const tasks = store.list({ status: args.status, limit: args.limit });
    if (args.json !== undefined) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (!tasks.length) console.log("no tasks");
    tasks.forEach((task) => {
      const receipt = task.receiptSentAt ? "receipt ✓" : task.receiptError ? `receipt ✗ ${task.receiptError}` : "receipt pending";
      const d = task.delivery || {};
      const delivery = d.deliveredAt ? `delivered ${d.deliveryId}` : d.startedAt ? "delivery UNKNOWN" : d.lastError ? `delivery ✗ ${d.lastError}` : "not delivered";
      console.log(`${task.id}  ${task.status.padEnd(11)} ${task.createdAt}  ${task.url}  (${delivery}; ${receipt})`);
    });
    return;
  }

  if (command === "task") {
    const id = args._[1];
    if (!id) usage();
    if (args.delivery !== undefined) {
      const task = store.resolveDelivery(id, { outcome: args.delivery, deliveryId: args["delivery-id"] });
      if (!task) throw new Error(`task ${id} not found`);
      console.log(JSON.stringify(task, null, 2));
      if (args.delivery !== "delivered" || task.receiptSentAt) {
        if (args.delivery === "retry") console.log("Delivery cleared for retry. Tap FarmClaw on the post again to re-queue it.");
        return;
      }
      // The handoff was reported failed while the outcome was unknown. A
      // receipt outranks that failure, so acknowledge it now.
      const agent = args.agent || process.env.FARMCLAW_AGENT || DEFAULT_AGENT;
      const res = await handoffClient(args).receipt(task.handoffId, receiptBody(task, agent));
      store.recordReceipt(task.id, res.ok ? { ok: true } : { ok: false, error: describeHttpError(res) });
      if (!res.ok) throw new Error(`receipt for ${task.handoffId} rejected: ${describeHttpError(res)}`);
      console.log(`Receipt sent for ${task.handoffId}; the dashboard now shows it received.`);
      return;
    }
    if (args.status === undefined && args.note === undefined) {
      const task = store.get(id);
      if (!task) throw new Error(`task ${id} not found`);
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    if (args.status !== undefined && !TASK_STATUSES.includes(args.status)) {
      throw new Error(`--status must be one of ${TASK_STATUSES.join(", ")}`);
    }
    const task = store.update(id, { status: args.status, note: args.note });
    if (!task) throw new Error(`task ${id} not found`);
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  usage();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[farmclaw-collector] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
