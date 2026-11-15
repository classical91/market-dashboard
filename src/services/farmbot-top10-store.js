"use strict";

/**
 * The receipt ("slip") for each Top 10 sent to FarmBot: which batch it
 * became, the stories in it, what was skipped and why, and the link to
 * approve it. FarmBot stays the authority on whether the batch was approved,
 * queued or posted; this records only what the dashboard sent and the reply
 * FarmBot gave at the time.
 *
 * File shape: { "version": 1, "slips": [ <newest first> ] }
 */

const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");

const MAX_SLIPS = 120;

class FarmbotTop10Store {
  constructor({ dataDir, file, logger = console } = {}) {
    this.file = file || path.join(dataDir, "farmbot-top10-slips.json");
    this.logger = logger;
    this.lockState = { depth: 0 };
  }

  _read() {
    const stored = readJsonStore(this.file, this.logger, "FarmBot Top 10 slips");
    return Array.isArray(stored?.slips) ? stored.slips : [];
  }

  record(slip, now = new Date()) {
    return withExclusiveLock(this.file, this.lockState, () => {
      const entry = {
        id: `slip-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
        recordedAt: now.toISOString(),
        ...slip,
      };
      const slips = [entry, ...this._read()].slice(0, MAX_SLIPS);
      if (!writeJsonAtomic(this.file, { version: 1, slips }, this.logger, "FarmBot Top 10 slips")) {
        const err = new Error("Could not save the FarmBot receipt; check the batch in FarmBot before sending again.");
        err.statusCode = 503;
        err.expose = true;
        throw err;
      }
      return entry;
    }, { busyMessage: "FarmBot receipts are busy; retry the request." });
  }

  /** Newest slip for a day, or null. */
  latest(date) {
    return this._read().find((slip) => slip.date === date) || null;
  }

  forDay(date) {
    return this._read().filter((slip) => slip.date === date);
  }
}

module.exports = { FarmbotTop10Store };
