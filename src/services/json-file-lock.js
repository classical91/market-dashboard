const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Both waits are deliberately short. A request that cannot get the lock in a
// quarter second is better off failing loudly than queueing behind a writer
// that may itself be wedged, and a lock file older than the stale window
// belongs to a process that died mid-write rather than one still working.
const WRITE_LOCK_WAIT_MS = 250;
const WRITE_LOCK_STALE_MS = 30 * 1000;
// Atomics.wait needs a SharedArrayBuffer view to park on. Nothing ever writes
// to this array; it exists purely as a way to sleep synchronously without
// spinning the CPU between lock attempts.
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run `operation` while holding an exclusive lock on `file`.
 *
 * The lock is a sibling `<file>.lock` created with the `wx` flag, so the
 * create-or-fail is the atomic step rather than an exists-then-create pair
 * that two processes could both win. Callers pass a mutable `state` object so
 * a re-entrant call from inside the operation reuses the lock it already
 * holds instead of deadlocking against itself.
 *
 * Throws a 503-shaped error when the lock cannot be taken in time, which is
 * the honest answer for a caller that must not proceed unserialized.
 */
function withExclusiveLock(file, state, operation, { busyMessage } = {}) {
  if (state.depth) return operation();

  ensureDir(file);
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > WRITE_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statErr) {
        // The holder released it between the open and the stat: retry rather
        // than treating the missing file as an error.
        if (statErr.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) {
        const busy = new Error(busyMessage || "File is busy; retry the request.");
        busy.statusCode = 503;
        busy.expose = true;
        throw busy;
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, 5);
    }
  }

  state.depth += 1;
  try {
    return operation();
  } finally {
    state.depth -= 1;
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

/**
 * Write JSON to `file` via a uniquely named temp file and a rename, so a
 * reader never observes a half-written document and a crash mid-write leaves
 * the previous version intact. The pid and random suffix keep two concurrent
 * writers from colliding on the same temp path.
 *
 * Returns true on success; write failures are logged and reported rather than
 * thrown, matching how the existing stores treat a failed persist.
 */
function writeJsonAtomic(file, payload, logger = console, label = "") {
  let tempFile = null;
  try {
    ensureDir(file);
    tempFile = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tempFile, file);
    tempFile = null;
    return true;
  } catch (err) {
    logger.error?.(`${label ? `${label} ` : ""}Failed to write ${path.basename(file)}:`, err.message);
    return false;
  } finally {
    if (tempFile) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}

module.exports = {
  withExclusiveLock,
  writeJsonAtomic,
  WRITE_LOCK_WAIT_MS,
  WRITE_LOCK_STALE_MS,
};
