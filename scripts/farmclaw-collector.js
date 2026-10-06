#!/usr/bin/env node
"use strict";

/**
 * FarmClaw's side of the dashboard handoff queue. Runs on FarmClaw's host,
 * not on the dashboard. See docs/farmclaw-handoff.md.
 *
 *   node scripts/farmclaw-collector.js run              one claim → intake → receipt pass
 *   node scripts/farmclaw-collector.js watch [--interval 60]
 *                                                        the recurring collector
 *   node scripts/farmclaw-collector.js tasks [--status open] [--limit 50]
 *   node scripts/farmclaw-collector.js task <id> [--status in_progress|done|dropped|open] [--note "..."]
 *
 * Environment:
 *   BROADCAST_LEDGER_API_KEY  machine key (required for run/watch)
 *   FARMCLAW_DASHBOARD_URL    dashboard base URL (default: production)
 *   FARMCLAW_INTAKE_FILE      task store path (default: ~/.farmclaw/intake.json)
 *   FARMCLAW_AGENT            claimant name (default: farmclaw)
 */

const os = require("os");
const path = require("path");
const { FarmclawIntakeStore, TASK_STATUSES } = require("../src/services/farmclaw-intake");
const { createHandoffClient, collectOnce, DEFAULT_AGENT } = require("../src/services/farmclaw-collector");

const DEFAULT_DASHBOARD_URL = "https://market-dashboard-production-b2f4.up.railway.app";
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
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
  console.error("usage: farmclaw-collector.js run | watch [--interval 60] | tasks [--status s] | task <id> [--status s] [--note text]");
  process.exit(code);
}

async function runPass(store, args) {
  const client = createHandoffClient({
    baseUrl: args.url || process.env.FARMCLAW_DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
    key: args.key || process.env.BROADCAST_LEDGER_API_KEY,
  });
  return collectOnce({
    client,
    store,
    agent: args.agent || process.env.FARMCLAW_AGENT || DEFAULT_AGENT,
    limit: Number(args.limit) || 10,
  });
}

function printSummary(summary) {
  console.log(
    `[farmclaw-collector] ${new Date().toISOString()} claimed=${summary.claimed} received=${summary.received}` +
      ` already=${summary.alreadyReceived} failed=${summary.failed} retry=${summary.pendingRetry}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "run";
  const store = new FarmclawIntakeStore({ file: intakeFile(args) });

  if (command === "run") {
    const summary = await runPass(store, args);
    printSummary(summary);
    process.exitCode = summary.errors.length ? 2 : 0;
    return;
  }

  if (command === "watch") {
    const intervalMs = Math.max(MIN_INTERVAL_SECONDS, Number(args.interval) || DEFAULT_INTERVAL_SECONDS) * 1000;
    console.log(`[farmclaw-collector] watching every ${intervalMs / 1000}s; tasks in ${store.file}`);
    let stopping = false;
    const stop = () => { stopping = true; };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopping) {
      try {
        printSummary(await runPass(store, args));
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

  if (command === "tasks") {
    const tasks = store.list({ status: args.status, limit: args.limit });
    if (args.json !== undefined) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (!tasks.length) console.log("no tasks");
    tasks.forEach((task) => {
      const receipt = task.receiptSentAt ? "receipt ✓" : task.receiptError ? `receipt ✗ ${task.receiptError}` : "receipt pending";
      console.log(`${task.id}  ${task.status.padEnd(11)} ${task.createdAt}  ${task.url}  (${receipt})`);
    });
    return;
  }

  if (command === "task") {
    const id = args._[1];
    if (!id) usage();
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
