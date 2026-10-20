"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { XBroadcastChannelStore } = require("../src/services/x-broadcast-channel-store");
const { resolveBroadcastChannels } = require("../src/services/x-broadcast-channels");

const envChannels = resolveBroadcastChannels({ chatIds: ["-1001841650798:6297"] });
const quiet = { error() {} };

function store() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-xbc-store-"));
  return { dataDir, store: new XBroadcastChannelStore({ dataDir, envChannels, logger: quiet }) };
}

test("nothing saved serves the environment's channels", () => {
  const { store: s } = store();
  assert.deepEqual(s.list(), envChannels);
  assert.equal(s.snapshot().source, "env");
});

test("an empty saved list means no channels, not the environment", () => {
  const { store: s } = store();
  const snapshot = s.save([]);
  assert.equal(snapshot.source, "saved");
  assert.deepEqual(s.list(), []);
});

test("a relabelled channel keeps its id, so a remembered tick survives", () => {
  const { store: s } = store();
  s.save([{ label: "Market Desk", chatId: "-1001841650798", threadId: "6297" }]);
  assert.equal(s.list()[0].id, envChannels[0].id);
  assert.equal(s.list()[0].label, "Market Desk");
});

test("an unreadable file falls back to the environment and says so", () => {
  const { dataDir, store: s } = store();
  fs.writeFileSync(path.join(dataDir, "x-broadcast-channels.json"), "{not json");
  assert.deepEqual(s.list(), envChannels);
  assert.equal(s.snapshot().status.state, "corrupt");
  s.save([{ chatId: "@marketdesk" }]);
  assert.equal(s.list()[0].chatId, "@marketdesk", "the next save replaces it");
});

test("reset hands control back to the environment", () => {
  const { store: s } = store();
  s.save([{ chatId: "-100123" }]);
  assert.equal(s.reset().source, "env");
  assert.deepEqual(s.list(), envChannels);
});
