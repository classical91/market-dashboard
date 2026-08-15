"use strict";

// The app must boot under the environment combinations a deployment actually
// uses. This file exists because it did not.
//
// PR #184 added a LiveResearchService constructor that threw when the Live
// Scanner and Live Research both claimed a strategy account. mindset_v1 is both
// scanner eligible and live-research eligible, so `ENABLE_LIVE_SCANNER=true`
// made createApp() throw — the process never listened, Railway's /api/health
// probe never answered, and the restart policy looped forever.
//
// Every existing check passed throughout: lint, build, the unit suite, and a
// test that asserted the throw as correct behaviour. Nothing exercised "does
// the app start with the flags production sets", which is the one thing broken.
//
// ── Why a child process ─────────────────────────────────────────────────────
//
// src/config/env.js computes `config` once at module load, so mutating
// process.env inside this file after requiring src/app would change nothing:
// the test would pass whatever the code did, including against the broken
// version. Each configuration is therefore booted in a fresh node process with
// the environment set before it starts — which is also exactly how a deployment
// boots, so the test reproduces the failure rather than approximating it.

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Boots the app in a child process and reports what happened. Returns the
// child's stdout so a caller can assert on what the app decided at startup.
function boot(env) {
  const script = `
    const app = require(${JSON.stringify(path.join(ROOT, "src", "app.js"))}).createApp();
    const research = app.locals.liveResearch;
    process.stdout.write(JSON.stringify({
      booted: typeof app === "function",
      reservedByScanner: research ? research.reservedByScanner : null,
      researchOwns: research
        ? ["mindset_v1", "smc_v1", "donchian_breakout_v1", "vwap_reversion_v1"]
            .filter((id) => research.ownsStrategy(id))
        : null,
    }));
  `;
  try {
    const stdout = execFileSync(process.execPath, ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "md-boot-")),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, ...JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message) };
  }
}

const CONFIGURATIONS = [
  ["defaults", {}],
  // The configuration that was fatal: the scanner running its promoted strategy
  // while live research is on. Both default to on once the scanner flag is set.
  ["live scanner enabled", { ENABLE_LIVE_SCANNER: "true" }],
  ["live scanner + explicit paper trading", { ENABLE_LIVE_SCANNER: "true", LIVE_SCANNER_PAPER_TRADE_ENABLED: "true" }],
  ["live research disabled", { LIVE_RESEARCH_ENABLED: "false" }],
  ["both loops off", { ENABLE_LIVE_SCANNER: "false", LIVE_RESEARCH_ENABLED: "false" }],
  ["scanner on, research off", { ENABLE_LIVE_SCANNER: "true", LIVE_RESEARCH_ENABLED: "false" }],
];

for (const [name, env] of CONFIGURATIONS) {
  test(`the app boots with ${name}`, () => {
    const result = boot(env);
    assert.ok(result.ok, `the app failed to start with ${name}:\n${result.stderr || ""}`);
    assert.equal(result.booted, true);
  });
}

test("a strategy-account writer conflict degrades one loop, not the whole app", () => {
  const result = boot({ ENABLE_LIVE_SCANNER: "true", LIVE_RESEARCH_ENABLED: "true" });

  assert.ok(result.ok, `the app failed to start:\n${result.stderr || ""}`);
  // The scanner keeps sole ownership of the ledger it writes.
  assert.deepEqual(result.reservedByScanner, ["mindset_v1"]);
  assert.ok(!result.researchOwns.includes("mindset_v1"), "Live Research must not claim the scanner's ledger");
  // And the conflict costs exactly the one strategy it is about — the other
  // accounts keep collecting evidence.
  assert.deepEqual(result.researchOwns.sort(), ["donchian_breakout_v1", "smc_v1", "vwap_reversion_v1"]);
});
