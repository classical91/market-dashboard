"use strict";

// The smoke script is the tool that will be pointed at Railway, where none of
// this suite can reach. So it is exercised here against a stub dashboard: a
// healthy deploy passes, the 401 regression fails loudly, and — the property
// that matters most for a production tool — it never mutates anything.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "smoke-decision.js");

function healthyDecision(interval = "4h") {
  return {
    status: "ok",
    updatedAt: new Date().toISOString(),
    interval,
    regime: { label: "Risk-On", score: 67, modifiers: [] },
    setups: [
      { symbol: "BTCUSDT", signal: "LONG", setupScore: 78, action: "Ready — watch for entry" },
      { symbol: "ETHUSDT", signal: "SHORT", setupScore: 51, action: "Low edge" },
    ],
    dataQuality: { modules: {}, warnings: [] },
  };
}

// `routes` maps "METHOD /path" to [status, body]. Anything unrouted is 404, so
// a request the script should not be making shows up as a failed check.
function stubDashboard(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push(`${req.method} ${url.pathname}`);
    const handler = routes[`${req.method} ${url.pathname}`];
    const [status, body] = handler ? handler(url) : [404, { error: "Not found" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return { server, seen };
}

async function runSmoke(routes) {
  const { server, seen } = stubDashboard(routes);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT, base],
        { env: { ...process.env, SMOKE_TIMEOUT_MS: "5000" } },
        (err, stdout, stderr) => {
          resolve({ code: err ? err.code : 0, stdout, stderr, seen });
        },
      );
    });
  } finally {
    server.close();
  }
}

const LOCKED_DOWN = {
  "GET /api/health": () => [200, { status: "ok" }],
  "GET /api/decision": (url) => [200, healthyDecision(url.searchParams.get("interval") || "4h")],
  "GET /api/decision/journal": () => [401, { error: "Login required." }],
  "POST /api/decision": () => [401, { error: "Login required." }],
  "GET /api/trading-lab/overview": () => [401, { error: "Login required." }],
};

test("a correctly configured deploy passes every check", async () => {
  const { code, stdout } = await runSmoke(LOCKED_DOWN);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^OK — \d+\/\d+ checks passed/m);
  assert.doesNotMatch(stdout, /^FAIL/m);
});

test("the 401 regression fails the run and names the endpoint and status", async () => {
  const { code, stdout } = await runSmoke({
    ...LOCKED_DOWN,
    "GET /api/decision": () => [401, { error: "Login required." }],
  });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}GET \/api\/decision is reachable without a login/);
  assert.match(stdout, /HTTP 401/);
  assert.match(stdout, /^FAILED —/m);
});

test("a decision payload missing its regime fails rather than reporting green", async () => {
  const { code, stdout } = await runSmoke({
    ...LOCKED_DOWN,
    "GET /api/decision": () => [200, { status: "ok", interval: "4h", setups: [] }],
  });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}regime is present/);
});

// Degraded upstream candles are a provider problem, not an auth or routing
// problem — the endpoint is behaving correctly, so this must not read as a
// failure of the deploy.
test("upstream setup errors warn instead of failing", async () => {
  const { code, stdout } = await runSmoke({
    ...LOCKED_DOWN,
    "GET /api/decision": () => [
      200,
      {
        ...healthyDecision(),
        setups: [{ symbol: "BTCUSDT", error: "Binance klines HTTP 403 for BTCUSDT 4h" }],
      },
    ],
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /WARN {2}setup scores present/);
  assert.match(stdout, /Binance klines HTTP 403/);
});

test("an unreachable deploy fails on health and stops there", async () => {
  const { code, stdout, seen } = await runSmoke({});
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}health probe responds/);
  assert.deepEqual(seen, ["GET /api/health"], "no further probing after health fails");
});

test("the script never issues a request that could mutate production state", async () => {
  const { seen } = await runSmoke(LOCKED_DOWN);
  const mutations = seen.filter((entry) => !entry.startsWith("GET "));

  // Exactly one non-GET, and only to prove the read bypass is not a write
  // bypass. That route has no POST handler, so it cannot change anything.
  assert.deepEqual(mutations, ["POST /api/decision"]);
  assert.ok(
    !seen.some((entry) => entry.includes("/trades") || entry.includes("/paper")),
    "the smoke check must never touch a trade or paper-execution route",
  );
});

test("it refuses to run without a target URL", async () => {
  const { code, stderr } = await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.DASHBOARD_URL;
    execFile(process.execPath, [SCRIPT], { env }, (err, stdout, stderrOut) => {
      resolve({ code: err ? err.code : 0, stderr: stderrOut });
    });
  });
  assert.equal(code, 2);
  assert.match(stderr, /DASHBOARD_URL/);
});
