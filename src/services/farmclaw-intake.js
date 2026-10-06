"use strict";

/**
 * FarmclawIntakeStore
 *
 * FarmClaw's own durable task list: the consumer half of the FarmClaw handoff
 * (see src/services/farmclaw-handoffs.js for the dashboard's queue half).
 *
 * The handoff contract says FarmClaw may only send a receipt once an item is
 * durably in FarmClaw's own workflow. Before this store existed FarmClaw had
 * nowhere durable to put a claimed link, so it correctly refused to
 * acknowledge anything, and the dashboard showed "queued" indefinitely.
 *
 * This store is that place. It runs on FarmClaw's side (the collector in
 * scripts/farmclaw-collector.js), never inside the dashboard, so a receipt
 * means "FarmClaw's host has the task on disk", not "the dashboard wrote a
 * second copy of its own queue".
 *
 *   open ──▶ in_progress ──▶ done
 *     └──────────┴──────────▶ dropped
 *
 * - `intake(handoff)` is idempotent on the dashboard's handoff id. A collector
 *   that crashed after writing the task but before the receipt landed gets the
 *   same handoff again when the lease expires; it then finds the existing task
 *   and re-sends the same receipt id, which the dashboard accepts.
 * - Writes are fsynced (file and directory) and then read back before
 *   `intake` returns, so the receipt is only sent for a task that verifiably
 *   reached the disk.
 *
 * File shape:
 *   { "version": 1, "tasks": [ <newest first> ] }
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock } = require("./json-file-lock");

const STORE_VERSION = 1;
const TASK_STATUSES = ["open", "in_progress", "done", "dropped"];
const MAX_HISTORY_PER_TASK = 20;
const MAX_NOTE_LEN = 500;

function clampString(value, max) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function makeError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Atomic write that is also durable: fsync the temp file, rename, fsync the directory. */
function writeJsonDurable(file, payload) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tempFile, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, file);
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw err;
  }
  // Persist the rename itself. Some platforms (Windows) can't open a
  // directory; there the rename is already as durable as it gets.
  try {
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {}
}

class FarmclawIntakeStore {
  constructor({ file, now = () => Date.now() } = {}) {
    if (!file) throw new Error("FarmclawIntakeStore needs a file path");
    this._file = file;
    this._lockState = { depth: 0 };
    this._now = now;
  }

  get file() {
    return this._file;
  }

  /**
   * Missing file is an empty store. A file that exists but can't be parsed is
   * an error, not an empty store: overwriting it would silently lose tasks.
   */
  _read() {
    let raw;
    try {
      raw = fs.readFileSync(this._file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return { tasks: [] };
      throw err;
    }
    const parsed = JSON.parse(raw);
    return { tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [] };
  }

  _write(state) {
    writeJsonDurable(this._file, { version: STORE_VERSION, tasks: state.tasks });
  }

  _withLock(operation) {
    return withExclusiveLock(this._file, this._lockState, operation, {
      busyMessage: "FarmClaw intake store is busy; retry.",
    });
  }

  _iso() {
    return new Date(this._now()).toISOString();
  }

  _push(task, event, detail = {}) {
    task.history = [{ at: task.updatedAt, event, ...detail }, ...(task.history || [])].slice(0, MAX_HISTORY_PER_TASK);
  }

  /**
   * Record a claimed handoff as a FarmClaw task. Returns `{ task, created }`.
   * Throws if the task can't be written and read back; the caller must then
   * not send a receipt.
   */
  intake(handoff = {}) {
    const handoffId = clampString(handoff.id, 200);
    if (!handoffId) throw makeError("handoff id is required", 400);

    return this._withLock(() => {
      const state = this._read();
      const existing = state.tasks.find((task) => task.handoffId === handoffId);
      if (existing) return { task: existing, created: false };

      const now = this._iso();
      const task = {
        id: `fct_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
        handoffId,
        url: handoff.url || null,
        canonicalUrl: handoff.canonicalUrl || null,
        handle: handoff.handle || null,
        text: handoff.text || null,
        status: "open",
        createdAt: now,
        updatedAt: now,
        receiptSentAt: null,
        receiptError: null,
        note: null,
        history: [],
      };
      this._push(task, "intake", { handoffId });
      state.tasks.unshift(task);
      this._write(state);

      const persisted = this._read().tasks.find((entry) => entry.id === task.id);
      if (!persisted) throw makeError("FarmClaw intake task did not persist", 500);
      return { task: persisted, created: true };
    });
  }

  /** Note the dashboard's answer to the receipt, for `tasks` listings. */
  recordReceipt(id, { ok, error } = {}) {
    return this._withLock(() => {
      const state = this._read();
      const task = state.tasks.find((entry) => entry.id === id);
      if (!task) return null;
      task.updatedAt = this._iso();
      if (ok) {
        task.receiptSentAt = task.receiptSentAt || task.updatedAt;
        task.receiptError = null;
        this._push(task, "receipt_sent");
      } else {
        task.receiptError = clampString(error, MAX_NOTE_LEN) || "receipt rejected";
        this._push(task, "receipt_error", { error: task.receiptError });
      }
      this._write(state);
      return task;
    });
  }

  /** FarmClaw working the task: move it along and optionally leave a note. */
  update(id, { status, note } = {}) {
    if (status !== undefined && !TASK_STATUSES.includes(status)) {
      throw makeError(`status must be one of ${TASK_STATUSES.join(", ")}`, 400);
    }
    return this._withLock(() => {
      const state = this._read();
      const task = state.tasks.find((entry) => entry.id === id || entry.handoffId === id);
      if (!task) return null;
      task.updatedAt = this._iso();
      const detail = {};
      if (status !== undefined && status !== task.status) {
        detail.from = task.status;
        detail.to = status;
        task.status = status;
      }
      if (note !== undefined) task.note = clampString(note, MAX_NOTE_LEN) || null;
      this._push(task, "updated", detail);
      this._write(state);
      return task;
    });
  }

  get(id) {
    return this._read().tasks.find((task) => task.id === id || task.handoffId === id) || null;
  }

  list({ status, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 50, 1000));
    return this._read().tasks.filter((task) => !status || task.status === status).slice(0, max);
  }
}

module.exports = { FarmclawIntakeStore, TASK_STATUSES };
