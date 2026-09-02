#!/usr/bin/env node
"use strict";

/**
 * Runs the read-only half of docs/production-verification.md against a live
 * deployment and prints a verdict.
 *
 * Deliberately sends nothing. Every check here is a GET, or a POST that only
 * reads (lookup, reconcile in report mode). Delivery, the guard rails and the
 * retry path put real messages in real rooms, so those remain a human
 * decision and are printed at the end as what is left to do by hand.
 *
 *   node scripts/verify-broadcast-ledger.js \
 *     --url https://<your-app>.up.railway.app \
 *     --key "$BROADCAST_LEDGER_API_KEY"
 *
 * The key may also come from BROADCAST_LEDGER_API_KEY in the environment, so
 * it need not appear in shell history.
 */

const BASE_FLAG = "--url";
const KEY_FLAG = "--key";

function parseArgs(argv) {
  const args = { url: "", key: process.env.BROADCAST_LEDGER_API_KEY || "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === BASE_FLAG) args.url = String(argv[i + 1] || "").replace(/\/+$/, "");
    if (argv[i] === KEY_FLAG) args.key = String(argv[i + 1] || "");
  }
  return args;
}

const ICON = { pass: "PASS", warn: "WARN", fail: "FAIL" };

async function request(base, key, path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-broadcast-key": key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — an HTML page or a proxy error */
  }
  return { status: res.status, json, text };
}

function line(status, title, detail) {
  console.log(`  [${ICON[status] || status}] ${title}`);
  if (detail) console.log(`         ${String(detail).replace(/\n/g, "\n         ")}`);
}

async function main() {
  const { url, key } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error(`Usage: node scripts/verify-broadcast-ledger.js ${BASE_FLAG} https://host [${KEY_FLAG} <key>]`);
    process.exit(2);
  }
  if (!key) {
    console.error("No key. Pass --key or set BROADCAST_LEDGER_API_KEY.");
    process.exit(2);
  }

  let failures = 0;
  let warnings = 0;

  console.log(`\nBroadcast ledger verification — ${url}\n`);

  /* ── reachability, before anything else ── */

  console.log("Reachability");
  let health;
  try {
    health = await request(url, key, "/api/health");
  } catch (err) {
    line("fail", "Host unreachable", err.message);
    console.log("\nNothing else can be checked. Verify the URL and that the service is running.\n");
    process.exit(1);
  }
  if (health.status !== 200) {
    line("fail", `/api/health returned ${health.status}`, health.text.slice(0, 200));
    failures += 1;
  } else {
    line("pass", "Service is up");
  }

  /* ── the configuration half, answered by the deployment itself ── */

  console.log("\nConfiguration (from /preflight)");
  const pre = await request(url, key, "/api/broadcast-ledger/preflight");
  if (pre.status === 401) {
    line("fail", "Key rejected", "The key is wrong, or this deploy predates the preflight endpoint.");
    failures += 1;
  } else if (pre.status === 404) {
    line("warn", "No /preflight endpoint", "This deploy predates it. Redeploy to get the automated checks.");
    warnings += 1;
  } else if (pre.status !== 200 || !pre.json) {
    line("fail", `/preflight returned ${pre.status}`, pre.text.slice(0, 200));
    failures += 1;
  } else {
    pre.json.checks.forEach((c) => {
      line(c.status, c.title, c.detail);
      if (c.status === "fail") failures += 1;
      if (c.status === "warn") warnings += 1;
    });
  }

  /* ── the ledger's own state ── */

  console.log("\nLedger state (from /status)");
  const status = await request(url, key, "/api/broadcast-ledger/status");
  if (status.status !== 200 || !status.json) {
    line("fail", `/status returned ${status.status}`, status.text.slice(0, 200));
    failures += 1;
  } else {
    const s = status.json;
    line(s.count ? "pass" : "warn", `${s.count} receipt(s) recorded`,
      s.count ? "" : "Nothing recorded yet, so persistence across deploys is unproven.");
    if (!s.count) warnings += 1;
    const sources = Object.entries(s.bySource || {}).filter(([, n]) => n);
    line("pass", "By source", sources.length ? sources.map(([k, n]) => `${n} ${k}`).join(" · ") : "none");
    if (s.latest) {
      line("pass", "Most recent", `${s.latest.title || s.latest.id} — ${s.latest.status} at ${s.latest.createdAt}`);
    }
  }

  /* ── read-only endpoints the agent depends on ── */

  console.log("\nAgent-facing endpoints (read-only)");
  const lookup = await request(url, key, "/api/broadcast-ledger/lookup", {
    method: "POST",
    body: { url: "https://example.invalid/preflight-probe-should-not-exist" },
  });
  if (lookup.status !== 200 || !lookup.json) {
    line("fail", `/lookup returned ${lookup.status}`, lookup.text.slice(0, 200));
    failures += 1;
  } else if (lookup.json.posted !== false) {
    line("fail", "/lookup claimed a probe URL was already posted", JSON.stringify(lookup.json).slice(0, 200));
    failures += 1;
  } else {
    line("pass", "/lookup answers the preflight ShareBot67 uses");
  }

  const reconcile = await request(url, key, "/api/broadcast-ledger/reconcile", {
    method: "POST",
    body: { windowMs: 172800000 },
  });
  if (reconcile.status !== 200 || !reconcile.json) {
    line("fail", `/reconcile returned ${reconcile.status}`, reconcile.text.slice(0, 200));
    failures += 1;
  } else {
    const { checked = 0, reconciled = [], outstanding = [] } = reconcile.json;
    line(
      outstanding.length ? "warn" : "pass",
      `/reconcile checked ${checked}`,
      outstanding.length
        ? `${outstanding.length} outstanding: ${outstanding.map((o) => o.title || o.id).join(", ")}`
        : `${reconciled.length} resolved, nothing outstanding.`,
    );
    if (outstanding.length) warnings += 1;
  }

  /* ── verdict ── */

  console.log("\n" + "-".repeat(64));
  if (failures) {
    console.log(`NOT READY — ${failures} failure(s), ${warnings} warning(s).`);
  } else {
    console.log(`Automated checks pass — ${warnings} warning(s) worth reading.`);
  }

  console.log(
    "\nStill requires a human, because each one puts a real message in a real room:\n" +
      "  1. Send one real broadcast; confirm the receipt carries a true Telegram message id.\n" +
      "  2. Repeat a category inside its window; expect 409 and a visible blocked receipt.\n" +
      "  3. Send with no category; expect Unclassified and a missingCategory alert.\n" +
      "  4. Point one destination at a bad chat id, send, then retry from the ledger page.\n" +
      "  5. Redeploy; confirm pre-deploy receipts are still listed.\n" +
      "  6. Confirm the iOS Shortcut posts to /api/broadcast-ledger/broadcast.\n",
  );

  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nVerification aborted: ${err.message}\n`);
  process.exit(1);
});
