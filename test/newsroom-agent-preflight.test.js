"use strict";

// The agent-route preflight is the one check that reaches outside this
// service, and it exists because of the August 11 failure: a credential the
// gateway no longer recognized, discovered hours later as silence. These pin
// the three things that make it worth having — it never sends, it never leaks
// the token, and it refuses to call an unverifiable route a pass.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createAgentRoutePreflight, authHeaders } = require("../src/services/newsroom-agent-preflight");
const { NewsroomService } = require("../src/services/newsroom");
const { NewsroomCycleStore } = require("../src/services/newsroom-cycles");
const { ReporterService } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

const TOKEN = "sharebot-cron-token-value";
const URL = "https://openclaw.example/agents/whoami";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

/* ── the check itself ── */

test("no configured URL means no checker at all", () => {
  assert.equal(createAgentRoutePreflight({}), null);
  assert.equal(createAgentRoutePreflight({ url: "   " }), null);
});

test("a healthy route passes and reports what it actually proved", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { agent: "newsreporter", account: "acct_1" }));
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl });

  const result = await check();

  assert.equal(result.ok, true);
  assert.equal(result.status, "pass");
  assert.match(
    result.detail,
    /proves the credential resolves, not which agent/i,
    "without an expected identity the check must not overclaim",
  );
});

test("the check is a GET and carries the credential as a bearer header", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { agent: "newsreporter" }));
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl });

  await check();

  const [call] = fetchImpl.calls;
  assert.equal(call.options.method, "GET", "a preflight must never make the agent do work");
  assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.options.body, undefined);
});

test("a token that already names its scheme is not double-prefixed", () => {
  assert.deepEqual(authHeaders("Authorization", "Bearer abc"), { Authorization: "Bearer abc" });
  assert.deepEqual(authHeaders("Authorization", "abc"), { Authorization: "Bearer abc" });
  assert.deepEqual(authHeaders("x-openclaw-key", "abc"), { "x-openclaw-key": "abc" });
  assert.deepEqual(authHeaders("Authorization", ""), {});
});

// The August 11 failure, reproduced through the preflight instead of through
// a cycle that had already spent its generation budget.
test("HTTP 401 \"User not found\" fails the check as a provider identity failure", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(401, "User not found"));
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl });

  const result = await check();

  assert.equal(result.ok, false);
  assert.equal(result.status, "fail");
  assert.equal(result.code, "provider_user_not_found");
  assert.equal(result.retryable, false);
  assert.equal(result.httpStatus, 401);
});

test("a route that resolves to the wrong identity fails rather than passes", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { agent: "someone-elses-bot" }));
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN, expectIdentity: "newsreporter" }, { fetchImpl });

  const result = await check();

  assert.equal(result.ok, false);
  assert.equal(result.code, "identity_mismatch");
  assert.match(result.detail, /different agent/i);
});

test("a matching identity passes and says so", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { agent: "newsreporter" }));
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN, expectIdentity: "newsreporter" }, { fetchImpl });

  const result = await check();

  assert.equal(result.ok, true);
  assert.match(result.detail, /names the expected identity/i);
});

test("an unreachable gateway degrades the check instead of throwing", async () => {
  const fetchImpl = fakeFetch(() => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  });
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl });

  const result = await check();

  assert.equal(result.ok, false);
  assert.equal(result.code, "network");
  assert.equal(result.retryable, true, "a transport fault is worth retrying, unlike a rejected identity");
});

test("the token never appears in the result", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(401, `User not found for token ${TOKEN}`));
  const check = createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl });

  const result = await check();

  assert.equal(
    JSON.stringify(result).includes(TOKEN),
    false,
    "not even a gateway that echoes the token back may put it in a preflight result",
  );
});

/* ── how a cycle uses it ── */

function makeNewsroom({ externalPreflight, allowPartialDelivery = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-agent-preflight-"));
  const reporterService = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "test-key",
    model: "test-model",
    dataDir,
  });
  const generated = [];
  reporterService._generate = async () => {
    generated.push(1);
    return { content: "section body", sources: [] };
  };
  const telegramService = {
    calls: [],
    configured: true,
    _chatIds: [{ chatId: "-100111", threadId: "1" }],
    async postReportSection({ newsType, targets }) {
      this.calls.push({ newsType });
      const sent = targets || this._chatIds;
      return {
        destinations: sent.map((target, index) => ({
          channel: "telegram",
          chatId: String(target.chatId),
          threadId: target.threadId == null ? null : String(target.threadId),
          status: "posted",
          messageId: String(300 + index + this.calls.length),
        })),
      };
    },
  };
  const newsroom = new NewsroomService({
    cycleStore: new NewsroomCycleStore({ dataDir, logger: { error() {} } }),
    reporterService,
    telegramService,
    broadcastLedgerStore: new BroadcastLedgerStore({ dataDir, logger: { error() {} } }),
    sections: ["crypto", "economics", "markets"],
    externalPreflight,
    allowPartialDelivery,
    logger: { error() {} },
  });
  return { newsroom, telegramService, generated };
}

test("a rejected agent route fails preflight and the cycle spends nothing", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(401, "User not found"));
  const { newsroom, telegramService, generated } = makeNewsroom({
    externalPreflight: createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl }),
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" });

  assert.equal(cycle.status, "preflight_failed");
  assert.equal(generated.length, 0, "no generation is attempted behind a rejected identity");
  assert.equal(telegramService.calls.length, 0);

  const check = cycle.preflight.checks.find((entry) => entry.name === "external-agent-route");
  assert.equal(check.status, "fail");
  assert.equal(check.code, "provider_user_not_found");
});

test("a verified agent route lets the cycle run and reports pass in health", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { agent: "newsreporter" }));
  const { newsroom } = makeNewsroom({
    externalPreflight: createAgentRoutePreflight({ url: URL, token: TOKEN }, { fetchImpl }),
  });

  const { cycle } = await newsroom.runCycle({ scheduledAt: "2026-08-26T13:00:00.000Z", trigger: "cron" });
  assert.equal(cycle.status, "completed");

  const health = newsroom.health();
  assert.equal(health.agentRoute.status, "pass");
  assert.equal(health.agentRoute.verified, true);
});

test("health reports the route as unverified when nothing is configured", () => {
  const { newsroom } = makeNewsroom();
  const health = newsroom.health();

  assert.equal(health.agentRoute.status, "warn");
  assert.equal(health.agentRoute.verified, false);
});
