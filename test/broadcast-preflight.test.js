"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { buildPreflight, classifyDataDir, sameSecret } = require("../src/services/broadcast-preflight");

function tmpDir(prefix = "md-preflight-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal store stand-in — preflight only reads, never writes through it. */
function fakeStore(dataDir, { receipts = [], settings = {} } = {}) {
  return {
    dataDir,
    count: () => receipts.length,
    list: ({ limit = 50 } = {}) => receipts.slice(0, limit),
    getSettings: () => settings,
  };
}

function baseArgs(overrides = {}) {
  const dataDir = overrides.dataDir || tmpDir();
  return {
    config: {
      broadcastLedger: { apiKey: "S3CRET-LEDGER-VALUE", notificationTargets: ["-100999:12"] },
      admin: { apiKey: "S3CRET-ADMIN-VALUE" },
      telegram: { botToken: "S3CRET-WATCH-TOKEN", chatIds: ["-1001841650798:6297"] },
      newsTelegram: { botToken: "S3CRET-NEWS-TOKEN", chatIds: ["-1001841650798:6297"] },
    },
    broadcastLedgerStore: fakeStore(dataDir),
    broadcastIngestService: null,
    telegramService: { configured: true },
    newsTelegramService: { configured: true },
    env: { DATA_DIR: dataDir, RAILWAY_VOLUME_MOUNT_PATH: dataDir },
    bootedAt: new Date().toISOString(),
    ...overrides,
  };
}

function byId(report, id) {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `expected a check with id "${id}"`);
  return found;
}

/* ── secret handling ── */

test("secrets are compared without being revealed", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("", ""), false, "two unset values are not 'the same secret'");
  assert.equal(sameSecret("abc", ""), false);
});

test("no key or token value appears anywhere in the report", () => {
  const report = buildPreflight(baseArgs());
  const serialized = JSON.stringify(report);

  // Values chosen not to collide with any check id, so a hit is a real leak.
  ["S3CRET-LEDGER-VALUE", "S3CRET-ADMIN-VALUE", "S3CRET-WATCH-TOKEN", "S3CRET-NEWS-TOKEN"].forEach((secret) => {
    assert.ok(!serialized.includes(secret), `report leaked ${secret}`);
  });
});

/* ── data directory: the check everything else depends on ── */

test("an unset DATA_DIR is a failure, because every deploy wipes the ledger", () => {
  const result = classifyDataDir(path.join(process.cwd(), "data"), {});
  assert.equal(result.status, "fail");
  assert.match(result.detail, /wipes it|wipes the ledger/i);
});

test("DATA_DIR resolving to the in-container default is a failure even when set", () => {
  const result = classifyDataDir(path.join(process.cwd(), "data"), { DATA_DIR: "./data" });
  assert.equal(result.status, "fail");
});

test("DATA_DIR matching the Railway mount passes", () => {
  const result = classifyDataDir("/app/data", { DATA_DIR: "/app/data", RAILWAY_VOLUME_MOUNT_PATH: "/app/data" });
  assert.equal(result.status, "pass");
});

test("a DATA_DIR that cannot be confirmed as a mount warns rather than guessing", () => {
  const result = classifyDataDir("/srv/ledger", { DATA_DIR: "/srv/ledger" });
  assert.equal(result.status, "warn");
  assert.match(result.detail, /cannot be confirmed/i);
});

test("writability is proven by an actual write, not assumed", () => {
  const dir = tmpDir();
  const report = buildPreflight(baseArgs({ dataDir: dir, broadcastLedgerStore: fakeStore(dir) }));
  assert.equal(byId(report, "data-dir-writable").status, "pass");
  // The probe must clean up after itself.
  assert.deepEqual(fs.readdirSync(dir), [], "the probe file should not be left behind");
});

test("an unwritable data directory fails", () => {
  // A regular file standing where a parent directory should be: mkdir gets
  // ENOTDIR immediately. Deliberately not a /proc path — mkdirSync can block
  // indefinitely there, which would hang the run rather than fail it.
  const blocker = path.join(tmpDir(), "not-a-directory");
  fs.writeFileSync(blocker, "x", "utf8");

  const report = buildPreflight(
    baseArgs({ broadcastLedgerStore: fakeStore(path.join(blocker, "ledger")) }),
  );
  const found = byId(report, "data-dir-writable");
  assert.equal(found.status, "fail");
  assert.match(found.detail, /No receipt can be stored/i);
});

/* ── keys ── */

test("no key at all is a failure — the endpoints are returning 503", () => {
  const args = baseArgs();
  args.config.broadcastLedger.apiKey = "";
  args.config.admin.apiKey = "";
  assert.equal(byId(buildPreflight(args), "ledger-key").status, "fail");
});

test("falling back to the admin key warns", () => {
  const args = baseArgs();
  args.config.broadcastLedger.apiKey = "";
  const found = byId(buildPreflight(args), "ledger-key");
  assert.equal(found.status, "warn");
  assert.match(found.detail, /admin credential on the phone/i);
});

test("a ledger key identical to the admin key warns", () => {
  const args = baseArgs();
  args.config.broadcastLedger.apiKey = "S3CRET-ADMIN-VALUE";
  assert.equal(byId(buildPreflight(args), "ledger-key").status, "warn");
});

/* ── the 409 case ── */

test("one bot token shared by the watch and the news sender is a failure when the watch is on", () => {
  const args = baseArgs({
    broadcastIngestService: {
      describe: () => ({ enabled: true, conflict: false, watchedTargets: [{ chatId: "-1001841650798", threadId: "6297" }] }),
    },
  });
  args.config.telegram.botToken = "S3CRET-NEWS-TOKEN";

  const found = byId(buildPreflight(args), "bot-token-separation");
  assert.equal(found.status, "fail");
  assert.match(found.detail, /409/);
});

test("a shared token only warns while the watch is off", () => {
  const args = baseArgs();
  args.config.telegram.botToken = "S3CRET-NEWS-TOKEN";
  assert.equal(byId(buildPreflight(args), "bot-token-separation").status, "warn");
});

test("distinct tokens pass", () => {
  assert.equal(byId(buildPreflight(baseArgs()), "bot-token-separation").status, "pass");
});

/* ── what the watch actually covers ── */

test("a watch pointed at rooms news never reaches is reported as auditing nothing relevant", () => {
  const report = buildPreflight(
    baseArgs({
      broadcastIngestService: {
        describe: () => ({ enabled: true, conflict: false, watchedTargets: [{ chatId: "-100777", threadId: null }] }),
      },
    }),
  );
  const found = byId(report, "channel-watch");
  assert.equal(found.status, "warn");
  assert.match(found.detail, /audits nothing relevant/i);
});

test("a watch overlapping the news rooms passes, while still naming the protocol limit", () => {
  const report = buildPreflight(
    baseArgs({
      broadcastIngestService: {
        describe: () => ({ enabled: true, conflict: false, watchedTargets: [{ chatId: "-1001841650798", threadId: "6297" }] }),
      },
    }),
  );
  const found = byId(report, "channel-watch");
  assert.equal(found.status, "pass");
  assert.match(found.detail, /cannot see this bot's own posts/i);
});

test("an active 409 conflict is surfaced as a failure", () => {
  const report = buildPreflight(
    baseArgs({
      broadcastIngestService: { describe: () => ({ enabled: true, conflict: true, watchedTargets: [] }) },
    }),
  );
  assert.equal(byId(report, "channel-watch").status, "fail");
});

/* ── delivery configuration ── */

test("an unconfigured news bot fails, since /broadcast cannot deliver", () => {
  const report = buildPreflight(baseArgs({ newsTelegramService: { configured: false } }));
  const found = byId(report, "news-telegram");
  assert.equal(found.status, "fail");
  assert.match(found.detail, /cannot deliver/i);
});

test("missing notification targets warn that alerts silently do not send", () => {
  const args = baseArgs();
  args.config.broadcastLedger.notificationTargets = [];
  const found = byId(buildPreflight(args), "notification-targets");
  assert.equal(found.status, "warn");
  assert.match(found.detail, /silently do not send/i);
});

test("category routing is reported so the ids can be eyeballed", () => {
  const report = buildPreflight(
    baseArgs({
      destinationsForNewsType: (newsType) =>
        newsType === "Geopolitics"
          ? [{ chatId: "-1001841650798", threadId: "75972" }]
          : [{ chatId: "-1001841650798", threadId: "6297" }],
    }),
  );
  const found = byId(report, "news-routing");
  assert.equal(found.status, "pass");
  assert.equal(found.routing.Geopolitics[0].threadId, "75972");
  assert.equal(found.routing.Crypto[0].threadId, "6297");
});

/* ── the report as a whole ── */

test("a fully healthy configuration still refuses to claim delivery is proven", () => {
  const report = buildPreflight(
    baseArgs({
      broadcastIngestService: {
        describe: () => ({ enabled: true, conflict: false, watchedTargets: [{ chatId: "-1001841650798", threadId: "6297" }] }),
      },
      destinationsForNewsType: () => [{ chatId: "-1001841650798", threadId: "6297" }],
    }),
  );

  assert.equal(report.summary.fail, 0);
  // Replica count is always a warn — a process cannot see its siblings.
  assert.ok(report.summary.warn >= 1);
  assert.match(report.verdict, /still needs one real broadcast/i);
});

test("a broken configuration says plainly that it is not ready", () => {
  const args = baseArgs({ newsTelegramService: { configured: false } });
  args.config.broadcastLedger.apiKey = "";
  args.config.admin.apiKey = "";
  const report = buildPreflight(args);

  assert.ok(report.summary.fail >= 2);
  assert.match(report.verdict, /not ready/i);
});

test("the checks a human must still perform are named, not implied", () => {
  const report = buildPreflight(baseArgs());
  assert.ok(report.requiresHuman.length >= 4);
  assert.ok(report.requiresHuman.some((line) => /real broadcast/i.test(line)));
  assert.ok(report.requiresHuman.some((line) => /Redeploy/i.test(line)));
  assert.ok(report.requiresHuman.some((line) => /Shortcut/i.test(line)));
});

test("replica count is always flagged, because a process cannot check it", () => {
  const found = byId(buildPreflight(baseArgs()), "replica-count");
  assert.equal(found.status, "warn");
  assert.match(found.detail, /SINGLE replica/);
});

test("preflight never sends anything", () => {
  // Any call on a Telegram service would throw here, so a passing run proves
  // the report is read-only with respect to delivery.
  const exploding = new Proxy(
    { configured: true },
    {
      get(target, prop) {
        if (prop === "configured") return true;
        throw new Error(`preflight must not call telegram.${String(prop)}`);
      },
    },
  );
  const report = buildPreflight(baseArgs({ telegramService: exploding, newsTelegramService: exploding }));
  assert.ok(report.checks.length > 0);
});
