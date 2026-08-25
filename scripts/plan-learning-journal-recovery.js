"use strict";

// Read-only incident recovery planner. It never writes Market Dashboard data
// or the learning journal. Re-running against unchanged inputs produces the
// same stable-position-ID plan, so an operator can review exactly what a later
// journal capture would need to append before approving any write.

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--") || i + 1 >= argv.length) throw new Error(`Expected --name value, got ${key}`);
    options[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  if (!options["base-url"] || !options.journal) {
    throw new Error("Usage: node scripts/plan-learning-journal-recovery.js --base-url URL --journal FILE");
  }
  return options;
}

function journalPositionIds(text, baseUrl) {
  const ids = new Set();
  for (const [index, line] of String(text || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid journal JSON on line ${index + 1}: ${err.message}`);
    }
    const fromDashboard = (row.source_refs || []).some((ref) =>
      String(ref.path_or_url || "").startsWith(`${baseUrl}/api/trading-lab/strategy-accounts/`),
    );
    const positionId = row.trade_state && row.trade_state.position_id;
    if (fromDashboard && positionId) ids.add(String(positionId));
  }
  return ids;
}

function buildRecoveryPlan({ accounts, details, actions, journalIds, baseUrl }) {
  const executions = [];
  for (const account of accounts) {
    const detail = details.get(String(account.id)) || {};
    for (const [state, rows] of [["open", detail.openPositions || []], ["closed", detail.history || []]]) {
      for (const row of rows) {
        if (!row || !row.id) continue;
        executions.push({
          positionId: String(row.id),
          strategyId: String(account.id),
          state,
          symbol: row.symbol || null,
          openedAt: row.openedAt || null,
          closedAt: row.closedAt || null,
          source: `${baseUrl}/api/trading-lab/strategy-accounts/${encodeURIComponent(account.id)}`,
        });
      }
    }
  }
  const byId = new Map(executions.map((row) => [row.positionId, row]));
  const missing = [...byId.values()].filter((row) => !journalIds.has(row.positionId));
  const orphan = [...journalIds].filter((id) => !byId.has(id));
  const statuses = {};
  for (const action of actions) statuses[action.status || "unknown"] = (statuses[action.status || "unknown"] || 0) + 1;
  const incomplete = actions.filter((row) => !row.symbol || !row.direction || !row.strategy);

  return {
    mode: "dry-run",
    writesPerformed: false,
    definitions: {
      execution: "unique position id from strategy-account openPositions/history",
      journalMatch: "trade_state.position_id on a Market Dashboard strategy-account source_ref",
      incompleteEvaluation: "signal action missing symbol, direction, or strategy",
    },
    executions: { totalRows: executions.length, uniquePositionIds: byId.size },
    journal: { uniqueDashboardPositionIds: journalIds.size },
    reconciliation: { matched: byId.size - missing.length, missing: missing.length, orphan: orphan.length },
    missing,
    orphanPositionIds: orphan.sort(),
    signalActions: {
      total: actions.length,
      byStatus: statuses,
      incompleteAttribution: incomplete.length,
      recoveredLegacyAttribution: actions.filter((row) => row.attributionRecovered === true).length,
    },
  };
}

async function requestJson(baseUrl, pathname, adminKey) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "application/json", "x-admin-key": adminKey },
  });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = options["base-url"].replace(/\/$/, "");
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error("ADMIN_API_KEY is required in the process environment");
  const journal = path.resolve(options.journal);
  const accountsPayload = await requestJson(baseUrl, "/api/trading-lab/strategy-accounts", adminKey);
  const actionsPayload = await requestJson(baseUrl, "/api/trading-lab/signal-actions?limit=2000", adminKey);
  const details = new Map();
  for (const account of accountsPayload.accounts || []) {
    details.set(
      String(account.id),
      await requestJson(baseUrl, `/api/trading-lab/strategy-accounts/${encodeURIComponent(account.id)}?limit=1000`, adminKey),
    );
  }
  const plan = buildRecoveryPlan({
    accounts: accountsPayload.accounts || [],
    details,
    actions: actionsPayload.items || [],
    journalIds: journalPositionIds(fs.readFileSync(journal, "utf8"), baseUrl),
    baseUrl,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Recovery planning failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildRecoveryPlan, journalPositionIds, parseArgs };
