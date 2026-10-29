"use strict";

/**
 * PhoneBriefingStore
 *
 * The briefings the iOS Shortcut generates with ChatGPT every couple of days,
 * pushed here so they can be read on a computer as well as on the phone.
 *
 * Deliberately separate from the Reporter Room's report store: nothing pushed
 * here is generated, spent, broadcast or routed to Telegram. The phone is the
 * newsroom; this is only the reading copy. Main Hub's reminder card already
 * says how long it has been since the Shortcut last ran.
 *
 * File shape:
 *   { "version": 1, "entries": { "<category>": [ <newest first> ] } }
 */

const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");

const STORE_VERSION = 1;
const DEFAULT_HISTORY_PER_CATEGORY = 30;
const MAX_TEXT_LEN = 50000;
const MAX_TITLE_LEN = 200;

const CATEGORIES = [
  { key: "geopolitics", label: "Geopolitics", icon: "🌍" },
  { key: "economics", label: "Economics", icon: "🏦" },
  { key: "stocks", label: "Stocks", icon: "📈" },
  { key: "crypto", label: "Crypto", icon: "₿" },
];
// The Shortcut may name a desk the way the Reporter Room or Telegram does.
const CATEGORY_ALIASES = {
  geopolitical: "geopolitics",
  economy: "economics",
  economic: "economics",
  stock: "stocks",
  markets: "stocks",
  market: "stocks",
  btc: "crypto",
  cryptocurrency: "crypto",
};

function normalizeCategory(value) {
  const key = String(value || "").trim().toLowerCase();
  const resolved = CATEGORY_ALIASES[key] || key;
  return CATEGORIES.some((category) => category.key === resolved) ? resolved : null;
}

function textHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.expose = true;
  return err;
}

class PhoneBriefingStore {
  constructor({ dataDir, file, historyPerCategory = DEFAULT_HISTORY_PER_CATEGORY, logger = console } = {}) {
    this.file = file || path.join(dataDir, "phone-briefings.json");
    this.historyPerCategory = historyPerCategory;
    this.logger = logger;
    this.lockState = { depth: 0 };
  }

  read() {
    const stored = readJsonStore(this.file, this.logger, "Phone briefings");
    const entries = {};
    CATEGORIES.forEach(({ key }) => {
      entries[key] = Array.isArray(stored?.entries?.[key]) ? stored.entries[key] : [];
    });
    return { version: STORE_VERSION, entries };
  }

  /**
   * Store one briefing. Re-sending the same text for a desk (a Shortcut retry)
   * returns the copy already stored instead of adding a duplicate run.
   */
  receive(category, { text, title } = {}, now = new Date()) {
    const key = normalizeCategory(category);
    if (!key) throw badRequest(`Unknown category "${category}". Use one of: ${CATEGORIES.map((c) => c.key).join(", ")}.`);
    const body = typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "";
    if (!body) throw badRequest("Briefing text is empty.");
    if (body.length > MAX_TEXT_LEN) throw badRequest(`Briefing text is longer than ${MAX_TEXT_LEN} characters.`);

    return withExclusiveLock(this.file, this.lockState, () => {
      const state = this.read();
      const list = state.entries[key];
      const hash = textHash(body);
      if (list[0] && list[0].hash === hash) {
        return { entry: list[0], created: false };
      }
      const entry = {
        id: `${key}-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
        category: key,
        title: typeof title === "string" && title.trim() ? title.trim().slice(0, MAX_TITLE_LEN) : null,
        text: body,
        hash,
        receivedAt: now.toISOString(),
      };
      state.entries[key] = [entry, ...list].slice(0, this.historyPerCategory);
      if (!writeJsonAtomic(this.file, state, this.logger, "Phone briefings")) {
        const err = new Error("Could not save the briefing; retry the request.");
        err.statusCode = 503;
        err.expose = true;
        throw err;
      }
      return { entry, created: true };
    }, { busyMessage: "Phone briefings are busy; retry the request." });
  }

  /** Every desk with its newest briefing and when it arrived. */
  summary() {
    const state = this.read();
    return CATEGORIES.map((category) => {
      const list = state.entries[category.key];
      return { ...category, count: list.length, latest: list[0] || null };
    });
  }

  /** One desk's runs, newest first, with or without their text. */
  history(category, { withText = false } = {}) {
    const key = normalizeCategory(category);
    if (!key) return null;
    const list = this.read().entries[key];
    return list.map((entry) => (withText ? entry : {
      id: entry.id,
      category: entry.category,
      title: entry.title,
      receivedAt: entry.receivedAt,
      chars: entry.text.length,
    }));
  }

  get(category, id) {
    const key = normalizeCategory(category);
    if (!key) return null;
    return this.read().entries[key].find((entry) => entry.id === id) || null;
  }
}

module.exports = { PhoneBriefingStore, CATEGORIES, normalizeCategory, MAX_TEXT_LEN };
