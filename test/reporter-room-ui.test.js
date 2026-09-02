"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "reporter.html"), "utf8");

test("Reporter Room shows four desks, master news, and ShareClaw controls", () => {
  for (const section of ["geopolitics", "economics", "markets", "crypto"]) {
    assert.match(html, new RegExp(`data-tab=["']${section}["']`));
  }
  assert.match(html, /Master News/);
  assert.match(html, /ShareClaw/);
  assert.match(html, /data-master-limit="5"/);
  assert.match(html, /data-master-limit="10"/);
});

test("page load remains read-only and Run Now never broadcasts", () => {
  const loadBody = html.match(/function loadReport\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(loadBody);
  assert.match(loadBody[1], /fetch\('\/api\/daily-report\?/);
  assert.doesNotMatch(loadBody[1], /\/generate/);

  const runBody = html.match(/function runNewsroomNow\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(runBody);
  assert.match(runBody[1], /\/api\/newsroom\/cycles\/run/);
  assert.match(runBody[1], /deliver: false/);
  assert.doesNotMatch(runBody[1], /\/broadcast/);
});
