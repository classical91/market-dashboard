"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readJsonStore, writeJsonAtomic } = require("../src/services/json-file-lock");
const { ReporterNewsLogStore } = require("../src/services/reporter-news-log");
const { FarmclawHandoffStore } = require("../src/services/farmclaw-handoffs");
const { BroadcastLedgerStore } = require("../src/services/broadcast-ledger");

const quiet = { error() {}, warn() {}, info() {}, log() {} };

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("readJsonStore returns null for a missing file and throws 503 for a corrupt one", () => {
  const dir = tmpDir("md-store-read-");
  const file = path.join(dir, "store.json");
  assert.strictEqual(readJsonStore(file, quiet), null);

  fs.writeFileSync(file, "{ not json");
  assert.throws(() => readJsonStore(file, quiet), (err) => err.statusCode === 503 && err.code === "STORE_UNREADABLE");
});

test("writeJsonAtomic still round-trips after fsync", () => {
  const file = path.join(tmpDir("md-store-write-"), "nested", "store.json");
  assert.strictEqual(writeJsonAtomic(file, { records: [1] }, quiet), true);
  assert.deepStrictEqual(readJsonStore(file, quiet), { records: [1] });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ["store.json"], "no temp file is left behind");
});

const stores = [
  {
    name: "reporter news log",
    file: "reporter-news-log.json",
    make: (dataDir) => new ReporterNewsLogStore({ dataDir, logger: quiet }),
    write: (store) => store.intake({ headline: "Headline", url: "https://example.com/a" }),
    read: (store) => store.days({}),
  },
  {
    name: "FarmClaw handoffs",
    file: "farmclaw-handoffs.json",
    make: (dataDir) => new FarmclawHandoffStore({ dataDir, logger: quiet }),
    write: (store) => store.request({ url: "https://x.com/a/status/1" }),
    read: (store) => store.get("fch_missing"),
  },
  {
    name: "broadcast ledger",
    file: "broadcast-ledger.json",
    make: (dataDir) => new BroadcastLedgerStore({ dataDir, logger: quiet }),
    read: (store) => store.getReceipt("missing"),
  },
];

for (const spec of stores) {
  test(`a corrupt ${spec.name} fails closed and is never overwritten`, () => {
    const dataDir = tmpDir("md-store-corrupt-");
    const file = path.join(dataDir, spec.file);
    fs.writeFileSync(file, "{ truncated");
    const store = spec.make(dataDir);

    assert.throws(() => spec.read(store), (err) => err.statusCode === 503);
    if (spec.write) assert.throws(() => spec.write(store), (err) => err.statusCode === 503);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{ truncated");
  });
}
