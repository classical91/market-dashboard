"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/assets/js/x-broadcast.js"), "utf8");
const url = "https://x.com/example/status/123";
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const values = new Map();
  const reads = [];
  const writes = [];
  const timers = [];
  const window = { AdminKey: {
    fetchSilent: (target) => new Promise((resolve) => reads.push({ target, resolve })),
    fetchOrSession: (target, options) => new Promise((resolve) => writes.push({ target, options, resolve })),
  } };
  const context = vm.createContext({ window, localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  vm.runInContext(source, context);
  const api = window.XBroadcast;
  values.set(api.FARMCLAW_QUEUED_KEY, JSON.stringify([url]));
  const handlers = {};
  const notes = [];
  const button = { textContent: "", title: "", isConnected: true,
    ownerDocument: { createElement: () => ({ setAttribute: () => {} }) },
    parentNode: { appendChild: (note) => notes.push(note) },
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  api.bindFarmclawButton(button, { url });
  return { api, reads, writes, timers, values, button, handlers, notes };
}
function response(body, status = 200) { return { ok: status < 400, status, text: async () => JSON.stringify(body) }; }
const received = { id: "fch_123", status: "received", receipt: { receiptId: "openclaw-run:123" } };

test("restored queued button reads latest receipt without re-submitting", async () => {
  const f = fixture();
  assert.match(f.reads[0].target, /\/lookup\?url=/);
  f.reads[0].resolve(response(received));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw received");
  assert.match(f.button.title, /broadcasting are not confirmed/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(JSON.parse(f.values.get(f.api.FARMCLAW_QUEUED_KEY)), []);
});
test("pending restored handoff resumes polling until receipt arrives", async () => {
  const f = fixture();
  f.reads[0].resolve(response({ id: "fch_123", status: "claimed" }));
  await flush();
  f.timers[0]();
  assert.equal(f.reads[1].target, "/api/farmclaw/handoffs/fch_123");
  f.reads[1].resolve(response(received));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw received");
  assert.equal(f.writes.length, 0);
});
test("stale lookup cannot overwrite a user's completed retry", async () => {
  const f = fixture();
  f.handlers.click();
  f.writes[0].resolve(response({ id: "fch_123", record: received }));
  await flush();
  f.reads[0].resolve(response({ id: "fch_123", status: "failed", error: "old failure" }));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw received");
});
test("authentication failure never prompts or retries automatically", async () => {
  const f = fixture();
  f.reads[0].resolve(response({ error: "Unauthorized" }, 401));
  await flush();
  assert.equal(f.writes.length, 0);
  assert.equal(f.timers.length, 0);
  assert.match(f.button.title, /last known/);
  assert.equal(f.button.textContent, "FarmClaw status unknown");
  assert.match(f.notes[0].textContent, /Could not refresh/);
});

test("missing delivery connection is visible on the card and still polls for recovery", async () => {
  const f = fixture();
  f.reads[0].resolve(response({ id: "fch_123", status: "pending", push: { enabled: false }, agent: { lastPollAt: null } }));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw not connected");
  assert.match(f.notes[0].textContent, /Saved on this dashboard.*delivery needs reconnecting/);
  assert.equal(f.timers.length, 1);
  f.timers[0]();
  f.reads[1].resolve(response(received));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw received");
  assert.equal(f.notes.length, 1, "updates the same visible status note");
  assert.match(f.notes[0].textContent, /does not confirm a Farm queue entry/);
  assert.equal(f.writes.length, 0);
});

test("a polling collector is waiting rather than disconnected, then shows its exact failure", async () => {
  const f = fixture();
  f.reads[0].resolve(response({ id: "fch_123", status: "pending", push: { enabled: false }, agent: { lastPollAt: new Date().toISOString() } }));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw waiting");
  assert.match(f.notes[0].textContent, /not yet picked up/);
  f.timers[0]();
  f.reads[1].resolve(response({ id: "fch_123", status: "failed", error: "OpenClaw hook HTTP 401" }));
  await flush();
  assert.equal(f.button.textContent, "FarmClaw failed");
  assert.match(f.notes[0].textContent, /HTTP 401/);
});
