const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// The feedback loop that turns the decision engine from a market map into a
// trading assistant: every logged signal records what the engine said at the
// time (setup score, regime, plan levels), and the trader later grades the
// outcome — was the regime read right, did the pattern work, was news risk
// missed? Flat JSON file like the watchlist: entries live until removed.

const MAX_ENTRIES = 400;
const RESULTS = ["win", "loss", "breakeven", "skipped"];

function toBool(value) {
  return value === true || value === "true";
}

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

class TradeJournalService {
  constructor({ dataDir }) {
    this._file = path.join(dataDir, "trade-journal.json");
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
      console.error("[TradeJournal] Failed to write journal file:", err.message);
    }
  }

  list() {
    return this._read();
  }

  // Snapshot a signal as the engine scored it. Only whitelisted fields are
  // persisted — the request body is untrusted.
  log(entry = {}) {
    const symbol = cleanString(entry.symbol, 20).toUpperCase();
    const signal = cleanString(entry.signal, 10).toUpperCase();
    if (!symbol || (signal !== "LONG" && signal !== "SHORT")) {
      throw Object.assign(new Error("symbol and a LONG/SHORT signal are required"), { statusCode: 400, expose: true });
    }

    const plan = entry.plan && typeof entry.plan === "object" ? entry.plan : {};
    const item = {
      id: crypto.randomUUID(),
      loggedAt: new Date().toISOString(),
      symbol,
      interval: cleanString(entry.interval, 6) || "4h",
      signal,
      price: cleanNumber(entry.price),
      setupScore: cleanNumber(entry.setupScore),
      screenerScore: cleanNumber(entry.screenerScore),
      regimeLabel: cleanString(entry.regimeLabel, 20),
      regimeScore: cleanNumber(entry.regimeScore),
      newsRisk: cleanString(entry.newsRisk, 10),
      plan: {
        trigger: cleanNumber(plan.trigger),
        invalidation: cleanNumber(plan.invalidation),
        target: cleanNumber(plan.target),
        riskReward: cleanNumber(plan.riskReward),
        riskLabel: cleanString(plan.riskLabel, 10),
      },
      notes: cleanString(entry.notes, 500),
      taken: null,
      result: null,
      exitPrice: null,
      regimeCorrect: null,
      patternCorrect: null,
      newsRiskMissed: null,
      closedAt: null,
    };

    const items = this._read();
    items.unshift(item);
    this._write(items.slice(0, MAX_ENTRIES));
    return item;
  }

  // Grade an entry after the fact. Only review fields are patchable — the
  // original signal snapshot is immutable.
  update(id, patch = {}) {
    const items = this._read();
    const item = items.find((row) => row.id === id);
    if (!item) {
      throw Object.assign(new Error("Journal entry not found"), { statusCode: 404, expose: true });
    }

    if ("taken" in patch) item.taken = patch.taken == null ? null : toBool(patch.taken);
    if ("result" in patch) {
      const result = cleanString(patch.result, 12).toLowerCase();
      if (result && !RESULTS.includes(result)) {
        throw Object.assign(new Error(`result must be one of: ${RESULTS.join(", ")}`), { statusCode: 400, expose: true });
      }
      item.result = result || null;
      item.closedAt = result ? item.closedAt || new Date().toISOString() : null;
    }
    if ("exitPrice" in patch) item.exitPrice = cleanNumber(patch.exitPrice);
    if ("regimeCorrect" in patch) item.regimeCorrect = patch.regimeCorrect == null ? null : toBool(patch.regimeCorrect);
    if ("patternCorrect" in patch) item.patternCorrect = patch.patternCorrect == null ? null : toBool(patch.patternCorrect);
    if ("newsRiskMissed" in patch) item.newsRiskMissed = patch.newsRiskMissed == null ? null : toBool(patch.newsRiskMissed);
    if ("notes" in patch) item.notes = cleanString(patch.notes, 500);
    item.updatedAt = new Date().toISOString();

    this._write(items);
    return item;
  }

  remove(id) {
    const items = this._read();
    const remaining = items.filter((row) => row.id !== id);
    if (remaining.length === items.length) {
      throw Object.assign(new Error("Journal entry not found"), { statusCode: 404, expose: true });
    }
    this._write(remaining);
    return remaining;
  }

  // Aggregate the feedback loop: is the engine's scoring actually predictive?
  stats() {
    const items = this._read();
    const taken = items.filter((row) => row.taken === true);
    const graded = items.filter((row) => row.result === "win" || row.result === "loss" || row.result === "breakeven");
    const wins = graded.filter((row) => row.result === "win");
    const losses = graded.filter((row) => row.result === "loss");
    const decisive = wins.length + losses.length;

    const avgScore = (rows) => {
      const scores = rows.map((row) => Number(row.setupScore)).filter(Number.isFinite);
      return scores.length ? Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length) : null;
    };
    const reviewAccuracy = (field) => {
      const reviewed = items.filter((row) => row[field] === true || row[field] === false);
      if (!reviewed.length) return null;
      return Math.round((reviewed.filter((row) => row[field] === true).length / reviewed.length) * 100);
    };

    return {
      total: items.length,
      taken: taken.length,
      graded: graded.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: graded.length - decisive,
      winRate: decisive ? Math.round((wins.length / decisive) * 100) : null,
      avgSetupScoreWins: avgScore(wins),
      avgSetupScoreLosses: avgScore(losses),
      regimeAccuracy: reviewAccuracy("regimeCorrect"),
      patternAccuracy: reviewAccuracy("patternCorrect"),
      newsRiskMissed: items.filter((row) => row.newsRiskMissed === true).length,
    };
  }
}

module.exports = { TradeJournalService };
