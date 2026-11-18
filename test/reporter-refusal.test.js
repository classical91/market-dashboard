"use strict";

// A desk that answers "I'm sorry, I can't produce this without live results"
// used to be saved as the day's report and hold the desk's daily slot, so the
// refusal stayed up until tomorrow. These pin the fix: every generation is
// made to search, a refusal is asked again once, and a repeated refusal fails
// without saving anything.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { ReporterService, looksLikeRefusal } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");

const REFUSAL =
  "I’m sorry, but I can’t reliably produce a verified “last 24–48 hours” global economics brief " +
  "without live web results. If you want, I can still do one of these: 1. Try again with a narrower scope";

const BRIEFING = "**#1 United States — Fed holds rates**\n- Held at the November meeting";

function cited(text) {
  return {
    output_text: text,
    output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://example.com/fed", title: "Fed" }] }] }],
  };
}

function uncited(text) {
  return { output_text: text, output: [] };
}

function reporter(responses) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-refusal-"));
  const service = new ReporterService({
    cache: new PersistentReporterCache(path.join(dataDir, "reporter-cache.json")),
    apiKey: "test-key",
    model: "test-model",
    dataDir,
  });
  const requests = [];
  service._client = {
    responses: {
      create: async (request) => {
        requests.push({ ...request });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { service, requests, responses };
}

test("looksLikeRefusal flags apologies and empty output, not briefings", () => {
  assert.strictEqual(looksLikeRefusal(REFUSAL, []), true);
  assert.strictEqual(looksLikeRefusal("", []), true);
  assert.strictEqual(looksLikeRefusal("I cannot verify this date.", []), true);
  assert.strictEqual(looksLikeRefusal(BRIEFING, []), false);
  // A cited answer used the search, whatever its opening says.
  assert.strictEqual(looksLikeRefusal("I'm sorry to report the PMI fell.", [{ url: "https://x" }]), false);
});

test("every generation forces a web search and states today's date", async () => {
  const { service, requests } = reporter([cited(BRIEFING)]);
  const report = await service.generateReport(undefined, "economics");
  assert.strictEqual(report.economics, BRIEFING);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].tool_choice, "required");
  assert.deepStrictEqual(requests[0].tools, [{ type: "web_search" }]);
  assert.match(requests[0].instructions, /real current date/);
});

test("a refusal is retried once and the retry's briefing is saved", async () => {
  const { service, requests } = reporter([uncited(REFUSAL), cited(BRIEFING)]);
  const report = await service.generateReport(undefined, "economics");
  assert.strictEqual(requests.length, 2);
  assert.match(requests[1].input, /returned no briefing/);
  assert.strictEqual(report.economics, BRIEFING);
  assert.strictEqual(report.generationLog.length, 1);
  assert.strictEqual(report.generationLog[0].content, BRIEFING);
});

test("a repeated refusal fails, saves nothing, and leaves the desk runnable today", async () => {
  const { service, responses } = reporter([uncited(REFUSAL), uncited(REFUSAL)]);
  await assert.rejects(service.generateReport(undefined, "economics"), (err) => {
    assert.strictEqual(err.status, 502);
    assert.strictEqual(err.expose, true);
    assert.strictEqual(err.code, "unusable_generation");
    return true;
  });
  const peek = service.peekReport();
  assert.strictEqual(peek.economics, undefined);
  assert.deepStrictEqual(peek.generationLog, []);

  responses.push(cited(BRIEFING));
  const report = await service.generateReport(undefined, "economics");
  assert.strictEqual(report.generationSkipped, undefined);
  assert.strictEqual(report.economics, BRIEFING);
});

test("a model that rejects a forced tool call is asked again without one", async () => {
  const rejected = Object.assign(new Error("Unsupported value: 'tool_choice' does not support 'required'"), { status: 400 });
  const { service, requests } = reporter([rejected, cited(BRIEFING), cited(BRIEFING)]);
  const report = await service.generateReport(undefined, "economics");
  assert.strictEqual(report.economics, BRIEFING);
  assert.strictEqual(requests[0].tool_choice, "required");
  assert.strictEqual(requests[1].tool_choice, undefined);
  await service.generateReport(undefined, "markets");
  assert.strictEqual(requests[2].tool_choice, undefined);
});
