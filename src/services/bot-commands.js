const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_ENTRIES = 200;

function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Small persisted list of saved Telegram bot commands — a flat JSON file
// like the watchlist, so a command saved on one device (e.g. mobile) shows
// up on every other device instead of staying stuck in that browser's
// localStorage. No admin key: this is a personal reference list, not an
// action that spends credits or posts anywhere.
class BotCommandsService {
  constructor({ dataDir }) {
    this._file = path.join(dataDir, "bot-commands.json");
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _write(items) {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(items, null, 2), "utf8");
    } catch (err) {
      console.error("[BotCommands] Failed to write bot-commands file:", err.message);
    }
  }

  list() {
    return this._read();
  }

  // Create (no id, or an id not already present) or update (matching id).
  // Only whitelisted fields are persisted — the request body is untrusted.
  upsert(entry = {}) {
    const title = cleanString(entry.title, 120);
    const command = cleanString(entry.command, 4000);
    if (!title || !command) {
      throw Object.assign(new Error("title and command are required"), { statusCode: 400, expose: true });
    }

    const items = this._read();
    const id = cleanString(entry.id, 64) || crypto.randomUUID();
    const record = {
      id,
      title,
      purpose: cleanString(entry.purpose, 200),
      command,
      notes: cleanString(entry.notes, 2000),
      updatedAt: new Date().toISOString(),
    };

    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) items[index] = record;
    else items.unshift(record);

    this._write(items.slice(0, MAX_ENTRIES));
    return record;
  }

  remove(id) {
    const items = this._read().filter((item) => item.id !== id);
    this._write(items);
    return items;
  }
}

module.exports = { BotCommandsService };
