"use strict";

// Paper trading engine, ported from TraderClaw's paper_trader.py.
//
// Simulates execution against real price feeds: tracks positions, realized and
// unrealized P&L, and account equity without touching real funds.
//
// Positions model a real TP1/TP2 scale-out:
//
//     initialSize → TP1 closes `tp1CloseFraction` of it and realizes that P&L
//                 → stop moves to breakeven on the remainder
//                 → TP2 (or the stop) closes remainingSize
//
// Every partial exit is recorded in `position.exits`, and the archived trade
// carries the summed realized P&L, so expectancy and R-multiples describe the
// strategy that actually ran rather than an idealized single-exit version.
//
// A `book` names an isolated set of positions/history/account — Main, Shadow
// and Alts are books, not separate services.

const fs = require("fs");
const path = require("path");

const { getTradingConfig } = require("./config");
const { calculateTradeMetrics } = require("./metrics");
const { round } = require("./round");
const { resolveDataDir } = require("../../utils/data-dir");

// Sizes below this are treated as fully closed — float residue from a
// fractional scale-out must not leave a dust position open forever.
const DUST_SIZE = 1e-9;

function nowIso() {
  return new Date().toISOString();
}

function isoFrom(value) {
  if (value === undefined || value === null) return nowIso();
  if (value instanceof Date) return value.toISOString();
  if (Number.isFinite(Number(value))) return new Date(Number(value)).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
}

function msFrom(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// ISO year-week, e.g. "2026-W07". Weeks roll over on Monday, matching the
// Python side's isocalendar() so weekly loss limits reset at the same instant.
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday decides the ISO year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

class PaperTradingService {
  constructor({ dataDir = resolveDataDir(), book = "main", config = getTradingConfig(), priceFeed = null } = {}) {
    this.book = String(book).replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "main";
    this.config = config;
    this.priceFeed = priceFeed;
    this.dir = path.join(dataDir, "trading-lab", this.book);
    this.positionsFile = path.join(this.dir, "positions.json");
    this.accountFile = path.join(this.dir, "account.json");
    this.historyFile = path.join(this.dir, "history.json");
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  load(file, fallback) {
    try {
      const content = fs.readFileSync(file, "utf8").trim();
      if (!content) return fallback;
      return JSON.parse(content);
    } catch {
      // Missing or corrupted file — fall back and let the next save fix it.
      return fallback;
    }
  }

  save(file, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    // Write-then-rename so a crash mid-write cannot leave a half-written
    // ledger behind.
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  // ── Account ───────────────────────────────────────────────────────────────

  newAccount() {
    const balance = this.config.accountSize;
    return {
      book: this.book,
      balance,
      startingBalance: balance,
      realizedPnl: 0,
      dailyPnl: 0,
      weeklyPnl: 0,
      dailyDate: utcDay(),
      weekStart: isoWeek(),
      totalTrades: 0,
      wins: 0,
      losses: 0,
      consecutiveLosses: 0,
      created: nowIso(),
      lastUpdated: nowIso(),
    };
  }

  // Zero the daily/weekly P&L buckets when the UTC day or ISO week has turned
  // over. Without this a loss from weeks ago keeps feeding today's kill
  // switches. Returns true when anything was reset.
  applyRollover(account) {
    let changed = false;
    const day = utcDay();
    const week = isoWeek();

    if (account.dailyDate !== day) {
      account.dailyPnl = 0;
      account.dailyDate = day;
      changed = true;
    }
    if (account.weekStart !== week) {
      account.weeklyPnl = 0;
      account.weekStart = week;
      changed = true;
    }
    return changed;
  }

  getAccount() {
    const stored = this.load(this.accountFile, null);
    if (!stored) {
      const account = this.newAccount();
      this.save(this.accountFile, account);
      return account;
    }

    // Backfill fields added after the account file was first written.
    const account = { ...this.newAccount(), ...stored };
    if (this.applyRollover(account)) this.saveAccount(account);
    return account;
  }

  saveAccount(account) {
    account.lastUpdated = nowIso();
    this.save(this.accountFile, account);
    return account;
  }

  // ── Positions ─────────────────────────────────────────────────────────────

  // Bring pre-scale-out positions up to the current schema.
  static migratePosition(pos) {
    if (pos.remainingSize === undefined) {
      const size = Number(pos.size) || 0;
      pos.initialSize = size;
      pos.remainingSize = size;
    }
    if (pos.initialSize === undefined) pos.initialSize = pos.remainingSize;
    if (!Array.isArray(pos.exits)) pos.exits = [];
    if (pos.realizedPnl === undefined) pos.realizedPnl = 0;
    return pos;
  }

  getPositions() {
    return this.load(this.positionsFile, []).map((p) => PaperTradingService.migratePosition(p));
  }

  savePositions(positions) {
    this.save(this.positionsFile, positions);
  }

  getOpenPositions() {
    return this.getPositions().filter((p) => p.status === "open");
  }

  getHistory() {
    return this.load(this.historyFile, []);
  }

  addToHistory(trade) {
    const history = this.getHistory();
    history.push(trade);
    this.save(this.historyFile, history);
  }

  // ── Opening ───────────────────────────────────────────────────────────────

  openPosition({
    symbol,
    direction,
    size,
    entryPrice,
    stopLoss,
    tp1,
    tp2,
    riskUsd,
    confidenceScore = null,
    signalSource = "manual",
    meta = {},
    openedAt = null,
  }) {
    if (direction !== "LONG" && direction !== "SHORT") {
      throw Object.assign(new Error("direction must be LONG or SHORT"), { statusCode: 400, expose: true });
    }
    if (!(size > 0) || !(entryPrice > 0)) {
      throw Object.assign(new Error("size and entryPrice must be positive"), { statusCode: 400, expose: true });
    }

    const positions = this.getPositions();
    if (positions.filter((p) => p.status === "open").length >= this.config.maxOpenPositions) {
      throw Object.assign(new Error(`Max open positions (${this.config.maxOpenPositions}) reached`), {
        statusCode: 409,
        expose: true,
      });
    }

    const filledEntryPrice = this.slippageAdjustedPrice(direction, entryPrice, "entry");
    const entryFee = this.executionFee(filledEntryPrice, size);
    if (entryFee) this.creditAccount(-entryFee);

    const position = {
      id: `PT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      book: this.book,
      symbol,
      direction,
      size, // remaining size, kept under this name for dashboard compatibility
      initialSize: size,
      remainingSize: size,
      entryPrice: filledEntryPrice,
      requestedEntryPrice: entryPrice,
      currentPrice: filledEntryPrice,
      stopLoss,
      tp1,
      tp2,
      tp1Hit: false,
      tp2Hit: false,
      riskUsd,
      unrealizedPnl: 0,
      realizedPnl: -entryFee,
      costs: {
        entryFee,
        exitFees: 0,
        funding: 0,
        slippageRate: Number(this.config.slippageRate) || 0,
      },
      exits: [],
      confidenceScore,
      signalSource,
      meta,
      status: "open",
      openedAt: isoFrom(openedAt),
      closedAt: null,
      closeReason: null,
    };

    positions.push(position);
    this.savePositions(positions);
    return position;
  }

  // ── Exits ─────────────────────────────────────────────────────────────────

  static pnlFor(pos, exitPrice, size) {
    return pos.direction === "LONG"
      ? (exitPrice - pos.entryPrice) * size
      : (pos.entryPrice - exitPrice) * size;
  }

  executionFee(price, size) {
    return round(Math.abs(price * size) * (Number(this.config.takerFeeRate) || 0));
  }

  slippageAdjustedPrice(direction, price, phase) {
    const rate = Number(this.config.slippageRate) || 0;
    if (!rate) return price;
    const buying = (direction === "LONG" && phase === "entry") || (direction === "SHORT" && phase === "exit");
    return round(price * (buying ? 1 + rate : 1 - rate), 10);
  }

  fundingCost(pos, size, at) {
    const rate = Number(this.config.fundingRate8h) || 0;
    if (!rate) return 0;
    const elapsedMs = Math.max(0, msFrom(at || nowIso()) - msFrom(pos.openedAt));
    const periods = elapsedMs / (8 * 60 * 60 * 1000);
    const notional = Math.abs(pos.entryPrice * size);
    const directionalCost = notional * rate * periods * (pos.direction === "LONG" ? 1 : -1);
    return round(directionalCost);
  }

  // Apply realized P&L to the account, rolling the daily/weekly buckets first.
  creditAccount(pnl) {
    const account = this.getAccount();
    account.balance = round(account.balance + pnl);
    account.realizedPnl = round(account.realizedPnl + pnl);
    account.dailyPnl = round(account.dailyPnl + pnl);
    account.weeklyPnl = round(account.weeklyPnl + pnl);
    return this.saveAccount(account);
  }

  // Realize P&L on `size` units and bank it. Does not decide whether the
  // position is finished — see closePosition / partialClose.
  recordExit(pos, exitPrice, size, reason, { at = null } = {}) {
    const fillPrice = this.slippageAdjustedPrice(pos.direction, exitPrice, "exit");
    const grossPnl = round(PaperTradingService.pnlFor(pos, fillPrice, size));
    const exitFee = this.executionFee(fillPrice, size);
    const funding = this.fundingCost(pos, size, at || nowIso());
    const pnl = round(grossPnl - exitFee - funding);
    pos.remainingSize = Math.max(0, round(pos.remainingSize - size, 10));
    pos.size = pos.remainingSize;
    pos.realizedPnl = round((pos.realizedPnl || 0) + pnl);
    pos.currentPrice = fillPrice;
    pos.costs = pos.costs || { entryFee: 0, exitFees: 0, funding: 0, slippageRate: Number(this.config.slippageRate) || 0 };
    pos.costs.exitFees = round((pos.costs.exitFees || 0) + exitFee);
    pos.costs.funding = round((pos.costs.funding || 0) + funding);
    pos.exits.push({
      reason,
      requestedPrice: exitPrice,
      price: fillPrice,
      size: round(size, 10),
      grossPnl,
      fee: exitFee,
      funding,
      pnl,
      at: isoFrom(at),
    });
    this.creditAccount(pnl);
    return pnl;
  }

  // Close `fraction` of the *initial* size and keep the position open.
  partialClose(pos, exitPrice, fraction, reason, opts = {}) {
    const size = Math.min(pos.remainingSize, pos.initialSize * fraction);
    if (size <= DUST_SIZE) return 0;
    return this.recordExit(pos, exitPrice, size, reason, opts);
  }

  // Close the remaining size and finalize the trade.
  finalizePosition(pos, exitPrice, reason, opts = {}) {
    if (pos.remainingSize > DUST_SIZE) {
      this.recordExit(pos, exitPrice, pos.remainingSize, reason, opts);
    }

    const totalPnl = round(pos.realizedPnl || 0);
    const rMultiple = pos.riskUsd ? round(totalPnl / pos.riskUsd) : 0;

    pos.status = "closed";
    pos.remainingSize = 0;
    pos.size = 0;
    pos.unrealizedPnl = 0;
    pos.closedAt = nowIso();
    pos.closeReason = reason;
    pos.exitPrice = pos.exits.length ? pos.exits[pos.exits.length - 1].price : exitPrice;
    pos.requestedExitPrice = exitPrice;
    pos.rMultiple = rMultiple;

    // Win/loss is counted once per trade, on total realized P&L across every
    // exit — not once per partial fill.
    const account = this.getAccount();
    account.totalTrades += 1;
    if (totalPnl > 0) {
      account.wins += 1;
      account.consecutiveLosses = 0;
    } else {
      account.losses += 1;
      account.consecutiveLosses += 1;
    }
    this.saveAccount(account);

    this.addToHistory({ ...pos, pnl: totalPnl, rMultiple });
    return pos;
  }

  static targetReached(pos, price, target) {
    if (!target) return false;
    return pos.direction === "LONG" ? price >= target : price <= target;
  }

  static stopReached(pos, price) {
    if (!pos.stopLoss) return false;
    return pos.direction === "LONG" ? price <= pos.stopLoss : price >= pos.stopLoss;
  }

  // Fill a stop at the worse of the stop level and the observed price. Prices
  // gap; assuming a stop always fills exactly at its level would flatter the
  // results. Targets, by contrast, fill at the target itself, so a favourable
  // overshoot is never credited.
  static stopFillPrice(pos, price) {
    return pos.direction === "LONG" ? Math.min(pos.stopLoss, price) : Math.max(pos.stopLoss, price);
  }

  async resolvePrice(symbol, prices) {
    if (prices && Number.isFinite(Number(prices[symbol]))) return Number(prices[symbol]);
    if (!this.priceFeed) return 0;
    try {
      return Number(await this.priceFeed(symbol)) || 0;
    } catch {
      return 0;
    }
  }

  // Mark every open position to market and fire any SL/TP that the new price
  // reaches. `prices` is an optional { symbol: price } override used by tests
  // and backtests; anything not covered falls through to the price feed.
  //
  // `only` restricts the pass to the named symbols. Bar replay needs this:
  // replaying one symbol's candles must not drag every *other* open symbol
  // along at the live ticker, which would both fill them at a price from the
  // wrong moment and re-hit the ticker endpoint once per replayed price.
  async updatePositions(prices = null, { only = null, at = null } = {}) {
    const positions = this.getPositions();
    const events = [];
    const cache = {};
    const wanted = only ? new Set(only) : null;

    for (const pos of positions) {
      if (pos.status !== "open") continue;

      const symbol = pos.symbol || "BTCUSDT";
      if (wanted && !wanted.has(symbol)) continue;
      if (cache[symbol] === undefined) cache[symbol] = await this.resolvePrice(symbol, prices);
      const price = cache[symbol];
      if (!price || price <= 0) continue;

      pos.currentPrice = price;
      pos.unrealizedPnl = round(PaperTradingService.pnlFor(pos, price, pos.remainingSize));

      // ── TP1: take partial profit, then protect the rest ──────────────────
      if (!pos.tp1Hit && PaperTradingService.targetReached(pos, price, pos.tp1)) {
        pos.tp1Hit = true;
        const realized = this.partialClose(pos, pos.tp1, this.config.tp1CloseFraction, "TP1_PARTIAL", { at });
        if (this.config.moveStopToBreakevenAtTp1) pos.stopLoss = pos.entryPrice;
        pos.unrealizedPnl = round(PaperTradingService.pnlFor(pos, price, pos.remainingSize));
        events.push({ type: "TP1_HIT", positionId: pos.id, symbol, realized });
      }

      // ── TP2: close the remainder ─────────────────────────────────────────
      if (pos.status === "open" && !pos.tp2Hit && PaperTradingService.targetReached(pos, price, pos.tp2)) {
        pos.tp2Hit = true;
        this.finalizePosition(pos, pos.tp2, "TP2", { at });
        events.push({ type: "TP2_HIT", positionId: pos.id, symbol, realized: pos.realizedPnl });
        continue;
      }

      // ── Stop loss ────────────────────────────────────────────────────────
      if (pos.status === "open" && PaperTradingService.stopReached(pos, price)) {
        // After TP1 the stop sits at breakeven, so label it for what it is.
        const reason = pos.tp1Hit ? "TRAILING_STOP" : "STOP_LOSS";
        this.finalizePosition(pos, PaperTradingService.stopFillPrice(pos, price), reason, { at });
        events.push({ type: "STOP_HIT", positionId: pos.id, symbol, reason, realized: pos.realizedPnl });
      }
    }

    this.savePositions(positions);
    return events;
  }

  async closePosition(positionId, { reason = "MANUAL", exitPrice = null } = {}) {
    const positions = this.getPositions();
    const pos = positions.find((p) => p.id === positionId && p.status === "open");
    if (!pos) return null;

    const price = exitPrice || (await this.resolvePrice(pos.symbol || "BTCUSDT", null));
    if (!price || price <= 0) return null;

    this.finalizePosition(pos, price, reason, { at: nowIso() });
    this.savePositions(positions);
    return pos;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    await this.updatePositions();
    const account = this.getAccount();
    const history = this.getHistory();
    const open = this.getOpenPositions();

    const total = account.totalTrades;
    const winRate = total > 0 ? round((account.wins / total) * 100, 1) : 0;

    const realized = history.map((t) => Number(t.realizedPnl) || 0);
    const winning = realized.filter((p) => p > 0);
    const losing = realized.filter((p) => p < 0);

    const unrealized = round(open.reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0));
    const equity = round(account.balance + unrealized);
    const starting = account.startingBalance || 1;

    return {
      book: this.book,
      balance: account.balance,
      equity,
      unrealizedPnl: unrealized,
      startingBalance: account.startingBalance,
      realizedPnl: account.realizedPnl,
      dailyPnl: account.dailyPnl,
      weeklyPnl: account.weeklyPnl,
      pnlPct: round(((equity - starting) / starting) * 100),
      totalTrades: total,
      wins: account.wins,
      losses: account.losses,
      winRate,
      avgWin: winning.length ? round(winning.reduce((a, b) => a + b, 0) / winning.length) : 0,
      avgLoss: losing.length ? round(losing.reduce((a, b) => a + b, 0) / losing.length) : 0,
      consecutiveLosses: account.consecutiveLosses,
      openPositions: open.length,
      riskMetrics: calculateTradeMetrics(history, account.startingBalance),
    };
  }

  // Percentages the checklist's kill switches read. Losses are reported as
  // positive numbers because the limits are expressed as "max loss".
  getRiskState() {
    const account = this.getAccount();
    const open = this.getOpenPositions();
    const starting = account.startingBalance || 1;
    const openRisk = open.reduce((sum, p) => sum + (Number(p.riskUsd) || 0), 0);

    return {
      openPositions: open.length,
      totalRiskPct: round((openRisk / starting) * 100),
      dailyLossPct: account.dailyPnl < 0 ? round((-account.dailyPnl / starting) * 100) : 0,
      weeklyLossPct: account.weeklyPnl < 0 ? round((-account.weeklyPnl / starting) * 100) : 0,
      consecutiveLosses: account.consecutiveLosses,
    };
  }

  reset() {
    const account = this.newAccount();
    this.savePositions([]);
    this.save(this.historyFile, []);
    this.save(this.accountFile, account);
    return account;
  }
}

module.exports = { PaperTradingService, DUST_SIZE };
