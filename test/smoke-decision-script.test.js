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
    dataQuality: {
      modules: { crypto: "live", equities: "live", calendar: "live" },
      calendar: {
        source: "macro_calendar_url",
        live: true,
        reason: null,
        detail: null,
        timezone: "America/New_York",
        fetchedAt: "2026-08-23T12:00:00.000Z",
        events: 2,
        timing: { total: 2, exact: 2, assumed: 0, untimed: 0 },
        droppedNotToday: 0,
      },
      warnings: [],
    },
  };
}

// What a Binance/provider outage actually looks like on the wire: the endpoint
// is healthy, the shape is right, and every number in it is meaningless.
function degradedDecision() {
  return {
    ...healthyDecision(),
    setups: [{ symbol: "BTCUSDT", error: "Binance klines HTTP 403 for BTCUSDT 4h" }],
    dataQuality: {
      modules: { crypto: "fallback", equities: "fallback", macro: "fallback", calendar: "fallback" },
      calendar: {
        source: "fallback",
        live: false,
        reason: "request-failed",
        detail: "Macro calendar HTTP 503",
        timezone: "UTC",
        fetchedAt: null,
        events: 4,
        timing: { total: 4, exact: 0, assumed: 0, untimed: 4 },
        droppedNotToday: 0,
      },
      warnings: ["Crypto prices using fallback data — regime score is degraded"],
    },
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

async function runSmoke(routes, { strict = false } = {}) {
  const { server, seen } = stubDashboard(routes);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        strict ? [SCRIPT, base, "--strict"] : [SCRIPT, base],
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
  "GET /api/trading-lab": () => [401, { error: "Login required." }],
};

test("a correctly configured deploy passes every check", async () => {
  const { code, stdout } = await runSmoke(LOCKED_DOWN);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^OK \(normal\) — \d+\/\d+ checks passed/m);
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
  assert.match(stdout, /^FAILED \(normal\) —/m);
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
// problem, so the *deploy-health* question stays green.
test("normal mode warns on upstream setup errors instead of failing", async () => {
  const { code, stdout } = await runSmoke({
    ...LOCKED_DOWN,
    "GET /api/decision": () => [200, degradedDecision()],
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /WARN {2}at least one setup carries a finite setupScore/);
  assert.match(stdout, /Binance klines HTTP 403/);
  assert.match(stdout, /re-run with --strict/);
});

// The *trading-health* question is the opposite: reachable but unusable is not
// green, and this is the run that has to say so.
test("strict mode fails the same degraded payload", async () => {
  const { code, stdout } = await runSmoke(
    { ...LOCKED_DOWN, "GET /api/decision": () => [200, degradedDecision()] },
    { strict: true },
  );
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}at least one setup carries a finite setupScore/);
  assert.match(stdout, /FAIL {2}market data is not entirely degraded/);
  assert.match(stdout, /^FAILED \(strict\)/m);
});

test("strict mode passes a genuinely healthy payload", async () => {
  const { code, stdout } = await runSmoke(LOCKED_DOWN, { strict: true });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^OK \(strict\)/m);
  assert.doesNotMatch(stdout, /^FAIL/m);
});

// Number(null) is 0, so Number.isFinite(Number(setupScore)) waved a null score
// through as a legitimate zero. scoreSetup() returns null for a row with no
// setup, so this is the shape a real degraded board has — a strict run must not
// report green over exactly the missing data it exists to catch.
test("strict mode rejects a null setup score instead of reading it as zero", async () => {
  const { code, stdout } = await runSmoke(
    {
      ...LOCKED_DOWN,
      "GET /api/decision": () => [
        200,
        {
          ...healthyDecision(),
          setups: [
            { symbol: "BTCUSDT", signal: "FLAT", setupScore: null, action: "No setup" },
            { symbol: "ETHUSDT", signal: "FLAT", setupScore: null, action: "No setup" },
          ],
        },
      ],
    },
    { strict: true },
  );
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}at least one setup carries a finite setupScore/);
});

// The same coercion trap, one level up: a null regime score is not a score of 0.
test("strict mode rejects a null regime score", async () => {
  const { code, stdout } = await runSmoke(
    {
      ...LOCKED_DOWN,
      "GET /api/decision": () => [
        200,
        { ...healthyDecision(), regime: { label: "Risk-On", score: null, modifiers: [] } },
      ],
    },
    { strict: true },
  );
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}regime is present with a label and score/);
});

// Every other value that survives Number() as a finite number without being one.
test("strict mode rejects empty-string, boolean and array scores", async () => {
  for (const score of ["", "   ", true, []]) {
    const { code, stdout } = await runSmoke(
      {
        ...LOCKED_DOWN,
        "GET /api/decision": () => [
          200,
          {
            ...healthyDecision(),
            setups: [{ symbol: "BTCUSDT", signal: "LONG", setupScore: score, action: "Watch" }],
          },
        ],
      },
      { strict: true },
    );
    assert.equal(code, 1, `${JSON.stringify(score)} must not read as a score:\n${stdout}`);
  }
});

// A genuine numeric zero is a real score and must still pass.
test("a real zero setup score is accepted", async () => {
  const { code, stdout } = await runSmoke(
    {
      ...LOCKED_DOWN,
      "GET /api/decision": () => [
        200,
        {
          ...healthyDecision(),
          setups: [{ symbol: "BTCUSDT", signal: "SHORT", setupScore: 0, action: "Skip" }],
        },
      ],
    },
    { strict: true },
  );
  assert.equal(code, 0, stdout);
  assert.match(stdout, /PASS {2}at least one setup carries a finite setupScore/);
});

test("strict mode fails when setups are scored but carry no direction", async () => {
  const { code, stdout } = await runSmoke(
    {
      ...LOCKED_DOWN,
      "GET /api/decision": () => [
        200,
        { ...healthyDecision(), setups: [{ symbol: "BTCUSDT", setupScore: 78 }] },
      ],
    },
    { strict: true },
  );
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}scored setups carry a direction and an action/);
});

// News risk gates trading around releases, so a fallback calendar means that
// gate is scored off seed data — not a cosmetic degradation.
test("strict mode fails a fallback calendar and names the cause", async () => {
  const { code, stdout } = await runSmoke(
    { ...LOCKED_DOWN, "GET /api/decision": () => [200, degradedDecision()] },
    { strict: true },
  );
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}macro calendar is live/);
  assert.match(stdout, /request-failed/);
  assert.match(stdout, /HTTP 503/);
});

test("normal mode reports the calendar cause without failing on it", async () => {
  const { code, stdout } = await runSmoke({
    ...LOCKED_DOWN,
    "GET /api/decision": () => [200, { ...healthyDecision(), setups: degradedDecision().setups }],
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /PASS {2}macro calendar is live/);
});

// A live feed publishing bare clock labels is only as correct as the configured
// zone, and that is worth saying out loud rather than reporting a clean green.
test("a live calendar with no self-stated offsets warns about the assumed zone", async () => {
  const { code, stdout } = await runSmoke(
    {
      ...LOCKED_DOWN,
      "GET /api/decision": () => {
        const body = healthyDecision();
        body.dataQuality.calendar.timing = { total: 2, exact: 0, assumed: 2, untimed: 0 };
        return [200, body];
      },
    },
    { strict: true },
  );
  assert.equal(code, 0, stdout);
  assert.match(stdout, /WARN {2}calendar timing is all assumed/);
  assert.match(stdout, /MACRO_CALENDAR_TIMEZONE/);
});

test("a payload with no calendar block fails strict rather than passing silently", async () => {
  const { code, stdout } = await runSmoke(
    {
      ...LOCKED_DOWN,
      "GET /api/decision": () => {
        const body = healthyDecision();
        delete body.dataQuality.calendar;
        return [200, body];
      },
    },
    { strict: true },
  );
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}macro calendar is live/);
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

// A protected URL that does not exist 401s just as readily as one that does,
// so probing `/api/trading-lab/overview` proved nothing about the Trading Lab.
// The real overview handler is `router.get("/")` on the mounted router.
test("the Trading Lab probe hits the route that actually exists", async () => {
  const { seen } = await runSmoke(LOCKED_DOWN);
  assert.ok(seen.includes("GET /api/trading-lab"), `expected the mounted route, saw ${JSON.stringify(seen)}`);
  assert.ok(!seen.some((entry) => entry.includes("/api/trading-lab/overview")), "must not probe a nonexistent path");
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
