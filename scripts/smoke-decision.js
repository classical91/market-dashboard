"use strict";

// Production smoke check for the decision endpoint — the one the TraderClaw
// agent polls, and the one that answered `401 Login required` when site auth
// ran ahead of its router.
//
// Runs OUTSIDE the sandbox, against a deployed dashboard, because that is the
// only place Railway's environment (site password set, admin key set, real
// provider keys) actually exists. Nothing here mutates production state: every
// check is a GET, apart from one POST to /api/decision that is asserted to be
// *rejected* — that route has no POST handler, so it can only 401/403/404.
//
// Usage:
//   DASHBOARD_URL=https://your-dashboard.up.railway.app npm run smoke:decision
//   npm run smoke:decision -- https://your-dashboard.up.railway.app
//
// Optional:
//   DECISION_INTERVAL   interval to request, defaults to 4h
//   SMOKE_TIMEOUT_MS    per-request timeout, defaults to 20000
//
// Exit code is 0 only when every check passes.

const DEFAULT_TIMEOUT_MS = 20_000;

const baseUrl = String(process.argv[2] || process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
const interval = process.env.DECISION_INTERVAL || "4h";
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

if (!baseUrl) {
  console.error("smoke:decision — set DASHBOARD_URL (or pass the URL as the first argument).");
  console.error("  DASHBOARD_URL=https://your-dashboard.up.railway.app npm run smoke:decision");
  process.exit(2);
}

const results = [];
let warnings = 0;

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function warn(name, detail) {
  warnings += 1;
  console.log(`WARN  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Every request is deliberately cookie-less: the point is to reproduce what an
// unauthenticated machine caller sees.
async function request(method, path) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: true, status: res.status, body, text, url };
  } catch (err) {
    return { ok: false, status: 0, body: null, text: "", url, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function describe(res) {
  if (!res.ok) return `${res.url} — request failed: ${res.error}`;
  const snippet = res.text ? ` ${res.text.slice(0, 120).replace(/\s+/g, " ")}` : "";
  return `${res.url} — HTTP ${res.status}${snippet}`;
}

async function main() {
  console.log(`smoke:decision — ${baseUrl} (interval ${interval})\n`);

  // 1. The deploy is up at all. Everything after this is meaningless if it is not.
  const health = await request("GET", "/api/health");
  record(health.ok && health.status === 200, "health probe responds", describe(health));
  if (!health.ok || health.status !== 200) {
    return finish();
  }

  // 2. The regression itself: an anonymous machine caller must not get 401.
  const decision = await request("GET", `/api/decision?interval=${encodeURIComponent(interval)}`);
  const decisionOk = decision.ok && decision.status === 200;
  record(decisionOk, "GET /api/decision is reachable without a login", describe(decision));

  if (decisionOk && decision.body) {
    const body = decision.body;

    // 3-6. The fields TraderClaw actually reads off the payload.
    record(body.interval === interval, "response echoes the requested interval", `interval=${body.interval}`);

    const regime = body.regime || null;
    record(
      Boolean(regime && regime.label && Number.isFinite(Number(regime.score))),
      "regime is present with a label and score",
      regime ? `${regime.label} (${regime.score})` : "no regime block",
    );

    const setups = Array.isArray(body.setups) ? body.setups : null;
    record(Boolean(setups), "setups is an array", setups ? `${setups.length} entries` : "missing or not an array");

    // A setup carrying `error` means the upstream candle feed failed for that
    // symbol. That is a provider problem, not an auth or routing problem, so it
    // warns rather than fails — the endpoint itself is behaving correctly.
    const scored = (setups || []).filter((s) => s && !s.error && Number.isFinite(Number(s.setupScore)));
    if (!setups || !setups.length) {
      warn("setup scores present", "no setups returned");
    } else if (!scored.length) {
      warn(
        "setup scores present",
        `all ${setups.length} setups returned an upstream error, e.g. ${(setups[0] && setups[0].error) || "unknown"}`,
      );
    } else {
      record(true, "setup scores present", `${scored.length}/${setups.length} scored`);
      const complete = scored.filter((s) => s.signal && s.action);
      record(
        complete.length === scored.length,
        "scored setups carry a direction and an action",
        `${complete.length}/${scored.length}`,
      );
    }

    const quality = body.dataQuality || null;
    if (quality && quality.warnings && quality.warnings.length) {
      warn("data quality", `${quality.warnings.length} degraded input(s): ${quality.warnings[0]}`);
    }
  }

  // 7. The bypass must be exactly one path and exactly read methods. If site
  // auth is not configured on this deploy these read as open — reported as a
  // warning, since that is a deployment-configuration fact, not a code defect.
  const journal = await request("GET", "/api/decision/journal");
  if (journal.status === 200) {
    warn("journal reads require a session", `${describe(journal)} (is MARKET_DASHBOARD_LOGIN_PASSWORD set?)`);
  } else {
    record([401, 403].includes(journal.status), "journal reads require a session", describe(journal));
  }

  const write = await request("POST", "/api/decision");
  record(
    write.ok && write.status >= 400,
    "writes to /api/decision do not inherit the read bypass",
    describe(write),
  );

  const lab = await request("GET", "/api/trading-lab/overview");
  if (lab.status === 200) {
    warn("Trading Lab requires a session", `${describe(lab)} (is MARKET_DASHBOARD_LOGIN_PASSWORD set?)`);
  } else {
    record([401, 403].includes(lab.status), "Trading Lab requires a session", describe(lab));
  }

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length ? "FAILED" : "OK"} — ${results.length - failed.length}/${results.length} checks passed` +
      `${warnings ? `, ${warnings} warning(s)` : ""}`,
  );
  for (const failure of failed) {
    console.log(`  failing: ${failure.name} — ${failure.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`smoke:decision crashed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
