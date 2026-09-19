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

test("the Reporter queues editable local drafts without invoking a broadcast endpoint", () => {
  assert.match(html, /Queue Editable Drafts/);
  assert.match(html, /reporter:broadcast-drafts:v1/);
  assert.match(html, /localStorage\.setItem/);
  assert.match(html, /root\.style\.display = drafts\.length \? 'block' : 'none'/);
  assert.match(html, /Nothing was broadcast/);
  assert.doesNotMatch(html, /\/api\/daily-report\/broadcast/);
});

test("the local draft queue handles unsafe and unavailable browser storage", () => {
  assert.match(html, /\.replace\(\/"\/g, '&quot;'\)/);
  assert.match(html, /This browser could not save the draft/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /Remove this local draft\?/);
});
