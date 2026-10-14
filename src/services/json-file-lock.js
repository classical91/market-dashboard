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

// Directory fsync is best-effort: some platforms (Windows) and filesystems
// refuse to open or sync a directory, and the rename has already happened.
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Not supported here; nothing more we can do.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Read and parse a JSON store file, failing closed.
 *
 * Returns null only when the file does not exist yet (a fresh store). Any
 * other read error, or a file that is not valid JSON, throws a 503 instead of
 * reading as an empty store: an empty read would report receipts and
 * approvals as missing, and the next write would overwrite the unreadable
 * file with that empty state, destroying what was in it.
 */
function readJsonStore(file, logger = console, label = "") {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw unreadableStoreError(file, err, logger, label);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw unreadableStoreError(file, err, logger, label);
  }
}

function unreadableStoreError(file, cause, logger, label) {
  const name = path.basename(file);
  logger.error?.(`${label ? `${label} ` : ""}Could not read ${name}:`, cause.message);
  const err = new Error(`${name} is unreadable; refusing to treat it as empty. Restore or repair the file.`);
  err.statusCode = 503;
  err.expose = true;
  err.code = "STORE_UNREADABLE";
  return err;
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
    // fsync the temp file before the rename and the directory after it, so a
    // power loss or container kill cannot leave the rename durable but the
    // bytes behind it empty, or lose the rename itself.
    const fd = fs.openSync(tempFile, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, file);
    tempFile = null;
    fsyncDir(path.dirname(file));
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
  readJsonStore,
  WRITE_LOCK_WAIT_MS,
  WRITE_LOCK_STALE_MS,
};
