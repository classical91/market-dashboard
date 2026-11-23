"use strict";

/**
 * OverviewNotesService
 *
 * The server copy of the Overview v2 "My notes" box, so notes written on one
 * device show up on the others. The browser still keeps its own copy in
 * localStorage (it renders instantly and survives being offline); this file
 * is what the devices agree on.
 *
 * Writes are optimistic: each save names the revision it was based on, and a
 * save against a stale revision is refused with 409 and the current notes, so
 * the client can merge instead of silently overwriting another device's edit.
 *
 * File shape (DATA_DIR/overview-notes.json):
 *   { "version": 1, "revision": 3, "updatedAt": "...",
 *     "folders": [{ "id": "home", "name": "Home", "text": "..." }, ...] }
 */

const path = require("path");

const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");
const { createServiceError } = require("../utils/errors");

const STORE_VERSION = 1;
const HOME_ID = "home";
const MAX_FOLDERS = 100;
const MAX_NAME = 40;
const MAX_ID = 64;
const MAX_TEXT = 200000;
const MAX_TOTAL_TEXT = 1000000;

function normalizeFolders(input) {
  if (!Array.isArray(input)) throw createServiceError("folders must be an array", 400);
  if (input.length > MAX_FOLDERS) throw createServiceError(`At most ${MAX_FOLDERS} folders`, 400);
  const seen = new Set();
  let total = 0;
  const folders = [];
  for (const raw of input) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!id || id.length > MAX_ID || seen.has(id)) throw createServiceError("Each folder needs a unique id", 400);
    const text = typeof raw.text === "string" ? raw.text : "";
    if (text.length > MAX_TEXT) throw createServiceError("A folder's notes are too long", 413);
    total += text.length;
    const name = id === HOME_ID
      ? "Home"
      : String(typeof raw.name === "string" ? raw.name : "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!name) throw createServiceError("Each folder needs a name", 400);
    seen.add(id);
    folders.push({ id, name, text });
  }
  if (total > MAX_TOTAL_TEXT) throw createServiceError("Notes are too long", 413);
  if (!seen.has(HOME_ID)) folders.unshift({ id: HOME_ID, name: "Home", text: "" });
  return folders;
}

class OverviewNotesService {
  constructor({ dataDir, logger = console }) {
    this._file = path.join(dataDir, "overview-notes.json");
    this._logger = logger;
    this._lockState = { depth: 0 };
  }

  _read() {
    const stored = readJsonStore(this._file, this._logger, "[OverviewNotes]");
    if (!stored || !Array.isArray(stored.folders)) return { revision: 0, updatedAt: null, folders: null };
    return {
      revision: Number.isInteger(stored.revision) ? stored.revision : 0,
      updatedAt: stored.updatedAt || null,
      folders: stored.folders,
    };
  }

  get() {
    return this._read();
  }

  save({ baseRevision, folders }) {
    const normalized = normalizeFolders(folders);
    return withExclusiveLock(this._file, this._lockState, () => {
      const current = this._read();
      if (baseRevision !== current.revision) {
        const conflict = createServiceError("Notes changed on another device", 409);
        conflict.current = current;
        throw conflict;
      }
      const next = { revision: current.revision + 1, updatedAt: new Date().toISOString(), folders: normalized };
      if (!writeJsonAtomic(this._file, { version: STORE_VERSION, ...next }, this._logger, "[OverviewNotes]")) {
        throw createServiceError("Could not save notes on the server", 500);
      }
      return next;
    }, { busyMessage: "Notes are being saved; retry." });
  }
}

module.exports = { OverviewNotesService, normalizeFolders };
