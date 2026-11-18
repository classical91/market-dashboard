"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const express = require("express");

const { createReporterRouter } = require("../src/routes/reporter");

test("a desk's Reporter Room runs are listed newest first, without prompt bodies", async () => {
  const seen = [];
  const reporterService = {
    sections: ["geopolitics", "economics", "markets", "crypto"],
    listGenerations: (query) => {
      seen.push(query);
      return [{ section: "geopolitics", generatedAt: "2026-11-15T01:00:00.000Z", model: "m", content: "1. A\n2. B", prompt: "secret prompt" }];
    },
  };
  const app = express();
  app.use("/api/daily-report", createReporterRouter({ reporterService, telegramService: {}, requireAdmin: (req, res, next) => next() }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/daily-report/generations?section=geopolitics&limit=500`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(seen[0], { section: "geopolitics", limit: 30 }, "limit is capped");
    assert.deepEqual(body.generations, [{ generatedAt: "2026-11-15T01:00:00.000Z", model: "m", content: "1. A\n2. B", customPrompt: true, noBriefing: false }]);
    assert.doesNotMatch(JSON.stringify(body), /secret prompt/);
    assert.equal((await fetch(`${base}/api/daily-report/generations?section=weather`)).status, 400);
    // Main Hub asks for times only: no report text, only its length.
    const meta = await (await fetch(`${base}/api/daily-report/generations?section=geopolitics&fields=meta`)).json();
    assert.deepEqual(meta.generations, [{ generatedAt: "2026-11-15T01:00:00.000Z", model: "m", chars: 9, customPrompt: true, noBriefing: false }]);
    assert.doesNotMatch(JSON.stringify(meta), /1\. A/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("every desk page has a Run button that writes its own Reporter Room section", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public/briefing.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/briefing.js"), "utf8");
  assert.match(page, /id="briefingRun"/);
  for (const helper of ["admin-key.js", "desk-prompts.js", "briefing-markdown.js"]) {
    assert.ok(page.indexOf(helper) < page.indexOf("briefing.js\"></script>"), `${helper} loads before briefing.js`);
  }
  assert.match(script, /geopolitics: "geopolitics", economics: "economics", stocks: "markets", crypto: "crypto"/);
  assert.match(script, /\/api\/daily-report\/generate\?section=/);
  assert.match(script, /\/api\/daily-report\/generations\?section=/);
  assert.doesNotMatch(script, /\/broadcast/, "Run never broadcasts");
});

test("crypto runs ask for news, not trending tokens, from both pages", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public/assets/js/desk-prompts.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  assert.match(context.window.DeskPrompts.crypto, /^\{date\}\nTOP 10 CRYPTO NEWS BRIEF/);
  assert.match(context.window.DeskPrompts.crypto, /not a list of trending tokens/);
  const top = fs.readFileSync(path.join(__dirname, "..", "public/top-news.html"), "utf8");
  assert.ok(top.indexOf("desk-prompts.js") < top.indexOf("top-news.js"));
});
