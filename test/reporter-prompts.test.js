"use strict";

// The desk prompts read livelier now, but two things must not drift: every
// desk asks for the bold "**#N … — …**" heading that the desk pages and
// Today's Top 10 split stories on, and the shared house style travels with
// every generation, custom prompts included.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { ReporterService, REPORT_SECTIONS } = require("../src/services/reporter");
const { PersistentReporterCache } = require("../src/services/persistent-cache");

function reporter() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-prompts-"));
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
        requests.push(request);
        return { output_text: "**#1 Test — A**\n- a\n\n**#2 Test — B**\n- b", output: [] };
      },
    },
  };
  return { service, requests };
}

for (const section of REPORT_SECTIONS) {
  test(`the ${section} desk asks for ten parseable stories and a lead line`, async () => {
    const { service, requests } = reporter();
    await service.generateReport(undefined, section);
    const { input, instructions } = requests[0];
    assert.match(input, /exactly 10 items/);
    assert.match(input, /^\*\*#\[N\] \[EMOJI\] .+ — .+\*\*$/m);
    assert.match(input, /Open with one line before #1/);
    assert.match(instructions, /House style/);
    assert.match(instructions, /under 3,500 characters/);
  });
}

test("a custom prompt gets the house style but keeps its own format", async () => {
  const { service, requests } = reporter();
  await service.generateReport(undefined, "crypto", "List three things.");
  assert.match(requests[0].input, /List three things\.$/);
  assert.match(requests[0].instructions, /the request wins/);
});
