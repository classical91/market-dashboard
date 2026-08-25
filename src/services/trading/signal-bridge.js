"use strict";

// The bridge from the Signal Bot's confluence transitions into the Trading Lab.
//
// The Signal Bot already detects the only moment worth acting on — a symbol
// flipping FLAT -> LONG/SHORT on a *closed* candle — and it runs on a timer
// whether or not anyone has the dashboard open. That makes it the natural
// replacement for the TradingView alert webhooks we no longer have a
// subscription for.
//
// Two deliberate safety properties:
//
//   1. The default is a dry run: every transition is scored through the full
//      checklist -> edge gate -> risk sizing pipeline and logged.
//   2. Signal Bot has no registered strategy identity. Enabling its paper flag
//      records an explicit attribution refusal instead of mutating a persistent
//      strategy ledger. There is no live order code reachable from here.
//
// It also marks open paper positions to market on every bot interval, so stops
// and take-profits resolve on a schedule rather than only when someone loads
// the Trading Lab page.

const { atr } = require("../decision-engine");
const { dropUnclosedCandle } = require("../signal-screener");
const { replayOrderForPositions } = require("./replay-order");
const { listStrategyAccounts } = require("./strategy-accounts");
const { signalBridgeMayManage } = require("./execution-owner");

const ENTRY_TRANSITIONS = new Set(["LONG", "SHORT"]);
const DEFAULT_MARK_INTERVAL = "4h";

function candleCloseTime(candle) {
  const value = candle && (candle.closeTime ?? candle.openTime ?? candle.time);
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positionInterval(pos) {
  const source = String((pos && pos.signalSource) || "");
  const match = source.match(/^signal-bot:(.+)$/);
  return match ? match[1] : DEFAULT_MARK_INTERVAL;
}

function lastMarkedTime(pos) {
  const meta = (pos && pos.meta) || {};
  const value = meta.signalBridgeLastMarkedCloseTime;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const opened = Date.parse(pos && pos.openedAt);
  return Number.isFinite(opened) ? opened : 0;
}

class SignalTradeBridge {
  constructor({
    tradingLabService,
    signalScreenerService = null,
    signalActionStore = null,
    paperTradeEnabled = false,
    autoMarkEnabled = true,
    book = "main",
    logger = console,
  }) {
    this._lab = tradingLabService;
    this._screener = signalScreenerService;
    this._actionStore = signalActionStore;
    this.paperTradeEnabled = Boolean(paperTradeEnabled);
    this.autoMarkEnabled = Boolean(autoMarkEnabled);
    this.book = String(book || "main").toLowerCase();
    this._logger = logger;
  }

  // Has work to do inside a scan cycle the bot is running anyway.
  get active() {
    return Boolean(this._lab) && (this.paperTradeEnabled || this.autoMarkEnabled);
  }

  // Justifies running the loop on its own — i.e. worth the periodic scans even
  // with Telegram switched off. Auto-marking alone does not: it is a passive
  // add-on to a cycle that is already happening, not a reason to start one.
  get requiresSchedule() {
    return Boolean(this._lab) && this.paperTradeEnabled;
  }

  // ATR for sizing, off the same cached klines the screener just scanned. A
  // failure here is not fatal: risk.js falls back to ATR_FALLBACK_PCT of price.
  async _atrFor(symbol, interval) {
    if (!this._screener || typeof this._screener.getCandles !== "function") return null;
    try {
      const candles = await this._screener.getCandles(symbol, interval);
      return atr(dropUnclosedCandle(candles));
    } catch (err) {
      this._logger.warn?.(`[SignalBridge] ATR unavailable for ${symbol} ${interval}: ${err.message}`);
      return null;
    }
  }

  // Mark every strategy account to market so SL/TP fire on schedule. Archived
  // legacy ledgers are intentionally excluded: they are historical evidence,
  // not active accounts.
  async markOpenPositions() {
    if (!this.autoMarkEnabled || !this._lab) return [];
    const marks = [];
    for (const { id } of listStrategyAccounts()) {
      const trader = this._lab.strategyLedger(id);
      if (!trader.getOpenPositions().some(signalBridgeMayManage)) continue;
      try {
        const events = await this._markBookWithCandles(trader);
        for (const event of events) {
          this._logger.log(`[SignalBridge] ${id}: ${event.type} on ${event.symbol} (${event.realized})`);
        }
        marks.push({ strategyId: id, events });
      } catch (err) {
        this._logger.error(`[SignalBridge] Marking ${id} failed: ${err.message}`);
      }
    }
    return marks;
  }

  async _markBookWithCandles(trader) {
    const bridgePositions = trader.getOpenPositions().filter(signalBridgeMayManage);
    if (!bridgePositions.length) return [];
    if (!this._screener || typeof this._screener.getCandles !== "function") {
      return trader.updatePositions(null, { positionIds: bridgePositions.map((position) => position.id) });
    }

    const groups = new Map();
    for (const pos of bridgePositions) {
      const interval = positionInterval(pos);
      const key = `${pos.symbol}:${interval}`;
      const since = lastMarkedTime(pos);
      const existing = groups.get(key);
      groups.set(key, {
        symbol: pos.symbol,
        interval,
        since: existing ? Math.min(existing.since, since) : since,
        positionIds: [...(existing?.positionIds || []), pos.id],
      });
    }

    const events = [];
    for (const group of groups.values()) {
      events.push(...(await this._markGroup(trader, group)));
    }
    return events;
  }

  // One symbol's replay. Every pass is scoped to `only: [symbol]` so a symbol
  // is only ever marked against its own bars — and a fallback for one symbol
  // cannot re-mark another that has already been replayed, nor discard the
  // events that replay produced.
  async _markGroup(trader, group) {
    const only = [group.symbol];
    const positionIds = group.positionIds;
    const tickerFallback = (message) => {
      this._logger.warn?.(`[SignalBridge] ${message} for ${group.symbol} ${group.interval}`);
      return trader.updatePositions(null, { only, positionIds });
    };

    let candles;
    try {
      candles = await this._screener.getCandles(group.symbol, group.interval);
    } catch (err) {
      return tickerFallback(`Candle marking unavailable (${err.message})`);
    }

    if (!Array.isArray(candles) || !candles.length) return tickerFallback("No candles available");

    const closedAll = dropUnclosedCandle(candles);
    if (!closedAll.length) return tickerFallback("No closed candles available");

    const closed = closedAll
      .filter((c) => candleCloseTime(c) > group.since)
      .sort((a, b) => candleCloseTime(a) - candleCloseTime(b));
    // Already marked through the latest close: waiting for the next bar is the
    // point of bar-based fills, so this is up to date, not stale.
    if (!closed.length) return [];

    const events = [];
    for (const candle of closed) {
      const symbolPositions = trader
        .getOpenPositions()
        .filter((p) => p.symbol === group.symbol && positionIds.includes(p.id));
      if (!symbolPositions.length) break;
      const ordering = replayOrderForPositions(symbolPositions, candle);
      for (const price of ordering.prices) {
        events.push(...(await trader.updatePositions({ [group.symbol]: price }, { only, positionIds })));
      }
      this._stampLastMarked(trader, group.symbol, group.interval, candleCloseTime(candle), positionIds);
    }
    return events;
  }

  _stampLastMarked(trader, symbol, interval, closeTime, positionIds) {
    const positions = trader.getPositions();
    const owned = new Set(positionIds);
    let changed = false;
    for (const pos of positions) {
      if (pos.status !== "open" || pos.symbol !== symbol || !owned.has(pos.id) || positionInterval(pos) !== interval) continue;
      pos.meta = { ...(pos.meta || {}), signalBridgeLastMarkedCloseTime: closeTime };
      changed = true;
    }
    if (changed) trader.savePositions(positions);
  }

  /**
   * Score every FLAT -> LONG/SHORT transition through the Trading Lab, and
   * open a paper position when paper trading is enabled and all three gates
   * (checklist, edge gate, risk sizing) agree.
   *
   * Returns one action per entry transition, whatever the outcome, so the
   * caller and the tests can see why nothing was opened.
   */
  async handleTransitions(transitions = []) {
    if (!this._lab) return [];

    const entries = transitions.filter((t) => t && t.from === "FLAT" && ENTRY_TRANSITIONS.has(t.to));
    if (!entries.length) return [];

    const states = new Map();
    const actions = [];

    for (const transition of entries) {
      const { symbol, interval, to: direction } = transition;
      const entryPrice = Number(transition.price);

      if (!(entryPrice > 0)) {
        actions.push(this._record({ transition, status: "skipped", reason: "No price on the transition" }));
        continue;
      }

      // Scoring one symbol must never cost the audit trail of the others. An
      // evaluate() throw used to abandon the whole batch mid-loop: the actions
      // already recorded were dropped from the return value even though the
      // store had them, and the symbol that threw got no record at all. A
      // failure is an outcome, so it is recorded like every other one.
      let assessment;
      try {
        if (!states.has(interval)) states.set(interval, await this._lab.stateForInterval(interval));
        const input = {
          book: this.book,
          symbol,
          direction,
          entryPrice,
          atr: await this._atrFor(symbol, interval),
          state: states.get(interval),
          strategy: `signal-bot:${interval}`,
        };

        // The Signal Bot has no registered strategy identity. It can still be
        // scored in the process-local analysis ledger, but it may never be
        // persisted into a strategy account or an archived legacy ledger.
        assessment = this._lab.evaluate(input);
      } catch (err) {
        actions.push(
          this._record({
            transition,
            status: "failed",
            reason: `Scoring failed: ${err.message}`,
          }),
        );
        continue;
      }

      // Dry run (the default): score it, log the verdict, open nothing.
      if (!this.paperTradeEnabled) {
        actions.push(
          this._record({
            transition,
            status: "dry-run",
            reason: assessment.trade.ok ? "Would open (paper trading disabled)" : assessment.trade.reason,
            assessment,
          }),
        );
        continue;
      }

      actions.push(
        this._record({
          transition,
          status: "blocked",
          reason: "Signal Bot has no registered strategy identity; persistent execution refused",
          assessment,
        }),
      );
    }

    return actions;
  }

  _record({ transition, status, reason, assessment = null, opened = null }) {
    const action = {
      timestamp: new Date().toISOString(),
      source: "signal-bot",
      symbol: transition.symbol,
      interval: transition.interval,
      direction: transition.to,
      book: "UNATTRIBUTED",
      status,
      reason,
      entryPrice: Number(transition.price) || null,
      decision: assessment ? assessment.decision : null,
      confidenceScore: assessment ? assessment.checklist.confidenceScore : null,
      sizeMultiplier: assessment ? assessment.sizeMultiplier : null,
      // Attribution, recorded for reading back — the edge gate's grouping key
      // and the regime the setup was scored in. Neither is an input to any
      // decision above; both are what makes a row in the log answer "why" on
      // its own, without re-running the scan that produced it.
      strategy: `signal-bot:${transition.interval}`,
      regime: assessment && assessment.state ? assessment.state.regime : null,
      opened,
    };
    let stored = action;
    if (this._actionStore && typeof this._actionStore.record === "function") {
      try {
        stored = this._actionStore.record(action) || action;
      } catch (err) {
        this._logger.error?.(`[SignalBridge] Failed to persist action: ${err.message}`);
      }
    }
    this._logger.log(
      `[SignalBridge] ${status.toUpperCase()} ${transition.symbol} ${transition.to} ${transition.interval}: ${reason}`,
    );
    return stored;
  }
}

module.exports = { SignalTradeBridge };
