"use strict";

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const ReporterModule = require("../src/services/reporter");
const { withExclusiveLock, writeJsonAtomic } = require("../src/services/json-file-lock");

const ReporterService = ReporterModule.ReporterService || ReporterModule;

function stubCache() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  };
}

function freshReporter() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-reporter-"));
  const service = new ReporterService({ cache: stubCache(), apiKey: "", model: "test", dataDir });
  return { service, logFile: path.join(dataDir, "reporter-generation-log.json") };
}

// The log keeps one entry per section per day, so a test that wants many
// surviving entries has to vary the day key, not just the timestamp.
function entry(section, generatedAt, generatedDateKey = "2026-08-25") {
  return { section, content: `${section} body`, dateStr: "TEST", generatedAt, generatedDateKey };
}

/* ── generation log concurrency ── */

test("concurrent generation log writes keep every entry", () => {
  const { service, logFile } = freshReporter();

  // Interleave the way a fan-out cycle does: each section reads the log,
  // prepends its own entry and writes back. Without serialization the last
  // writer wins and the others vanish.
  service._logGeneration(entry("crypto", "2026-08-25T08:00:00.000Z"));
  service._logGeneration(entry("economics", "2026-08-25T08:00:01.000Z"));
  service._logGeneration(entry("markets", "2026-08-25T08:00:02.000Z"));

  const written = JSON.parse(fs.readFileSync(logFile, "utf8"));
  const sections = written.map((item) => item.section).sort();
  assert.deepEqual(sections, ["crypto", "economics", "markets"]);
});

test("a nested log update reuses the held lock instead of deadlocking", () => {
  const { service } = freshReporter();
  service._logGeneration(entry("crypto", "2026-08-25T08:00:00.000Z"));

  // Re-entrancy exists so a nested update cannot block on a lock this same
  // call stack already holds. It does not make nesting a *write* inside a
  // read-modify-write safe — the outer write still wins — so this asserts
  // only that the nested call completes.
  const result = service._updateLog((log) => {
    service._updateLog((inner) => inner);
    return log;
  });

  assert.ok(Array.isArray(result));
});

test("the generation log is capped at 100 entries, newest first", () => {
  const { service, logFile } = freshReporter();
  // One entry per day so dedupe keeps them all and the cap is what bites.
  for (let i = 0; i < 105; i += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + i));
    service._logGeneration(entry("crypto", day.toISOString(), day.toISOString().slice(0, 10)));
  }

  const written = JSON.parse(fs.readFileSync(logFile, "utf8"));
  assert.equal(written.length, 100);
  assert.equal(written[0].generatedDateKey, "2026-04-15");
});

/* ── shared lock primitives ── */

test("withExclusiveLock releases the lock file even when the operation throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-lock-"));
  const file = path.join(dir, "store.json");
  const state = { depth: 0 };

  assert.throws(() => {
    withExclusiveLock(file, state, () => {
      throw new Error("boom");
    });
  }, /boom/);

  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(state.depth, 0);
});

test("withExclusiveLock reclaims a stale lock left by a dead writer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-lock-"));
  const file = path.join(dir, "store.json");
  fs.writeFileSync(`${file}.lock`, "");
  const stale = Date.now() - 60 * 1000;
  fs.utimesSync(`${file}.lock`, stale / 1000, stale / 1000);

  const result = withExclusiveLock(file, { depth: 0 }, () => "ran");
  assert.equal(result, "ran");
});

test("withExclusiveLock reports 503 rather than proceeding unserialized", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-lock-"));
  const file = path.join(dir, "store.json");
  fs.writeFileSync(`${file}.lock`, "");

  try {
    withExclusiveLock(file, { depth: 0 }, () => "ran");
    assert.fail("expected a busy error");
  } catch (err) {
    assert.equal(err.statusCode, 503);
    assert.equal(err.expose, true);
  }
});

test("writeJsonAtomic leaves no temp files behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-atomic-"));
  const file = path.join(dir, "store.json");

  assert.equal(writeJsonAtomic(file, { ok: true }, { error() {} }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
});
