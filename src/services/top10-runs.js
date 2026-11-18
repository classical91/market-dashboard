"use strict";

/**
 * Today's Top 10 exists only because someone hit Run. A Run is recorded here
 * once Economics, Stocks and Crypto each have a report from that same day, and
 * it pins the exact desk runs the Top 10 is built from. Without a recorded Run
 * for a day there is no Top 10: the page shows none, and neither logging nor
 * Send to FarmBot can build one.
 *
 * File shape: { "version": 1, "runs": [ <newest first> ] }
 */

const path = require("path");
const crypto = require("crypto");
const { withExclusiveLock, writeJsonAtomic, readJsonStore } = require("./json-file-lock");
const { select } = require("../../public/assets/js/top-news-selection");
const { buildDailyTopNews } = require("./daily-top-news");

const MAX_RUNS = 120;

function runError(message, statusCode, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  Object.assign(err, extra);
  return err;
}

class Top10RunStore {
  constructor({ dataDir, file, logger = console } = {}) {
    this.file = file || path.join(dataDir, "top10-runs.json");
    this.logger = logger;
    this.lockState = { depth: 0 };
  }

  _read() {
    const stored = readJsonStore(this.file, this.logger, "Top 10 runs");
    return Array.isArray(stored?.runs) ? stored.runs : [];
  }

  record(run, now = new Date()) {
    return withExclusiveLock(this.file, this.lockState, () => {
      const entry = {
        id: `top10-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
        createdAt: now.toISOString(),
        ...run,
      };
      const runs = [entry, ...this._read()].slice(0, MAX_RUNS);
      if (!writeJsonAtomic(this.file, { version: 1, runs }, this.logger, "Top 10 runs")) {
        throw runError("Could not save the Top 10 run; try Run again.", 503);
      }
      return entry;
    }, { busyMessage: "Top 10 runs are busy; retry the request." });
  }

  /** The newest recorded Run for a day, or null. */
  latest(date) {
    return this._read().find((run) => run.date === date) || null;
  }
}

/**
 * Record today's Run. Every desk needs a report from today with numbered
 * stories; otherwise nothing is recorded and the error names what is missing.
 * `runIds` may pick a specific run per desk (it must be one of today's).
 */
function recordTop10Run({ store, briefingStore, reporterService, timeZone, runIds = {}, now = new Date() }) {
  const day = buildDailyTopNews({ briefingStore, reporterService, timeZone, now });
  const runs = {};
  const missing = [];
  day.desks.forEach((desk) => {
    const wanted = typeof runIds[desk.key] === "string" ? runIds[desk.key] : null;
    const run = (wanted && desk.runs.find((item) => item.id === wanted)) || desk.runs[0];
    if (!run) missing.push(`${desk.label} has no report today`);
    else if (!run.stories.length) missing.push(`${desk.label}'s report today has no numbered stories`);
    else runs[desk.key] = { id: run.id, source: run.source, at: run.at, stories: run.stories.length };
  });
  if (missing.length) {
    throw runError(`No Top 10: all three desks must finish today. ${missing.join("; ")}.`, 409, { missing });
  }
  const picked = Object.fromEntries(Object.entries(runs).map(([key, run]) => [key, run.id]));
  const stories = select(day.desks, picked);
  return store.record({ date: day.date, timeZone: day.timeZone, runs, runIds: picked, stories: stories.length }, now);
}

module.exports = { Top10RunStore, recordTop10Run };
